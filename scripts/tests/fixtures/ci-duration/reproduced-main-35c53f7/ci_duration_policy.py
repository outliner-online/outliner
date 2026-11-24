"""Verify current workflow provenance and separated test execution contracts."""

from __future__ import annotations

import base64
import itertools
import re
from urllib.parse import quote

import yaml



class CurrentSource:
    """Verify GitHub's default-branch source, current job variants and entrypoints."""

    def __init__(self, client, call, repository: str, request=None):
        self.client, self.call = client, call
        self.request = request or (lambda client, method, path: client.request(method, path))
        metadata = call(client, "GET", "")
        if metadata.get("full_name") != repository:
            raise ValueError("Repository identity could not be verified")
        self.repository = repository
        self.repository_id = metadata.get("id")
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
        if run.get("event") == "pull_request":
            # GitHub's run payload provides the PR/base repository identities.
            # Its head SHA can move after a run; source is verified at this run's
            # immutable head_sha below rather than trusting the latest PR head.
            refs = run.get("pull_requests", [])
            if not self.repository_id or not any(
                ref.get("base", {}).get("ref") == self.branch
                and ref.get("base", {}).get("repo", {}).get("id") == self.repository_id
                and ref.get("head", {}).get("repo", {}).get("id") == self.repository_id
                and ref.get("head", {}).get("ref") == run.get("head_branch")
                for ref in refs
            ):
                return "unverified default-branch PR workflow provenance"
        elif run.get("head_branch") != self.branch or run.get("event") not in {"push", "schedule", "workflow_dispatch"}:
            return "not a default-branch or verified PR test execution"
        if run.get("head_repository", {}).get("full_name") != self.repository or run.get("repository", {}).get("full_name") != self.repository:
            return "unverified run repository"
        if workflow.path not in self.inventories:
            state = self.call(self.client, "GET", f"actions/workflows/{quote(workflow.path.rsplit('/', 1)[-1])}")
            self.inventories[workflow.path] = self.inventory(workflow.path) if state.get("state") == "active" and state.get("path") == workflow.path else {}
        inventory = self.inventories[workflow.path]
        if job_name not in inventory:
            return "job/variant is absent from the current active workflow"
        if family.diagnostic_job_pattern and re.fullmatch(family.diagnostic_job_pattern, job_name):
            return "current variant mixes build/preparation with test execution"
        if family.measurement != "test-step":
            return "no separated test execution contract for this entrypoint"
        paths, steps = inventory[job_name]
        if not any(re.search(family.test_step_pattern, step) for step in steps):
            return "configured test step is absent from the current job entrypoint"
        paths = set(family.source_paths) | paths
        for path in paths:
            current = self.content(path, self.sha)
            if current is None:
                return "declared execution source is absent from current default branch"
            if self.content(path, run.get("head_sha", "")) != current:
                return "workflow/test entrypoint differs from current default branch"
        return None

    def execution_step_names(self, workflow, family, job_name):
        return {name for name in self.inventories[workflow.path][job_name][1]
                if re.search(family.test_step_pattern, name)}
