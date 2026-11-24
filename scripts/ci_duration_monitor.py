"""Daily, read-only-by-default CI duration evidence and review submissions.

The transport adapter lives beside this file so repositories can retain their
existing GitHub request boundary while sharing this monitor and its tests.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.client import IncompleteRead
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from string import Template
from typing import Callable, Protocol, cast
from urllib.parse import quote, urlencode

from loguru import logger

try:
    from .ci_cancellation_diagnostics import CancellationDiagnostics
    from .ci_duration_policy import CurrentSource
    from .ci_duration_github import ReadBudgetExceeded, ScanClient
except ImportError:
    from ci_cancellation_diagnostics import CancellationDiagnostics
    from ci_duration_policy import CurrentSource
    from ci_duration_github import ReadBudgetExceeded, ScanClient

MANAGED_LABEL = "ci-duration-monitor"
READY_LABEL = "review-ready"
THRESHOLD_SECONDS = 600
LOG_FORMAT = "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level}</level> | {file.name}:{function}:{line} | {message}"


class Response(Protocol):
    @property
    def status(self) -> int: ...

    @property
    def data(self) -> object: ...


class Client(Protocol):
    def request(self, method: str, path: str, payload: dict[str, object] | None = None) -> Response: ...


@dataclass(frozen=True)
class Family:
    key: str
    name: str
    job_pattern: str
    test_step_pattern: str
    source_paths: tuple[str, ...]
    guidance: str
    measurement: str = "diagnostic"
    diagnostic_job_pattern: str = ""


@dataclass(frozen=True)
class Workflow:
    path: str
    families: tuple[Family, ...]


@dataclass(frozen=True)
class Step:
    name: str
    seconds: float


@dataclass(frozen=True)
class Sample:
    run_id: int
    attempt: int
    job_id: int
    job_name: str
    conclusion: str
    head_sha: str
    completed_at: str
    runner_seconds: float
    queue_seconds: float | None
    test_step_seconds: float | None
    family_jobs: int
    fastest_job_seconds: float
    steps: tuple[Step, ...]
    qualifying_test_step_seconds: float | None = None
    diagnostic_reason: str | None = None

    @property
    def marker(self) -> str:
        return f"<!-- ci-duration-evidence:v1:{self.run_id}:{self.attempt}:{self.job_id} -->"


@dataclass
class Observation:
    workflow: Workflow
    family: Family
    samples: list[Sample]


@dataclass
class ManagedIssue:
    number: int
    state: str
    closed_at: str | None
    body: str
    labels: tuple[str, ...]
    comments: list[str]


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("GitHub/configuration returned a non-object value")
    return cast(dict[str, object], value)


def _objects(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise ValueError("GitHub/configuration returned a non-list value")
    return [_object(item) for item in value]


def _text(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("Required text is missing")
    return value


def _number(value: object) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError("Required positive integer is missing")
    return value


def _time(value: object) -> datetime:
    parsed = datetime.fromisoformat(_text(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("GitHub timestamp has no timezone")
    return parsed


def _seconds(start: object, finish: object) -> float | None:
    if not start or not finish:
        return None
    value = (_time(finish) - _time(start)).total_seconds()
    if value < 0:
        logger.warning("GitHub returned an out-of-order interval ({} to {}); duration is unknown", start, finish)
        return None
    return round(value, 3)


def _request(client: Client, method: str, path: str, payload: dict[str, object] | None = None) -> Response:
    attempts = 3 if method == "GET" else 1
    for attempt in range(attempts):
        try:
            response = client.request(method, path, payload)
        except (OSError, IncompleteRead):
            if attempt + 1 == attempts:
                raise
            logger.warning("GitHub GET {} transport unavailable; retrying read ({}/3)", path.split("?")[0], attempt + 2)
        else:
            if method != "GET" or response.status not in {502, 503, 504} or attempt + 1 == attempts:
                return response
            logger.warning("GitHub GET {} returned {}; retrying read ({}/3)", path.split("?")[0], response.status, attempt + 2)
        if isinstance(client, ScanClient) and client.remaining() <= attempt + 1:
            raise ReadBudgetExceeded("GitHub read budget cannot accommodate another retry")
        time.sleep(attempt + 1)
    raise AssertionError("Request retry loop has no terminal outcome")


def _call(client: Client, method: str, path: str, payload: dict[str, object] | None = None, expected: int = 200) -> object:
    response = _request(client, method, path, payload)
    if response.status != expected:
        # Do not include request credentials or an arbitrary response body.
        raise RuntimeError(f"GitHub {method} {path.split('?')[0]} returned {response.status}; expected {expected}")
    return response.data


def _pages(client: Client, path: str, field: str | None = None, *, run_search: bool = False) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    page = 1
    total: int | None = None
    while True:
        separator = "&" if "?" in path else "?"
        value = _call(client, "GET", f"{path}{separator}per_page=100&page={page}")
        if field is not None:
            container = _object(value)
            count = container.get("total_count")
            if type(count) is not int or count < 0:
                raise ValueError("Paginated GitHub response has no valid total_count")
            if total is not None and count != total:
                raise RuntimeError("GitHub collection changed during pagination; retry the monitor")
            total = count
            if run_search and total > 1000:
                raise RuntimeError("Workflow search exceeds GitHub's 1,000-result limit; use a shorter lookback")
            batch = _objects(container.get(field))
        else:
            batch = _objects(value)
        result.extend(batch)
        if len(batch) < 100 or (total is not None and len(result) >= total):
            if total is not None and len(result) != total:
                raise RuntimeError("GitHub pagination ended before the declared collection was complete")
            return result
        page += 1


def read_config(path: Path) -> tuple[Workflow, ...]:
    raw = _object(json.loads(path.read_text(encoding="utf-8")))
    workflows = []
    for item in _objects(raw.get("workflows")):
        workflow_path = _text(item.get("path"))
        if re.fullmatch(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml", workflow_path) is None:
            raise ValueError("Invalid workflow configuration path")
        families = []
        for entry in _objects(item.get("families")):
            sources = entry.get("source_paths")
            if not isinstance(sources, list) or not sources:
                raise ValueError("Each family needs verified implementation source paths")
            family = Family(
                _text(entry.get("key")),
                _text(entry.get("name")),
                _text(entry.get("job_pattern")),
                _text(entry.get("test_step_pattern")),
                tuple(_text(source) for source in sources),
                _text(entry.get("guidance")),
                _text(entry.get("measurement", "diagnostic")),
                str(entry.get("diagnostic_job_pattern", "")),
            )
            if family.measurement not in {"test-step", "diagnostic"}:
                raise ValueError("Unsupported test execution policy")
            re.compile(family.job_pattern)
            re.compile(family.test_step_pattern)
            re.compile(family.diagnostic_job_pattern)
            families.append(family)
        if len({family.key for family in families}) != len(families):
            raise ValueError("Duplicate family key in workflow")
        workflows.append(Workflow(workflow_path, tuple(families)))
    if not workflows or len({workflow.path for workflow in workflows}) != len(workflows):
        raise ValueError("Workflow configuration must be non-empty and unique")
    return tuple(workflows)


def collect(client: Client, workflows: tuple[Workflow, ...], cutoff: datetime, source: CurrentSource, diagnostics: CancellationDiagnostics | None = None, *, required_read_workers: int = 8) -> tuple[list[Observation], list[dict[str, object]]]:
    observations = [Observation(workflow, family, []) for workflow in workflows for family in workflow.families]
    totals: list[dict[str, object]] = []
    for workflow in workflows:
        query = urlencode({"created": f">={cutoff.isoformat()}", "status": "completed"})
        runs = _pages(client, f"actions/workflows/{quote(workflow.path.rsplit('/', 1)[-1])}/runs?{query}", "workflow_runs", run_search=True)
        attempts = []
        for run in runs:
            run_id, latest = _number(run.get("id")), _number(run.get("run_attempt"))
            if _text(run.get("path")).split("@", 1)[0] != workflow.path:
                raise ValueError("Run does not belong to the configured workflow")
            for attempt in range(1, latest + 1):
                attempt_run = run if attempt == latest else _object(_call(client, "GET", f"actions/runs/{run_id}/attempts/{attempt}"))
                if attempt_run.get("id") != run_id or attempt_run.get("run_attempt") != attempt:
                    raise ValueError("Attempt response belongs to a different run or attempt")
                if attempt_run.get("status") != "completed":
                    continue
                attempts.append((run_id, attempt, attempt_run))
        # Job pages dominate the native workload (430 successful reads in the
        # retained 2026-11-24 scan). They are independent immutable attempt
        # collections, so overlap only these reads and process their results in
        # discovery order to retain deterministic duplicate and policy logic.
        def fetch_jobs(item):
            run_id, attempt, _ = item
            return _pages(client, f"actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs")

        with ThreadPoolExecutor(max_workers=required_read_workers) as executor:
            job_sets = executor.map(fetch_jobs, attempts)
            for (run_id, attempt, attempt_run), jobs in zip(attempts, job_sets):
                for job in jobs:
                    if job.get("run_id", run_id) != run_id or job.get("run_attempt", attempt) != attempt:
                        raise ValueError("Job belongs to a different run or attempt")
                if diagnostics is not None:
                    diagnostics.observe(workflow.path, attempt_run, jobs, runs)
                candidates = []
                for job in jobs:
                    if job.get("run_attempt", attempt) != attempt:
                        raise ValueError("Job belongs to a different run attempt")
                    if job.get("status") != "completed" or job.get("conclusion") not in {"success", "failure", "timed_out"}:
                        continue
                    duration = _seconds(job.get("started_at"), job.get("completed_at"))
                    if duration is None:
                        logger.warning("Job {} has incomplete timestamps; its duration is unknown", job.get("id"))
                        continue
                    if _time(job["completed_at"]) < cutoff:
                        continue
                    candidates.append((job, duration))
                for job, _duration in candidates:
                    name = _text(job.get("name"))
                    matched = [family for family in workflow.families if re.fullmatch(family.job_pattern, name)]
                    if len(matched) > 1:
                        raise ValueError("Job matches multiple configured families")
                    if not matched and not any(item.workflow.path == workflow.path and item.family.key == f"job:{name}" for item in observations):
                        fallback = Family(
                            f"job:{name}",
                            name,
                            re.escape(name),
                            r"(?i)^(?:run|execute).*(?:test|pytest|playwright)",
                            (workflow.path,),
                            "Start at the linked workflow's exact job and follow its run/uses entry points. "
                            "This job has no curated split plan: inspect current code and timing artifacts before choosing "
                            "independent partitions or a setup optimization. Preserve its current dependencies and "
                            "required result propagation, and add regression coverage at the actual runner boundary.",
                        )
                        observations.append(Observation(workflow, fallback, []))
                for observation in observations:
                    if observation.workflow.path != workflow.path:
                        continue
                    family = observation.family
                    selected = [(job, duration) for job, duration in candidates if re.fullmatch(family.job_pattern, _text(job.get("name")))]
                    if not selected:
                        continue
                    for job, duration in selected:
                        steps = []
                        test_seconds = 0.0
                        matched_test_steps = 0
                        unknown_test_steps = False
                        for step in _objects(job.get("steps", [])):
                            seconds = _seconds(step.get("started_at"), step.get("completed_at"))
                            name = _text(step.get("name"))
                            if re.search(family.test_step_pattern, name):
                                matched_test_steps += 1
                                if step.get("status") != "completed" or seconds is None:
                                    unknown_test_steps = True
                                else:
                                    test_seconds += seconds
                            if step.get("status") != "completed" or seconds is None:
                                continue
                            steps.append(Step(name, seconds))
                        reason = source.reason(workflow, family, attempt_run, _text(job.get("name")))
                        qualifying_seconds = None
                        if reason is None:
                            if job.get("conclusion") != "success" or unknown_test_steps or not matched_test_steps:
                                reason = "test execution is incomplete or unsuccessful"
                            elif duration < THRESHOLD_SECONDS:
                                reason = "job execution is below 600 seconds"
                            elif test_seconds < THRESHOLD_SECONDS:
                                reason = "separated test execution is below 600 seconds"
                            elif test_seconds < duration / 2:
                                reason = "test execution does not dominate the job"
                            else:
                                allowed = source.execution_step_names(workflow, family, _text(job.get("name")))
                                measured = [step for step in _objects(job.get("steps", [])) if re.search(family.test_step_pattern, _text(step.get("name")))]
                                if any(step.get("name") not in allowed or step.get("conclusion") != "success" for step in measured):
                                    reason = "test step does not match the current successful execution contract"
                                elif any(_time(step["started_at"]) < _time(job["started_at"]) or _time(step["completed_at"]) > _time(job["completed_at"]) for step in measured):
                                    reason = "test step interval is outside the job execution"
                                else:
                                    qualifying_seconds = round(test_seconds, 3)
                        observation.samples.append(
                            Sample(
                                run_id,
                                attempt,
                                _number(job.get("id")),
                                _text(job.get("name")),
                                _text(job.get("conclusion")),
                                _text(attempt_run.get("head_sha")),
                                _text(job.get("completed_at")),
                                duration,
                                _seconds(job.get("created_at"), job.get("started_at")),
                                round(test_seconds, 3) if matched_test_steps and not unknown_test_steps else None,
                                len(selected),
                                min(value for _, value in selected),
                                tuple(sorted(steps, key=lambda item: item.seconds, reverse=True)[:3]),
                                qualifying_seconds,
                                reason,
                            )
                        )
                completed = [job.get("completed_at") for job in jobs if job.get("completed_at")]
                elapsed = _seconds(attempt_run.get("run_started_at"), max(completed, key=_time)) if completed else None
                if elapsed is not None and elapsed >= THRESHOLD_SECONDS:
                    totals.append({"workflow": workflow.path, "run_id": run_id, "attempt": attempt, "elapsed_seconds": elapsed, "long_job": any(duration >= THRESHOLD_SECONDS for _, duration in candidates)})
    for observation in observations:
        observation.samples.sort(key=lambda sample: (_time(sample.completed_at), sample.run_id, sample.attempt))
    return observations, totals


def _key(repository: str, observation: Observation) -> str:
    value = f"{repository}\0{observation.workflow.path}\0{observation.family.key}"
    return f"<!-- ci-duration-monitor:v1:{hashlib.sha256(value.encode()).hexdigest()[:24]} -->"


def _safe(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").replace("|", "\\|").replace("`", "'").replace("<", "&lt;").replace(">", "&gt;")


def evidence(repository: str, observation: Observation, trigger: Sample) -> str:
    samples = observation.samples[-5:]
    if trigger not in samples:
        samples = [trigger, *samples]
    lines = [
        "## Observed CI evidence",
        "",
        "Durations come from GitHub job/step timestamps, excluding queue time. Qualification requires the exact successful, separated test execution step to reach 600 seconds and dominate job execution; test retries remain part of that executed step.",
        "",
        "| Run / attempt | Job | Result | Job seconds | Queue seconds | Test-command seconds | Family min/max seconds | Qualifying test-step seconds |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for sample in samples:
        url = f"https://github.com/{repository}/actions/runs/{sample.run_id}/job/{sample.job_id}"
        queue = "unknown" if sample.queue_seconds is None else f"{sample.queue_seconds:g}"
        test_time = "unknown" if sample.test_step_seconds is None else f"{sample.test_step_seconds:g}"
        lines.append(f"| [{sample.run_id} / {sample.attempt}]({url}) | {_safe(sample.job_name)} | {sample.conclusion} | {sample.runner_seconds:g} | {queue} | {test_time} | {sample.fastest_job_seconds:g} / {sample.runner_seconds:g} ({sample.family_jobs} jobs) | {sample.qualifying_test_step_seconds if sample.qualifying_test_step_seconds is not None else 'unknown'} |")
    lines += ["", f"Threshold: **{THRESHOLD_SECONDS} seconds or more**. Qualifying attempt completed: `{trigger.completed_at}`; GitHub run head SHA: `{trigger.head_sha}` (the workflow may check out a different merge/head revision).", "", "Longest steps in the qualifying job:"]
    lines += [f"- {_safe(step.name)}: {step.seconds:g} seconds." for step in trigger.steps]
    lines += ["", trigger.marker]
    return "\n".join(lines)


def issue_body(repository: str, observation: Observation, trigger: Sample, source_ref: str) -> str:
    family = observation.family
    test_dominated = trigger.test_step_seconds is not None and trigger.test_step_seconds >= trigger.runner_seconds / 2
    recommendation = "Investigate splitting or rebalancing the complete test selection" if test_dominated else "Investigate the dominant setup/runtime steps before choosing a split"
    source_links = "\n".join(f"- [{path}](https://github.com/{repository}/blob/{quote(source_ref, safe='')}/{quote(path, safe='/')})" for path in family.source_paths)
    template_path = Path(__file__).resolve().parents[1] / ".github" / "ci-duration-issue.md"
    return Template(template_path.read_text(encoding="utf-8")).substitute(
        identity=_key(repository, observation) + f"\n<!-- ci-duration-policy:v3:separated-test-step:{source_ref} -->",
        family_name=_safe(family.name),
        threshold=THRESHOLD_SECONDS,
        workflow_path=observation.workflow.path,
        recommendation=recommendation,
        evidence=evidence(repository, observation, trigger),
        source_ref=_safe(source_ref),
        source_links=source_links,
        guidance=family.guidance,
    )


def _issues(client: Client) -> list[ManagedIssue]:
    issues = []
    for item in _pages(client, f"issues?state=all&labels={quote(MANAGED_LABEL)}"):
        if "pull_request" in item:
            continue
        number = _number(item.get("number"))
        comments = [str(comment.get("body") or "") for comment in _pages(client, f"issues/{number}/comments")]
        labels = tuple(_text(label.get("name")) for label in _objects(item.get("labels", [])))
        closed = item.get("closed_at")
        issues.append(ManagedIssue(number, _text(item.get("state")), _text(closed) if closed else None, str(item.get("body") or ""), labels, comments))
    return issues


def _submitted(client: Client, issue: ManagedIssue) -> bool:
    if READY_LABEL in issue.labels:
        return True
    return any(event.get("event") == "labeled" and _object(event.get("label", {})).get("name") == READY_LABEL for event in _pages(client, f"issues/{issue.number}/events"))


def _complete_specification(issue: ManagedIssue) -> bool:
    return all(section in issue.body for section in ("## Objective", "## Requirements", "## Acceptance Scenarios", "## Initial Implementation Prompt")) and re.search(r"^REQ-\d{3}:", issue.body, re.MULTILINE) is not None


def _prepare_labels(client: Client) -> None:
    _call(client, "GET", f"labels/{quote(READY_LABEL)}")
    response = _request(client, "GET", f"labels/{quote(MANAGED_LABEL)}")
    if response.status == 404:
        _call(client, "POST", "labels", {"name": MANAGED_LABEL, "color": "1d76db", "description": "Daily CI duration evidence; managed identity is retained in an initial comment"}, expected=201)
    elif response.status != 200:
        raise RuntimeError(f"Cannot inspect monitor label: HTTP {response.status}")


def run_monitor(client: Client, workflows: tuple[Workflow, ...], repository: str, source_ref: str, *, now: datetime, lookback_hours: int, publish: bool, diagnostics_output: Path | None = None, required_read_seconds: float = 720, optional_read_seconds: float = 30, required_read_workers: int = 8) -> dict[str, object]:
    # Twelve minutes for required reads leaves a reserve inside the existing
    # fifteen-minute job for diagnostics, normal reconciliation and teardown.
    scan = ScanClient(client, diagnostics_output, required_read_seconds, optional_read_seconds)
    try:
        report = _run_monitor(scan, workflows, repository, source_ref, now=now,
                              lookback_hours=lookback_hours, publish=publish,
                              diagnostics_output=diagnostics_output, required_read_workers=required_read_workers)
        scan.state = 'complete'
        return report
    except Exception as error:
        scan.state, scan.error = 'failed', type(error).__name__
        raise
    finally:
        scan.save()


def _run_monitor(client: ScanClient, workflows: tuple[Workflow, ...], repository: str, source_ref: str, *, now: datetime, lookback_hours: int, publish: bool, diagnostics_output: Path | None = None, required_read_workers: int = 8) -> dict[str, object]:
    source = CurrentSource(client, _call, repository, request=_request)
    cutoff = now - timedelta(hours=lookback_hours)
    diagnostics = CancellationDiagnostics(repository, now, cutoff, lambda path: _pages(client, path), defer_annotations=True)
    if diagnostics_output is not None:
        client.checkpoint = lambda: diagnostics.write(diagnostics_output)
        client.checkpoint()
    client.phase("required-collection")
    try:
        observations, workflow_totals = collect(client, workflows, cutoff, source, diagnostics, required_read_workers=required_read_workers)
        diagnostics.complete = not diagnostics.failed
    finally:
        # Preserve independent diagnostic evidence even if later issue reads or
        # publication fail. Incomplete scans are explicitly marked as such.
        if diagnostics_output is not None:
            diagnostics.write(diagnostics_output)
    source_ref = source.sha
    # Read the durable issue/comment inventory before any mutation. Unavailable pages cannot
    # silently authorize duplicate issues or readiness re-submission.
    client.phase("issue-inventory")
    managed = _issues(client)
    # Annotation absence never affects duration admission. Finish required reads
    # first, then bound this optional service enrichment independently.
    required_deadline = client.deadline
    client.deadline = min(required_deadline, time.monotonic() + client.optional_seconds)
    client.phase("optional-annotations")
    try:
        diagnostics.enrich(lambda: client.remaining() > 0)
    except Exception as error:
        diagnostics.failed = True
        diagnostics.complete = False
        logger.warning("Optional annotation enrichment unavailable ({}); continuing", type(error).__name__)
    finally:
        client.checkpoint()
        client.deadline = required_deadline
    client.phase("reconciliation")
    actions: list[dict[str, object]] = []
    prepared = False
    processed: set[int] = set()
    admission = []
    for observation in observations:
        key = _key(repository, observation)
        existing = [issue.number for issue in managed if issue.state == "open" and
                    (key in issue.body.splitlines() or any(key in comment.splitlines() for comment in issue.comments))]
        eligible = [sample for sample in observation.samples if sample.diagnostic_reason is None and sample.qualifying_test_step_seconds is not None]
        if observation.samples or existing:
            admission.append({"workflow": observation.workflow.path, "family": observation.family.key,
                              "qualifying_job_ids": list(dict.fromkeys(sample.job_id for sample in eligible)),
                              "existing_open_issues": existing,
                              "classification": "qualifies-existing" if eligible and existing else "qualifies-new" if eligible else "insufficient-evidence",
                              "diagnostic_samples": len(observation.samples) - len(eligible)})
    for observation in observations:
        slow = [sample for sample in observation.samples if sample.diagnostic_reason is None and sample.qualifying_test_step_seconds is not None and sample.runner_seconds >= THRESHOLD_SECONDS]
        if not slow:
            continue
        key = _key(repository, observation)
        matching = [issue for issue in managed if key in issue.body.splitlines() or any(key in comment.splitlines() for comment in issue.comments)]
        opened = [issue for issue in matching if issue.state == "open"]
        if len(opened) > 1:
            raise RuntimeError("Multiple open managed issues share a family identity; reconcile them before publishing")
        issue = opened[0] if opened else None
        closed = [_time(item.closed_at) for item in matching if item.state == "closed" and item.closed_at]
        if issue is None and closed:
            slow = [sample for sample in slow if _time(sample.completed_at) > max(closed)]
        if not slow:
            continue
        trigger = slow[-1]
        marker_present = issue is not None and (trigger.marker in issue.body or any(trigger.marker in comment for comment in issue.comments))
        identity_comment = issue is not None and any(key in comment.splitlines() for comment in issue.comments)
        submitted = _submitted(client, issue) if issue is not None else False
        action = {
            "workflow": observation.workflow.path,
            "family": observation.family.key,
            "run_id": trigger.run_id,
            "attempt": trigger.attempt,
            "issue": issue.number if issue else None,
            "action": "create" if issue is None else "update" if not marker_present or not identity_comment or not submitted else "unchanged",
        }
        actions.append(action)
        logger.info("{} {} / {} (run {}, attempt {})", action["action"], observation.workflow.path, observation.family.name, trigger.run_id, trigger.attempt)
        if issue is not None:
            processed.add(issue.number)
        if issue is not None and not submitted and not _complete_specification(issue):
            action["action"] = "awaiting-complete-specification"
            logger.warning("Pending managed issue {} no longer has a complete specification; not submitting", issue.number)
            continue
        if not publish or action["action"] == "unchanged":
            continue
        if not prepared:
            _prepare_labels(client)
            prepared = True
        if issue is None:
            body = issue_body(repository, observation, trigger, source_ref)
            created = _object(_call(client, "POST", "issues", {"title": f"[CI duration] Improve {observation.family.name[:190]} (>=10 minutes)", "body": body, "labels": [MANAGED_LABEL]}, expected=201))
            issue = ManagedIssue(_number(created.get("number")), "open", None, body, (MANAGED_LABEL,), [])
            managed.append(issue)
            action["issue"] = issue.number
            processed.add(issue.number)
        if not marker_present or not identity_comment:
            comment = f"{key}\n\n{evidence(repository, observation, trigger)}"
            _call(client, "POST", f"issues/{issue.number}/comments", {"body": comment}, expected=201)
            issue.comments.append(comment)
        if not submitted:
            # This is deliberately the final mutation for this submission.
            # Event history recovers ambiguous success without re-adding a
            # readiness label already consumed by reviewers.
            _call(client, "POST", f"issues/{issue.number}/labels", {"labels": [READY_LABEL]})
    for issue in managed:
        if issue.state != "open" or issue.number in processed:
            continue
        retained = "\n".join([issue.body, *issue.comments])
        keys = re.findall(r"^<!-- ci-duration-monitor:v1:[0-9a-f]{24} -->$", retained, re.MULTILINE)
        if f"<!-- ci-duration-policy:v3:separated-test-step:{source.sha} -->" not in issue.body or not keys or len(set(keys)) != 1 or _submitted(client, issue):
            continue
        if not _complete_specification(issue):
            logger.warning("Pending managed issue {} no longer has a complete specification; not submitting", issue.number)
            continue
        markers = re.findall(r"^<!-- ci-duration-evidence:v1:[0-9]+:[0-9]+:[0-9]+ -->$", retained, re.MULTILINE)
        if not markers:
            logger.warning("Pending managed issue {} has no retained observation; not submitting", issue.number)
            continue
        actions.append({"workflow": "retained submission", "family": keys[0], "issue": issue.number, "action": "recover-submission"})
        if not publish:
            continue
        if not prepared:
            _prepare_labels(client)
            prepared = True
        if not any(keys[0] in comment.splitlines() for comment in issue.comments):
            comment = f"{keys[0]}\n\nRetained CI duration submission identity and evidence. See the complete issue body.\n\n" + "\n".join(dict.fromkeys(markers))
            _call(client, "POST", f"issues/{issue.number}/comments", {"body": comment}, expected=201)
        _call(client, "POST", f"issues/{issue.number}/labels", {"labels": [READY_LABEL]})
    return {
        "repository": repository,
        "verified_default_branch": source.branch,
        "verified_source_sha": source.sha,
        "shared_setup_diagnostics": shared_setup_diagnostics(observations),
        "lookback_hours": lookback_hours,
        "run_discovery": "created_at",
        "threshold_seconds": THRESHOLD_SECONDS,
        "publish": publish,
        "actions": actions,
        "admission": admission,
        "admission_summary": {
            "qualifying_candidates": sum(len(item["qualifying_job_ids"]) for item in admission),
            "qualifying_families_existing": sum(item["classification"] == "qualifies-existing" for item in admission),
            "qualifying_families_new": sum(item["classification"] == "qualifies-new" for item in admission),
            "insufficient_families": sum(item["classification"] == "insufficient-evidence" for item in admission),
            "diagnostic_samples": sum(item["diagnostic_samples"] for item in admission),
        },
        "workflow_totals": workflow_totals,
        "cancellation_diagnostics": diagnostics.report(),
        "observations": [{"workflow": item.workflow.path, "family": item.family.key, "samples": [asdict(sample) for sample in item.samples]} for item in observations],
    }



def shared_setup_diagnostics(observations: list[Observation]) -> list[dict[str, object]]:
    """Retain recurring acquisition evidence across families without issue writes."""
    grouped: dict[str, list[dict[str, object]]] = {}
    for observation in observations:
        for sample in observation.samples:
            for step in sample.steps:
                if step.seconds < 300 or re.search(observation.family.test_step_pattern, step.name):
                    continue
                grouped.setdefault(step.name, []).append({
                    "workflow": observation.workflow.path, "family": observation.family.key,
                    "run_id": sample.run_id, "job_id": sample.job_id, "seconds": step.seconds,
                })
    return [{"step": name, "observations": rows} for name, rows in sorted(grouped.items())
            if len({row["family"] for row in rows}) >= 2 and len({row["run_id"] for row in rows}) >= 2]

def main(argv: list[str] | None = None, *, client_factory: Callable[[str, str], Client] | None = None, now: datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--config", type=Path, default=Path(".github/ci-duration-monitor.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("ci-duration-monitor-output"))
    parser.add_argument("--source-ref", default=os.environ.get("GITHUB_SHA", "main"))
    parser.add_argument("--lookback-hours", type=int, default=48)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args(argv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    logger.remove()
    logger.add(sys.stdout, format=LOG_FORMAT, colorize=True)
    logger.add(args.output_dir / "monitor.log", format=LOG_FORMAT, rotation="10 MB", retention=5)
    try:
        if not args.repository or re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository) is None:
            raise ValueError("--repository must be owner/repository")
        if args.lookback_hours <= 0:
            raise ValueError("--lookback-hours must be positive")
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN", "")
        if args.publish and not token:
            raise ValueError("Publishing requires GITHUB_TOKEN")
        if client_factory is None:
            from ci_duration_github import create_client

            client_factory = create_client
        report = run_monitor(client_factory(token, args.repository), read_config(args.config), args.repository, args.source_ref, now=now or datetime.now(timezone.utc), lookback_hours=args.lookback_hours, publish=args.publish, diagnostics_output=args.output_dir)
        (args.output_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        summary = f"# CI duration monitor\n\nMode: {'publish' if args.publish else 'dry run'}. Runs created in the last {args.lookback_hours} hours; threshold >= {THRESHOLD_SECONDS} seconds.\n\n"
        admission_summary = cast(dict[str, int], report["admission_summary"])
        summary += f"Admission before existing issue handling: {admission_summary['qualifying_candidates']} qualifying jobs; {admission_summary['qualifying_families_existing']} qualifying families with existing issues; {admission_summary['qualifying_families_new']} new qualifying families; {admission_summary['insufficient_families']} families with insufficient evidence.\n\n"
        summary += "\n".join(f"- {item['action']}: `{item['workflow']}` / `{item['family']}` (issue {item['issue'] or 'not created'})." for item in cast(list[dict[str, object]], report["actions"])) or "No qualifying job families."
        totals = cast(list[dict[str, object]], report["workflow_totals"])
        report_only = [item for item in totals if not item["long_job"]]
        shared = cast(list[dict[str, object]], report["shared_setup_diagnostics"])
        summary += f"\n\nShared setup diagnostics: {len(shared)}. See report.json for cross-family step evidence; these never create per-family issues.\n"
        summary += f"\n\nWorkflow-total-only observations: {len(report_only)}. These do not create splitting issues; queue/dependencies/aggregation can exceed ten minutes while every job remains below it.\n"
        diagnostics_report = cast(dict[str, object], report["cancellation_diagnostics"])
        diagnostic_rows = cast(list[dict[str, object]], diagnostics_report["observations"])
        unresolved = sum(cast(dict[str, object], row["finalization"])["state"] == "unresolved_after_job_completion" for row in diagnostic_rows)
        summary += f"\n\n## Cancellation and finalization evidence\n\n{len(diagnostic_rows)} non-success or unresolved observations; {unresolved} jobs have unresolved `Complete job` metadata. See `cancellation-diagnostics.json` and `cancellation-diagnostics.md` in the retained artifact for separate job outcomes, explicit timeout/concurrency annotations, unknown causes and expected wrapper artifact names. These observations never qualify duration improvement issues.\n"
        (args.output_dir / "summary.md").write_text(summary, encoding="utf-8")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as stream:
                stream.write(summary)
        logger.info("Monitor completed; {} family actions", len(cast(list[object], report["actions"])))
        return 0
    except Exception as exc:
        logger.error("CI duration monitor failed: {}", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
