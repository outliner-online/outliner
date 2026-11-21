"""Fail-closed eligibility for recurring, current test-work duration evidence."""

from __future__ import annotations

import base64
import itertools
import re
from urllib.parse import quote

import yaml


def native_tests(log: str, measurement: str) -> tuple[float, int] | None:
    """Use native test timings, never command/harness or job elapsed time.

    Only successful, retry-free summaries with multiple independently named files
    are supported. Unknown reporter formats stay diagnostic.
    """
    log = re.sub(r"\x1b\[[0-9;]*m", "", log)
    log = re.sub(r"(?m)^\d{4}-\d\d-\d\dT[0-9:.]+Z\s*", "", log)
    if measurement == "vitest":
        summaries = re.findall(r"(?m)^\s*Test Files\s+(\d+) passed \((\d+)\)\s*$", log)
        tests = re.findall(r"(?m)^\s*Tests\s+(\d+) passed \((\d+)\)\s*$", log)
        durations = re.findall(r"Duration\s+[^\n]*\btests\s+([\d.]+)(ms|s)\b", log)
        if not summaries or len(summaries) != len(durations) or len(tests) != len(summaries) or len(re.findall(r"(?m)^\s*Test Files\s+", log)) != len(summaries):
            return None
        if any(a != b for a, b in [*summaries, *tests]) or re.search(r"(?:\(retry x\d+\)|retry #\d+|\bretried\b)", log, re.I):
            return None
        independent = [(int(summary[0]), float(value) / (1000 if unit == "ms" else 1))
                       for summary, (value, unit) in zip(summaries, durations) if int(summary[0]) >= 2]
        return (sum(seconds for _, seconds in independent), sum(files for files, _ in independent)) if independent else None
    if measurement == "playwright":
        # The list reporter prints one completed result per native test. Require
        # one final passing summary, no retries/failures, and distinct spec files.
        if len(re.findall(r"\b\d+ passed \(", log)) != 1 or re.search(r"(?:\b\d+ (?:failed|flaky|skipped|did not run)\b|retry #\d+)", log, re.I):
            return None
        rows = re.findall(r"[✓✔]\s+\d+\s+\[[^\]]+\]\s+[^\n]*?([^\s/]+\.spec\.[cm]?[jt]s):\d+:\d+[^\n]*?\(([\d.]+)(ms|s|m)\)", log)
        passed = re.search(r"\b(\d+) passed \(", log)
        if passed is None or len(rows) != int(passed[1]) or len({file for file, _, _ in rows}) < 2:
            return None
        return sum(float(value) * {"ms": .001, "s": 1, "m": 60}[unit] for _, value, unit in rows), len({file for file, _, _ in rows})
    return None


class CurrentSource:
    """Verify GitHub's default-branch source, current job variants and entrypoints."""

    def __init__(self, client, call, repository: str, request=None):
        self.client, self.call = client, call
        self.request = request or (lambda client, method, path: client.request(method, path))
        metadata = call(client, "GET", "")
        if metadata.get("full_name") != repository:
            raise ValueError("Repository identity could not be verified")
        self.repository = repository
        self.branch = metadata["default_branch"]
        self.sha = call(client, "GET", f"branches/{quote(self.branch, safe='')}")["commit"]["sha"]
        self.cache = {}
        self.inventories = {}

    def content(self, path: str, ref: str) -> bytes | None:
        key = path, ref
        if key not in self.cache:
            response = self.request(self.client, "GET", f"contents/{quote(path, safe='/')}?ref={quote(ref, safe='')}")
            if response.status == 404:
                self.cache[key] = None
            elif response.status != 200:
                raise RuntimeError(f"Cannot verify workflow source: HTTP {response.status}")
            else:
                value = response.data
                if value.get("encoding") != "base64" or value.get("type") != "file":
                    raise ValueError("Expected a versioned source file")
                self.cache[key] = base64.b64decode(value["content"], validate=False)
        return self.cache[key]

    def inventory(self, path: str, prefix: str = "", seen: tuple[str, ...] = ()) -> dict[str, tuple[set[str], tuple[str, ...]]]:
        if path in seen:
            raise ValueError("Recursive reusable workflow")
        data = self.content(path, self.sha)
        if data is None:
            return {}
        document = yaml.safe_load(data)
        result = {}
        for key, job in document.get("jobs", {}).items():
            uses = job.get("uses", "")
            if uses.startswith("./.github/workflows/"):
                result.update(self.inventory(uses[2:], prefix + key + " / ", (*seen, path)))
                continue
            matrix = job.get("strategy", {}).get("matrix", {})
            if not isinstance(matrix, dict) or "include" in matrix or "exclude" in matrix:
                continue  # Dynamic or conditional inventories need an explicit adapter.
            axes = list(matrix)
            if any(not isinstance(matrix[axis], list) for axis in axes):
                continue
            variants = itertools.product(*(matrix[axis] for axis in axes)) if axes else [()]
            for values in variants:
                name = job.get("name", key + (" (" + ", ".join(map(str, values)) + ")" if values else ""))
                for axis, value in zip(axes, values):
                    name = re.sub(r"\$\{\{\s*matrix\." + re.escape(axis) + r"\s*\}\}", lambda _: str(value), name)
                if "${{" in name:
                    continue
                sources = {path, *seen}
                step_names = []
                for step in job.get("steps", []):
                    step_name = step.get("name", "")
                    for axis, value in zip(axes, values):
                        step_name = re.sub(r"\$\{\{\s*matrix\." + re.escape(axis) + r"\s*\}\}", lambda _: str(value), step_name)
                    step_names.append(step_name)
                result[prefix + name] = sources, tuple(step_names)
        return result

    def reason(self, workflow, family, run: dict, job_name: str) -> str | None:
        if run.get("head_branch") != self.branch or run.get("event") not in {"push", "schedule", "workflow_dispatch"}:
            return "not a default-branch production execution"
        if run.get("head_repository", {}).get("full_name") != self.repository or run.get("repository", {}).get("full_name") != self.repository:
            return "unverified run repository"
        if workflow.path not in self.inventories:
            state = self.call(self.client, "GET", f"actions/workflows/{quote(workflow.path.rsplit('/', 1)[-1])}")
            self.inventories[workflow.path] = self.inventory(workflow.path) if state.get("state") == "active" and state.get("path") == workflow.path else {}
        inventory = self.inventories[workflow.path]
        if job_name not in inventory:
            return "job/variant is absent from the current active workflow"
        if family.measurement not in {"vitest", "playwright"}:
            return "no supported native test measurement for this entrypoint"
        paths, steps = inventory[job_name]
        if not any(re.search(family.test_step_pattern, step) for step in steps):
            return "configured test step is absent from the current job entrypoint"
        paths = set(family.source_paths) | paths
        for path in paths:
            current = self.content(path, self.sha)
            if current is None or self.content(path, run.get("head_sha", "")) != current:
                return "workflow/test entrypoint differs from current default branch"
        return None
