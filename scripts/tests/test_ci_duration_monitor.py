"""Production monitor entry-point regressions against a controlled REST boundary."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from scripts import ci_duration_monitor as monitor

NOW = datetime(2026, 11, 21, 0, 0, tzinfo=timezone.utc)
REPOSITORY = "example/project"


def stamp(seconds: float = 0) -> str:
    return (NOW + timedelta(seconds=seconds)).isoformat()


def job(number: int = 1, seconds: float = 600, *, name: str = "Tests (1/4)", conclusion: str = "success", attempt: int = 1) -> dict[str, object]:
    return {
        "id": number,
        "name": name,
        "status": "completed",
        "conclusion": conclusion,
        "run_attempt": attempt,
        "created_at": stamp(-seconds - 10),
        "started_at": stamp(-seconds),
        "completed_at": stamp(),
        "steps": [{"name": "Run tests", "status": "completed", "started_at": stamp(-seconds + 20), "completed_at": stamp()}],
    }


@dataclass(frozen=True)
class Result:
    status: int
    data: object


class GitHub:
    """Controlled API with durable mutations and deliberate lost responses."""

    def __init__(self) -> None:
        self.runs: list[dict[str, object]] = [{"id": 10, "run_attempt": 1, "status": "completed", "path": ".github/workflows/ci.yml", "head_sha": "a" * 40, "run_started_at": stamp(-700)}]
        self.jobs: dict[tuple[int, int], list[dict[str, object]]] = {(10, 1): [job()]}
        self.issues: list[dict[str, object]] = []
        self.comments: dict[int, list[dict[str, object]]] = {}
        self.events: dict[int, list[dict[str, object]]] = {}
        self.calls: list[tuple[str, str, dict[str, object] | None]] = []
        self.lose_after: str | None = None
        self.reject_before: str | None = None
        self.search_total: int | None = None
        self.truncated_jobs = False
        self.managed_label_exists = True

    def request(self, method: str, path: str, payload: dict[str, object] | None = None) -> Result:
        self.calls.append((method, path, copy.deepcopy(payload)))
        route = urlsplit(path).path
        query = parse_qs(urlsplit(path).query)
        page = int(query.get("page", ["1"])[0])

        def paged(items: list[dict[str, object]]) -> list[dict[str, object]]:
            return copy.deepcopy(items[(page - 1) * 100 : page * 100])

        if method == "GET":
            if route.startswith("actions/workflows/"):
                return Result(200, {"total_count": self.search_total if self.search_total is not None else len(self.runs), "workflow_runs": paged(self.runs)})
            if route.startswith("actions/runs/"):
                parts = route.split("/")
                run_id, attempt = int(parts[2]), int(parts[4])
                if route.endswith("/jobs"):
                    items = self.jobs[(run_id, attempt)]
                    return Result(200, {"total_count": len(items) + int(self.truncated_jobs), "jobs": paged(items)})
                result = copy.deepcopy(next(run for run in self.runs if run["id"] == run_id))
                result["run_attempt"] = attempt
                return Result(200, result)
            if route == "issues":
                return Result(200, paged(self.issues))
            if route.startswith("issues/"):
                number = int(route.split("/")[1])
                if route.endswith("/comments"):
                    return Result(200, paged(self.comments.get(number, [])))
                if route.endswith("/events"):
                    return Result(200, paged(self.events.get(number, [])))
            if route.startswith("labels/"):
                if route.endswith(monitor.MANAGED_LABEL) and not self.managed_label_exists:
                    return Result(404, {})
                return Result(200, {"name": route.split("/")[1]})
        if self.reject_before == route:
            self.reject_before = None
            return Result(503, {})
        assert payload is not None
        if method == "POST" and route == "issues":
            number = len(self.issues) + 1
            item = {"number": number, "body": payload["body"], "state": "open", "closed_at": None, "labels": [{"name": name} for name in payload["labels"]]}
            self.issues.append(item)
            result = Result(201, copy.deepcopy(item))
        elif method == "POST" and route.endswith("/comments"):
            number = int(route.split("/")[1])
            self.comments.setdefault(number, []).append({"body": payload["body"]})
            result = Result(201, {"id": 77})
        elif method == "POST" and route.startswith("issues/") and route.endswith("/labels"):
            number = int(route.split("/")[1])
            item = next(issue for issue in self.issues if issue["number"] == number)
            item["labels"].append({"name": monitor.READY_LABEL})
            self.events.setdefault(number, []).append({"event": "labeled", "label": {"name": monitor.READY_LABEL}})
            result = Result(200, item["labels"])
        elif method == "POST" and route == "labels":
            self.managed_label_exists = True
            result = Result(201, payload)
        else:
            raise AssertionError(f"Unexpected API call: {method} {path}")
        if self.lose_after == route:
            self.lose_after = None
            raise RuntimeError("Connection lost after accepted mutation")
        return result

    @property
    def mutations(self) -> list[tuple[str, str, dict[str, object] | None]]:
        return [call for call in self.calls if call[0] != "GET"]


class MonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = self.root / "monitor.json"
        self.config.write_text(
            json.dumps(
                {
                    "workflows": [
                        {
                            "path": ".github/workflows/ci.yml",
                            "families": [{"key": "tests", "name": "Tests", "job_pattern": r"Tests \(\d+/\d+\)", "test_step_pattern": "^Run tests$", "source_paths": [".github/workflows/ci.yml", "scripts/test.sh"], "guidance": "Retain the existing complete test selection and aggregate check."}],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        self.github = GitHub()

    def run_cli(self, *, publish: bool = True, now: datetime = NOW) -> int:
        args = ["--repository", REPOSITORY, "--config", str(self.config), "--output-dir", str(self.root / "output"), "--source-ref", "b" * 40]
        if publish:
            args.append("--publish")
        with patch.dict("os.environ", {"GITHUB_TOKEN": "test-only-token", "GITHUB_STEP_SUMMARY": str(self.root / "step-summary.md")}), patch.object(monitor, "logger"), patch.object(monitor.time, "sleep"):
            return monitor.main(args, client_factory=lambda _token, _repo: self.github, now=now)

    def report(self) -> dict[str, object]:
        return json.loads((self.root / "output" / "report.json").read_text(encoding="utf-8"))

    def test_exact_threshold_groups_shards_and_applies_readiness_last(self) -> None:
        self.github.jobs[(10, 1)] = [job(1, 600), job(2, 650, name="Tests (2/4)"), job(3, 400, name="Tests (3/4)")]
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(len(self.github.issues), 1)
        self.assertEqual([call[1] for call in self.github.mutations], ["issues", "issues/1/comments", "issues/1/labels"])
        self.assertEqual(self.github.mutations[0][2]["labels"], [monitor.MANAGED_LABEL])
        self.assertIn("REQ-001:", self.github.issues[0]["body"])
        self.assertIn("## Initial Implementation Prompt", self.github.issues[0]["body"])
        self.assertIn("400 / 650 (3 jobs)", self.github.issues[0]["body"])
        self.assertIn("ci-duration-monitor:v1:", self.github.comments[1][0]["body"])
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(len(self.github.mutations), 3)

    def test_threshold_boundary_and_unknown_queue(self) -> None:
        self.github.jobs[(10, 1)] = [job(seconds=599.9)]
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])
        self.github.jobs[(10, 1)] = [job(seconds=600)]
        del self.github.jobs[(10, 1)][0]["created_at"]
        self.assertEqual(self.run_cli(), 0)
        self.assertIn("| 600 | unknown |", self.github.issues[0]["body"])

    def test_dry_run_never_creates_issues_comments_or_labels(self) -> None:
        self.github.managed_label_exists = False
        self.assertEqual(self.run_cli(publish=False), 0)
        self.assertEqual(self.github.mutations, [])
        self.assertEqual(self.report()["actions"][0]["action"], "create")

    def test_cancelled_skipped_and_incomplete_jobs_do_not_create_issue(self) -> None:
        self.github.jobs[(10, 1)] = [job(1, 800, conclusion="cancelled"), job(2, 800, conclusion="skipped"), job(3, 800)]
        self.github.jobs[(10, 1)][2]["completed_at"] = None
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])

    def test_failed_and_timed_out_completed_work_is_observed(self) -> None:
        for conclusion in ("failure", "timed_out"):
            with self.subTest(conclusion=conclusion):
                self.github = GitHub()
                self.github.jobs[(10, 1)] = [job(seconds=610, conclusion=conclusion)]
                self.assertEqual(self.run_cli(), 0)
                self.assertEqual(len(self.github.issues), 1)

    def test_queue_and_workflow_total_alone_are_report_only(self) -> None:
        self.github.jobs[(10, 1)] = [job(seconds=100)]
        self.github.jobs[(10, 1)][0]["created_at"] = stamp(-2000)
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])
        self.assertFalse(self.report()["workflow_totals"][0]["long_job"])
        self.assertEqual(self.report()["workflow_totals"][0]["elapsed_seconds"], 700)

    def test_unknown_job_has_its_own_family(self) -> None:
        self.github.jobs[(10, 1)] = [job(name="Lint and build", seconds=610)]
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.report()["actions"][0]["family"], "job:Lint and build")
        self.assertIn(".github/workflows/ci.yml", self.github.issues[0]["body"])

    def test_detection_retains_slow_observation_before_five_fast_runs(self) -> None:
        for run_id in range(11, 17):
            run = copy.deepcopy(self.github.runs[0])
            run["id"] = run_id
            self.github.runs.append(run)
            self.github.jobs[(run_id, 1)] = [job(run_id, 100)]
        self.github.jobs[(10, 1)] = [job(seconds=610)]
        self.github.jobs[(10, 1)][0]["completed_at"] = stamp(-10)
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(len(self.github.issues), 1)
        self.assertIn("10 / 1", self.github.issues[0]["body"])
        self.assertIn("16 / 1", self.github.issues[0]["body"])

    def test_attempts_are_not_mixed_or_duplicated(self) -> None:
        self.github.runs[0]["run_attempt"] = 2
        self.github.jobs[(10, 2)] = [job(2, 100, attempt=2)]
        self.assertEqual(self.run_cli(), 0)
        samples = self.report()["observations"][0]["samples"]
        self.assertEqual({sample["attempt"] for sample in samples}, {1, 2})
        self.assertEqual(len(self.github.issues), 1)
        self.assertIn("attempts/1/jobs", "\n".join(call[1] for call in self.github.calls))
        self.assertIn("attempts/2/jobs", "\n".join(call[1] for call in self.github.calls))

    def test_pagination_reaches_late_jobs_and_issues(self) -> None:
        self.github.jobs[(10, 1)] = [job(number, 100, name=f"Tests ({number}/101)") for number in range(1, 102)]
        self.github.jobs[(10, 1)][100] = job(101, 700, name="Tests (101/101)")
        self.assertEqual(self.run_cli(), 0)
        owned = self.github.issues[0]
        unrelated = [{"number": number, "body": "Unrelated managed issue", "state": "closed", "closed_at": stamp(-100), "labels": [{"name": monitor.MANAGED_LABEL}]} for number in range(2, 102)]
        self.github.issues = [*unrelated, owned]
        self.github.calls.clear()
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])
        self.assertTrue(any("jobs?per_page=100&page=2" in call[1] for call in self.github.calls))
        self.assertTrue(any(call[1].startswith("issues?") and "page=2" in call[1] for call in self.github.calls))

    def test_api_cap_or_truncated_jobs_fails_before_any_mutation(self) -> None:
        self.github.search_total = 1001
        self.assertEqual(self.run_cli(), 1)
        self.assertEqual(self.github.mutations, [])
        self.github.search_total = None
        self.github.truncated_jobs = True
        self.assertEqual(self.run_cli(), 1)
        self.assertEqual(self.github.mutations, [])

    def test_lost_create_comment_or_label_response_recovers_without_duplicate(self) -> None:
        for route in ("issues", "issues/1/comments", "issues/1/labels"):
            with self.subTest(route=route):
                self.github = GitHub()
                self.github.lose_after = route
                self.assertEqual(self.run_cli(), 1)
                self.assertEqual(self.run_cli(), 0)
                self.assertEqual(len(self.github.issues), 1)
                self.assertEqual(len(self.github.comments[1]), 1)
                self.assertEqual(len(self.github.events[1]), 1)
                self.assertEqual(len([call for call in self.github.mutations if call[1] == "issues"]), 1)

    def test_reviewer_body_rewrite_and_consumed_readiness_are_preserved(self) -> None:
        self.assertEqual(self.run_cli(), 0)
        self.github.issues[0]["body"] = "Reviewer rewrote the specification and removed the hidden marker."
        self.github.issues[0]["labels"] = [{"name": monitor.MANAGED_LABEL}]
        self.github.jobs[(10, 1)] = [job(2, 700)]
        self.github.calls.clear()
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(len(self.github.issues), 1)
        self.assertEqual(self.github.issues[0]["body"], "Reviewer rewrote the specification and removed the hidden marker.")
        self.assertEqual([call[1] for call in self.github.mutations], ["issues/1/comments"])

    def test_closed_issue_requires_new_completion_after_closure(self) -> None:
        self.assertEqual(self.run_cli(), 0)
        self.github.issues[0]["state"] = "closed"
        self.github.issues[0]["closed_at"] = stamp()
        self.github.calls.clear()
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])
        self.github.jobs[(10, 1)] = [job(2, 700)]
        self.github.jobs[(10, 1)][0]["completed_at"] = stamp(1)
        self.assertEqual(self.run_cli(now=NOW + timedelta(seconds=2)), 0)
        self.assertEqual(len(self.github.issues), 2)
        self.assertEqual(self.github.issues[0]["state"], "closed")

    def test_failed_readiness_recovers_after_original_run_ages_out(self) -> None:
        self.github.reject_before = "issues/1/labels"
        self.assertEqual(self.run_cli(), 1)
        self.github.runs = []
        self.github.calls.clear()
        self.assertEqual(self.run_cli(now=NOW + timedelta(days=4)), 0)
        self.assertEqual([call[1] for call in self.github.mutations], ["issues/1/labels"])
        self.assertEqual(self.report()["actions"][0]["action"], "recover-submission")

    def test_lost_create_recovers_retained_identity_after_run_ages_out(self) -> None:
        self.github.lose_after = "issues"
        self.assertEqual(self.run_cli(), 1)
        self.github.runs = []
        self.github.calls.clear()
        self.assertEqual(self.run_cli(now=NOW + timedelta(days=4)), 0)
        self.assertEqual([call[1] for call in self.github.mutations], ["issues/1/comments", "issues/1/labels"])

    def test_event_failure_does_not_resubmit_consumed_label(self) -> None:
        self.assertEqual(self.run_cli(), 0)
        self.github.issues[0]["labels"] = [{"name": monitor.MANAGED_LABEL}]
        original = self.github.request

        def unavailable(method: str, path: str, payload: dict[str, object] | None = None) -> Result:
            if "/events?" in path:
                return Result(503, {})
            return original(method, path, payload)

        self.github.calls.clear()
        with patch.object(self.github, "request", side_effect=unavailable):
            self.assertEqual(self.run_cli(), 1)
        self.assertEqual(self.github.mutations, [])

    def test_incomplete_pending_body_is_not_submitted_inside_current_window(self) -> None:
        self.github.reject_before = "issues/1/labels"
        self.assertEqual(self.run_cli(), 1)
        self.github.issues[0]["body"] = "Draft: requirements being revised."
        self.github.calls.clear()
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])
        self.assertEqual(self.github.issues[0]["body"], "Draft: requirements being revised.")
        self.assertEqual(self.report()["actions"][0]["action"], "awaiting-complete-specification")

    def test_transient_get_status_and_transport_errors_are_retried(self) -> None:
        for failure in (Result(502, None), Result(503, None), Result(504, None), ConnectionError("transport unavailable")):
            with self.subTest(failure=failure):
                self.github = GitHub()
                original = self.github.request
                failed = False
                requests = 0

                def flaky(method: str, path: str, payload: dict[str, object] | None = None) -> Result:
                    nonlocal failed, requests
                    if method == "GET" and "/jobs?" in path:
                        requests += 1
                        if not failed:
                            failed = True
                            if isinstance(failure, Exception):
                                raise failure
                            return failure
                    return original(method, path, payload)

                with patch.object(self.github, "request", side_effect=flaky):
                    self.assertEqual(self.run_cli(), 0)
                self.assertEqual(requests, 2)
                self.assertEqual(len(self.github.issues), 1)

    def test_read_retries_are_bounded_and_do_not_retry_auth_rate_or_schema_errors(self) -> None:
        for failure, attempts in ((Result(502, None), 3), (Result(401, None), 1), (Result(403, None), 1), (Result(429, None), 1), (RuntimeError("malformed JSON"), 1)):
            with self.subTest(failure=failure):
                self.github = GitHub()
                original = self.github.request
                requests = 0

                def failed(method: str, path: str, payload: dict[str, object] | None = None) -> Result:
                    nonlocal requests
                    if method == "GET" and "/jobs?" in path:
                        requests += 1
                        if isinstance(failure, Exception):
                            raise failure
                        return failure
                    return original(method, path, payload)

                with patch.object(self.github, "request", side_effect=failed):
                    self.assertEqual(self.run_cli(), 1)
                self.assertEqual(requests, attempts)
                self.assertEqual(self.github.mutations, [])

    def test_failed_mutation_response_is_never_retried(self) -> None:
        self.github.reject_before = "issues"
        self.assertEqual(self.run_cli(), 1)
        self.assertEqual([call[1] for call in self.github.mutations], ["issues"])
        self.assertEqual(self.github.issues, [])

    def test_rerun_reset_creation_time_keeps_valid_job_runtime_and_unknown_queue(self) -> None:
        retained = job(136706270635, 784, name="server-test / server-test", attempt=2)
        retained.update({"created_at": "2026-11-21T02:56:18Z", "started_at": "2026-11-21T02:32:25Z", "completed_at": "2026-11-21T02:45:29Z"})
        retained["steps"] = [{"name": "Run tests", "status": "completed", "started_at": "2026-11-21T02:32:45Z", "completed_at": "2026-11-21T02:45:20Z"}]
        self.github.runs[0].update({"run_attempt": 2, "run_started_at": "2026-11-21T02:55:00Z"})
        self.github.jobs[(10, 1)] = []
        self.github.jobs[(10, 2)] = [retained]
        self.assertEqual(self.run_cli(now=NOW + timedelta(hours=3)), 0)
        self.assertEqual(len(self.github.issues), 1)
        samples = [sample for item in self.report()["observations"] for sample in item["samples"]]
        self.assertEqual(samples[0]["runner_seconds"], 784)
        self.assertIsNone(samples[0]["queue_seconds"])
        self.assertEqual(samples[0]["completed_at"], "2026-11-21T02:45:29Z")
        self.assertEqual(self.report()["workflow_totals"], [])
        self.assertIn("| 784 | unknown | 755 |", self.github.issues[0]["body"])

    def test_out_of_order_job_is_skipped_and_optional_step_remains_unknown(self) -> None:
        invalid = job(1, 900)
        invalid["started_at"] = stamp(1)
        valid = job(2, 800, name="Tests (2/4)")
        valid["steps"][0]["started_at"] = stamp(1)
        self.github.jobs[(10, 1)] = [invalid, valid]
        self.assertEqual(self.run_cli(), 0)
        samples = self.report()["observations"][0]["samples"]
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["runner_seconds"], 800)
        self.assertEqual(samples[0]["family_jobs"], 1)
        self.assertIsNone(samples[0]["test_step_seconds"])
        self.assertIn("| 800 | 10 | unknown |", self.github.issues[0]["body"])

    def test_configured_repository_paths_and_template_exist(self) -> None:
        root = Path(monitor.__file__).resolve().parents[1]
        workflows = monitor.read_config(root / ".github" / "ci-duration-monitor.json")
        for workflow in workflows:
            self.assertTrue((root / workflow.path).is_file(), workflow.path)
            for family in workflow.families:
                for path in family.source_paths:
                    self.assertTrue((root / path).is_file(), path)
        template = (root / ".github" / "ci-duration-issue.md").read_text(encoding="utf-8")
        self.assertIn("## Initial Implementation Prompt", template)
        self.assertIn("assigned to exactly one shard", template)


if __name__ == "__main__":
    unittest.main()
