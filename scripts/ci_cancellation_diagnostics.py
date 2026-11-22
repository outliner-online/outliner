"""Retain CI termination observations separately from duration issue admission."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re
from typing import Callable
from urllib.parse import urlsplit

from loguru import logger

# These are GitHub's job timeout annotations, not arbitrary test timeout text.
JOB_TIMEOUT = re.compile(
    r"^The job(?: running on runner .+)? has exceeded the maximum execution time of [0-9a-z .]+[.]?$"
)
CONCURRENCY_CANCEL = re.compile(r"^Canceling since a higher priority waiting request for (.+) exists$")


def _timestamp(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if parsed.tzinfo is not None else None


def _instant(value: object) -> datetime | None:
    stamp = _timestamp(value)
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")) if stamp else None


def _interval(start: object, end: object) -> float | None:
    first, last = _instant(start), _instant(end)
    return round((last - first).total_seconds(), 3) if first and last and last >= first else None


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _identifier(value: object) -> int | None:
    return value if type(value) is int and value > 0 else None


def _execution_provenance(run: dict[str, object], job: dict[str, object]) -> dict[str, object]:
    """Separate executed job intervals from results copied into failed-only reruns."""
    attempt = _identifier(run.get("run_attempt"))
    attempt_start = _instant(run.get("run_started_at"))
    started, ended = _instant(job.get("started_at")), _instant(job.get("completed_at"))
    if attempt is None or attempt_start is None:
        state, reason = "unknown", "attempt_start_or_identity_missing"
    elif attempt > 1 and ended is not None and ended < attempt_start and (started is None or started <= ended):
        state, reason = "carried_forward", "job_completed_before_attempt_start"
    elif started is not None and started >= attempt_start and (ended is None or ended >= started):
        state, reason = "current_attempt", "job_interval_starts_in_attempt"
    else:
        state, reason = "unknown", "job_interval_missing_or_inconsistent_with_attempt"
    return {"state": state, "reason": reason,
            "attempt_started_at": _timestamp(run.get("run_started_at")),
            "source_run_attempt": attempt if state == "current_attempt" else None,
            "source_job_id": _identifier(job.get("id")) if state == "current_attempt" else None}


def _steps(job: dict[str, object]) -> list[dict[str, object]]:
    values = job.get("steps")
    if not isinstance(values, list):
        return []
    return [{"number": step.get("number"), "name": step.get("name"),
             "status": step.get("status"), "conclusion": step.get("conclusion"),
             "started_at": _timestamp(step.get("started_at")),
             "completed_at": _timestamp(step.get("completed_at"))}
            for step in values if isinstance(step, dict)]


def _finalization(job: dict[str, object], steps: list[dict[str, object]]) -> dict[str, object]:
    complete = [step for step in steps if step["name"] == "Complete job"]
    if not complete:
        return {"state": "not_reported", "steps": []}
    resolved = all(step["status"] == "completed" and step["completed_at"] for step in complete)
    not_started = all(step["conclusion"] == "skipped" or step["status"] in {"queued", "pending"} and not step["started_at"] for step in complete)
    state = "completed" if resolved else "not_started" if not_started else "unresolved_after_job_completion" if job.get("status") == "completed" else "incomplete"
    return {"state": state, "steps": complete}


def _repository(run: dict[str, object]) -> str | None:
    value = run.get("head_repository")
    return _text(value.get("full_name")) if isinstance(value, dict) else None


def _pull_requests(run: dict[str, object]) -> set[int]:
    values = run.get("pull_requests")
    return {item["number"] for item in values if isinstance(item, dict) and _identifier(item.get("number"))} if isinstance(values, list) else set()


def _newer_candidates(run: dict[str, object], job: dict[str, object], runs: list[dict[str, object]]) -> list[int]:
    """Temporal overlap is a correlation, never proof of concurrency cancellation."""
    # A rerun retains the original creation timestamp. Only the selected
    # attempt's start can establish overlap with that attempt.
    started = _instant(run.get("run_started_at"))
    finished = _instant(job.get("completed_at"))
    branch, repository, event = _text(run.get("head_branch")), _repository(run), _text(run.get("event"))
    if not started or not finished or not branch or not repository or not event:
        return []
    result = []
    for newer in runs:
        created = _instant(newer.get("created_at"))
        if newer.get("id") == run.get("id") or not created or not started < created <= finished:
            continue
        if (newer.get("head_branch"), _repository(newer), newer.get("event")) != (branch, repository, event):
            continue
        if event.startswith("pull_request") and not (_pull_requests(run) & _pull_requests(newer)):
            continue
        if _identifier(newer.get("id")):
            result.append(newer["id"])
    return sorted(set(result))


class CancellationDiagnostics:
    """Observe every fetched job, enriching anomalies without influencing issues."""

    def __init__(self, repository: str, observed_at: datetime, cutoff: datetime,
                 pages: Callable[[str], list[dict[str, object]]]):
        self.repository = repository
        self.observed_at = observed_at.isoformat()
        self.cutoff = cutoff
        self.pages = pages
        self.complete = False
        self.rows: list[dict[str, object]] = []
        self.carried_rows: list[dict[str, object]] = []
        self.counts: dict[tuple[str, str], dict[str, Counter]] = {}

    def _annotations(self, job: dict[str, object]) -> dict[str, object]:
        check_url = job.get("check_run_url")
        path = urlsplit(check_url).path if isinstance(check_url, str) else ""
        matched = re.fullmatch(rf"/repos/{re.escape(self.repository)}/check-runs/([0-9]+)", path)
        if matched is None:
            return {"state": "unavailable", "reason": "check_run_url_missing_or_unmatched", "items": []}
        try:
            values = self.pages(f"check-runs/{matched[1]}/annotations")
        except (OSError, RuntimeError, ValueError) as error:
            logger.warning("Job {} check annotations unavailable ({}); cancellation cause remains unconfirmed", job.get("id"), type(error).__name__)
            return {"state": "unavailable", "reason": "annotation_request_failed", "items": []}
        return {"state": "available", "items": [
            {"path": item.get("path"), "annotation_level": item.get("annotation_level"),
             "title": item.get("title"), "message": item.get("message")}
            for item in values
        ]}

    def observe(self, workflow: str, run: dict[str, object], jobs: list[dict[str, object]],
                runs: list[dict[str, object]]) -> None:
        for job in jobs:
            ended = _instant(job.get("completed_at"))
            if ended and ended < self.cutoff:
                continue
            name = _text(job.get("name")) or "unknown"
            conclusion = _text(job.get("conclusion"))
            provenance = _execution_provenance(run, job)
            counts = self.counts.setdefault((workflow, name), {state: Counter() for state in ("api_observations", "current_attempt", "carried_forward", "unknown")})
            counts["api_observations"][conclusion or "unknown"] += 1
            counts[provenance["state"]][conclusion or "unknown"] += 1
            steps = _steps(job)
            finalization = _finalization(job, steps)
            anomalous = conclusion in {"cancelled", "failure", "timed_out"} or job.get("status") != "completed" or finalization["state"] in {"unresolved_after_job_completion", "incomplete"}
            if not anomalous and provenance["state"] != "carried_forward":
                continue
            annotations = self._annotations(job) if anomalous else {"state": "not_requested", "reason": "successful_carried_forward_result", "items": []}
            timeout_annotations = [item for item in annotations["items"]
                                   if item["path"] == ".github" and item["annotation_level"] == "failure"
                                   and isinstance(item["message"], str) and JOB_TIMEOUT.fullmatch(item["message"])]
            concurrency_groups = sorted({match[1] for item in annotations["items"]
                                         if item["path"] == ".github" and item["annotation_level"] == "failure"
                                         and isinstance(item["message"], str)
                                         and (match := CONCURRENCY_CANCEL.fullmatch(item["message"]))})
            evidence = []
            if conclusion == "timed_out":
                evidence.append({"category": "job_timeout", "source": "job.conclusion"})
            if timeout_annotations:
                evidence.append({"category": "job_timeout", "source": "check_run.annotation"})
            if concurrency_groups:
                evidence.append({"category": "concurrency_cancelled", "source": "check_run.annotation"})
            categories = {item["category"] for item in evidence}
            if len(categories) == 1:
                termination = {"category": next(iter(categories)), "confidence": "confirmed", "evidence": evidence}
            elif categories:
                termination = {"category": "conflicting_evidence", "confidence": "conflicting", "evidence": evidence}
            else:
                termination = {"category": "unknown", "confidence": "unknown", "evidence": []}
            candidates = _newer_candidates(run, job, runs) if conclusion == "cancelled" and provenance["state"] == "current_attempt" else []
            run_id, attempt, job_id = _identifier(run.get("id")), _identifier(run.get("run_attempt")), _identifier(job.get("id"))
            url = f"https://github.com/{self.repository}/actions/runs/{run_id}/job/{job_id}" if run_id and job_id else None
            shard_match = re.search(r"(?:^| / )e2e-test \(([^)]+)\)$", name)
            browser = "firefox" if shard_match and shard_match[1].startswith("firefox-") else "chromium"
            expected_artifact = f"e2e-artifacts-{browser}-{shard_match[1]}-{run_id}-{attempt}" if shard_match and run_id and attempt and provenance["state"] == "current_attempt" else None
            destination = self.carried_rows if provenance["state"] == "carried_forward" else self.rows
            destination.append({
                "workflow": workflow, "run_id": run_id, "run_attempt": attempt,
                "job_id": job_id, "job_name": name, "job_url": url,
                "head_sha": _text(run.get("head_sha")), "head_branch": _text(run.get("head_branch")),
                "event": _text(run.get("event")), "run_conclusion": _text(run.get("conclusion")),
                "job_status": _text(job.get("status")), "job_conclusion": conclusion,
                "job_created_at": _timestamp(job.get("created_at")),
                "job_started_at": _timestamp(job.get("started_at")),
                "job_completed_at": _timestamp(job.get("completed_at")),
                "job_seconds": _interval(job.get("started_at"), job.get("completed_at")),
                "execution_provenance": provenance,
                "termination": termination, "finalization": finalization,
                "concurrency": {"state": "confirmed" if concurrency_groups else "candidate" if candidates else "unconfirmed",
                                "reported_groups": concurrency_groups,
                                "newer_same_branch_run_ids": candidates,
                                "note": "Overlap does not prove matching concurrency groups or a cancellation initiator."},
                "wrapper_evidence": {"state": "not_collected", "expected_artifact_name": expected_artifact,
                                     "artifact_available": None,
                                     "note": "An expected artifact is named only for a proven current-attempt job interval. Copied or unknown intervals do not establish the source artifact attempt. Inspect command-status.json with execution-context.json; an interruption signal alone does not identify the cancellation initiator."},
                "annotations": annotations, "steps": steps,
            })

    def report(self) -> dict[str, object]:
        return {"schema_version": 1, "repository": self.repository,
                "observed_at": self.observed_at, "collection_complete": self.complete,
                "run_discovery": "created_at", "cutoff": self.cutoff.isoformat(),
                "limitations": [
                    "Job outcomes, observed termination evidence and finalization state are separate facts.",
                    "Complete job without a terminal timestamp is unresolved metadata, not proof of active runner cleanup or a runner defect.",
                    "Missing annotations, artifacts or timestamps remain unknown; elapsed duration alone never establishes a timeout.",
                    "Wrapper evidence and cancellation initiators are not fetched; inspect retained per-attempt artifacts when available.",
                    "API observation totals can include copied rerun results. Use current_attempt outcome counts for rates; exclude carried_forward and unknown provenance. A current job interval does not prove its tests ran.",
                    "This diagnostic report never creates or qualifies duration improvement issues.",
                ],
                "job_outcomes": [{"workflow": workflow, "job_name": name,
                                  **{state: {"total": sum(values.values()), "conclusions": dict(sorted(values.items()))}
                                     for state, values in counts.items()}}
                                 for (workflow, name), counts in sorted(self.counts.items())],
                "observations": self.rows, "carried_forward_observations": self.carried_rows}

    def markdown(self, *, limit: int | None = None) -> str:
        lines = ["## CI cancellation and finalization diagnostics", "",
                 f"Collection: {'complete' if self.complete else 'incomplete'}. {len(self.rows)} non-success or unresolved observations and {len(self.carried_rows)} carried-forward results; see `cancellation-diagnostics.json` for outcomes of every observed job.", "",
                 "Confirmed job timeouts and concurrency cancellations require explicit GitHub conclusions or annotations. Unknown causes stay unknown. `Complete job` unresolved means its terminal state was not reported; it does not establish a runner cleanup hang.", "",
                 "| Run / attempt / job | Job | Execution provenance | Outcome | Termination evidence | Finalization |",
                 "| --- | --- | --- | --- | --- | --- |"]
        rows = [*self.rows, *self.carried_rows]
        selected = rows if limit is None else rows[:limit]
        for row in selected:
            label = f"{row['run_id']} / {row['run_attempt']} / {row['job_id']}"
            link = f"[{label}]({row['job_url']})" if row["job_url"] else label
            name = str(row["job_name"]).replace("|", "\\|").replace("\n", " ").replace("\r", " ").replace("<", "&lt;").replace(">", "&gt;")
            lines.append(f"| {link} | {name} | {row['execution_provenance']['state']} | {row['job_conclusion'] or 'unknown'} | {row['termination']['category']} ({row['termination']['confidence']}) | {row['finalization']['state']} |")
        if limit is not None and len(rows) > limit:
            lines += ["", f"Showing {limit} observations; the retained diagnostics files contain all {len(rows)}."]
        lines += ["", "For cancellation rates, use job_outcomes.current_attempt counts; exclude carried_forward and unknown. api_observations counts API records and can count copied results more than once. A current job interval does not establish that its tests ran. These diagnostics never qualify duration issues. Expected wrapper artifact names are omitted when the execution attempt is unproven; archive availability and contents remain unknown.", ""]
        return "\n".join(lines)

    def write(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "cancellation-diagnostics.json").write_text(json.dumps(self.report(), indent=2) + "\n", encoding="utf-8")
        (directory / "cancellation-diagnostics.md").write_text(self.markdown(), encoding="utf-8")
