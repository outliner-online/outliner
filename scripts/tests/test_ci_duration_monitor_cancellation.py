"""Cancellation evidence through the real monitor's controlled REST boundary."""

import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

from scripts import ci_duration_monitor as monitor
from test_ci_duration_monitor import GitHub, NOW, REPOSITORY, Result, job, stamp

TIMEOUT = "The job has exceeded the maximum execution time of 30m0s"
CONCURRENCY = "Canceling since a higher priority waiting request for ci-CI-refs/heads/main exists"


def annotation(message, path=".github"):
    return {"path": path, "annotation_level": "failure", "title": "", "message": message}


def cancelled(number=1, *, attempt=1, conclusion="cancelled"):
    value = job(number, 2100, name="e2e-test / e2e-test (tables-2)", conclusion=conclusion, attempt=attempt)
    value["check_run_url"] = f"https://api.github.com/repos/{REPOSITORY}/check-runs/{number}"
    return value


class CancellationGitHub(GitHub):
    """Repository fixture that exposes paginated check annotations, not fake causes."""

    def __init__(self):
        super().__init__()
        self.annotations = {}
        self.annotation_status = 200
        self.issue_status = 200
        self.attempts = {}
        self.runs[0].update(created_at=stamp(-2200), run_started_at=stamp(-2200), conclusion="cancelled")
        self.jobs[(10, 1)] = [cancelled()]

    def request(self, method, path, payload=None):
        route = urlsplit(path).path
        if method == "GET" and route in self.attempts:
            self.calls.append((method, path, payload))
            return Result(200, self.attempts[route])
        if method == "GET" and route.startswith("check-runs/"):
            self.calls.append((method, path, payload))
            page = int(parse_qs(urlsplit(path).query).get("page", ["1"])[0])
            rows = self.annotations.get(int(route.split("/")[1]), [])
            return Result(self.annotation_status, rows[(page - 1) * 100:page * 100])
        if method == "GET" and route == "issues" and self.issue_status != 200:
            self.calls.append((method, path, payload))
            return Result(self.issue_status, {})
        return super().request(method, path, payload)


class CancellationTests(unittest.TestCase):
    def setUp(self):
        self.github = CancellationGitHub()
        self.workflow = monitor.Workflow(".github/workflows/ci.yml", ())
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)

    def report(self, *, publish=False, now=NOW):
        return monitor.run_monitor(self.github, (self.workflow,), REPOSITORY, "ignored",
                                   now=now, lookback_hours=48, publish=publish,
                                   diagnostics_output=self.output)

    def test_timeout_and_unresolved_finalization_are_independent_observations(self):
        item = self.github.jobs[(10, 1)][0]
        item["steps"] += [{"name": "Complete job", "status": "in_progress", "conclusion": None,
                           "started_at": stamp(-1800), "completed_at": None}]
        self.github.annotations[1] = [annotation(TIMEOUT)]
        report = self.report(publish=True)
        row = report["cancellation_diagnostics"]["observations"][0]
        self.assertEqual((row["run_id"], row["run_attempt"], row["job_id"]), (10, 1, 1))
        self.assertEqual(row["termination"]["category"], "job_timeout")
        self.assertEqual(row["finalization"]["state"], "unresolved_after_job_completion")
        self.assertIsNone(row["finalization"]["steps"][0]["completed_at"])
        self.assertEqual(row["wrapper_evidence"]["expected_artifact_name"], "e2e-artifacts-chromium-tables-2-10-1")
        self.assertIsNone(row["wrapper_evidence"]["artifact_available"])
        self.assertEqual(report["actions"], [])
        self.assertEqual(self.github.mutations, [])
        self.assertTrue(json.loads((self.output / "cancellation-diagnostics.json").read_text())["collection_complete"])

    def test_explicit_concurrency_annotation_is_not_a_temporal_guess(self):
        self.github.annotations[1] = [annotation(CONCURRENCY), annotation("The operation was canceled.")]
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["termination"]["category"], "concurrency_cancelled")
        self.assertEqual(row["concurrency"]["state"], "confirmed")
        self.assertEqual(row["concurrency"]["reported_groups"], ["ci-CI-refs/heads/main"])

    def test_elapsed_time_actor_and_generic_annotations_never_invent_cause(self):
        self.github.runs[0]["actor"] = {"login": "example-owner"}
        self.github.annotations[1] = [annotation("The operation was canceled."), annotation(TIMEOUT, "client/e2e/test.ts")]
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["job_seconds"], 2100)
        self.assertEqual(row["termination"]["category"], "unknown")
        self.assertEqual(row["termination"]["evidence"], [])

    def test_same_branch_overlap_is_candidate_and_missing_timestamps_stay_unknown(self):
        later = {**self.github.runs[0], "id": 11, "created_at": stamp(-20)}
        self.github.runs.append(later)
        self.github.jobs[(11, 1)] = []
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["concurrency"]["newer_same_branch_run_ids"], [11])
        self.assertEqual(row["concurrency"]["state"], "candidate")
        self.assertEqual(row["termination"]["category"], "unknown")
        self.github.jobs[(10, 1)][0]["completed_at"] = None
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertIsNone(row["job_seconds"])
        self.assertEqual(row["concurrency"]["state"], "unconfirmed")

    def test_annotations_and_jobs_paginate_without_losing_attempt_identity(self):
        self.github.runs[0]["run_attempt"] = 2
        self.github.jobs[(10, 1)] += [job(number, 50) for number in range(2, 102)]
        self.github.jobs[(10, 2)] = [job(102, 50, attempt=2)]
        self.github.annotations[1] = [annotation("The operation was canceled.")] * 100 + [annotation(TIMEOUT)]
        report = self.report()["cancellation_diagnostics"]
        self.assertEqual([(row["job_id"], row["run_attempt"]) for row in report["observations"]], [(1, 1)])
        self.assertEqual(report["observations"][0]["termination"]["category"], "job_timeout")
        self.assertEqual(sum(item["api_observations"]["total"] for item in report["job_outcomes"]), 102)
        paths = [call[1] for call in self.github.calls]
        self.assertIn("actions/runs/10/attempts/1/jobs?per_page=100&page=2", paths)
        self.assertIn("actions/runs/10/attempts/2/jobs?per_page=100&page=1", paths)
        self.assertIn("check-runs/1/annotations?per_page=100&page=2", paths)

    def test_rerun_overlap_excludes_runs_created_before_the_selected_attempt(self):
        self.github.runs[0]["run_attempt"] = 2
        self.github.runs[0]["run_started_at"] = stamp(-700)
        self.github.jobs[(10, 1)] = []
        self.github.jobs[(10, 2)] = [cancelled(attempt=2)]
        self.github.jobs[(10, 2)][0]["started_at"] = stamp(-600)
        self.github.runs.append({**self.github.runs[0], "id": 11, "run_attempt": 1,
                                 "created_at": stamp(-1000)})
        self.github.jobs[(11, 1)] = []
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["run_attempt"], 2)
        self.assertEqual(row["concurrency"]["newer_same_branch_run_ids"], [])

    def test_failed_only_rerun_copied_success_is_not_a_second_execution(self):
        # GitHub minted a new attempt-2 ID while preserving the real attempt-1
        # tables-2 interval. The later created_at must not override that evidence.
        run_id = 45003144106
        run = {**self.github.runs[0], "id": run_id, "run_attempt": 2,
               "created_at": "2026-11-22T09:09:21Z", "run_started_at": "2026-11-22T09:09:20Z"}
        original = {**job(137149385501, 877, name="e2e-test / e2e-test (tables-2)"),
                    "created_at": "2026-11-22T08:34:20Z", "started_at": "2026-11-22T08:34:29Z",
                    "completed_at": "2026-11-22T08:49:06Z", "steps": []}
        copied = {**original, "id": 137158082007, "run_attempt": 2, "created_at": "2026-11-22T09:09:23Z"}
        # Preserve the observed retry identity/start; its later terminal time is
        # controlled here so the completed-run collection boundary is exercised.
        retry = {**job(137158080928, 34, name="e2e-test / e2e-test (new-4-2)", conclusion="failure", attempt=2),
                 "created_at": "2026-11-22T09:09:23Z", "started_at": "2026-11-22T09:09:26Z",
                 "completed_at": "2026-11-22T09:10:00Z", "steps": []}
        self.github.runs = [run]
        self.github.attempts[f"actions/runs/{run_id}/attempts/1"] = {
            **run, "run_attempt": 1, "run_started_at": "2026-11-22T08:30:00Z"}
        self.github.jobs = {(run_id, 1): [original], (run_id, 2): [copied, retry]}
        report = self.report(now=datetime(2026, 11, 22, 10, tzinfo=timezone.utc))["cancellation_diagnostics"]
        tables = next(row for row in report["job_outcomes"] if row["job_name"].endswith("(tables-2)"))
        self.assertEqual(tables["api_observations"], {"total": 2, "conclusions": {"success": 2}})
        self.assertEqual(tables["current_attempt"], {"total": 1, "conclusions": {"success": 1}})
        self.assertEqual(tables["carried_forward"], {"total": 1, "conclusions": {"success": 1}})
        self.assertEqual(tables["unknown"]["total"], 0)
        carried = report["carried_forward_observations"][0]
        self.assertEqual((carried["run_attempt"], carried["job_id"]), (2, 137158082007))
        self.assertEqual(carried["execution_provenance"]["state"], "carried_forward")
        self.assertIsNone(carried["execution_provenance"]["source_run_attempt"])
        self.assertIsNone(carried["execution_provenance"]["source_job_id"])
        self.assertIsNone(carried["wrapper_evidence"]["expected_artifact_name"])
        self.assertEqual([row["job_id"] for row in report["observations"]], [137158080928])
        self.assertEqual(report["observations"][0]["execution_provenance"]["state"], "current_attempt")
        self.assertEqual(self.github.mutations, [])

    def test_missing_attempt_start_keeps_provenance_and_artifact_identity_unknown(self):
        self.github.runs[0]["run_started_at"] = None
        self.github.annotations[1] = [annotation(TIMEOUT)]
        report = self.report()["cancellation_diagnostics"]
        row = report["observations"][0]
        self.assertEqual(row["execution_provenance"]["state"], "unknown")
        self.assertIsNone(row["wrapper_evidence"]["expected_artifact_name"])
        self.assertEqual(row["termination"]["category"], "job_timeout")
        self.assertEqual(report["job_outcomes"][0]["current_attempt"]["total"], 0)
        self.assertEqual(report["job_outcomes"][0]["unknown"]["total"], 1)

    def test_carried_failure_retains_explicit_cause_and_unresolved_finalization(self):
        self.github.runs[0].update(run_attempt=2, run_started_at=stamp(10))
        item = cancelled(attempt=2)
        item["steps"] = [{"name": "Complete job", "status": "in_progress", "conclusion": None,
                          "started_at": stamp(-1800), "completed_at": None}]
        self.github.jobs = {(10, 1): [], (10, 2): [item]}
        self.github.annotations[1] = [annotation(TIMEOUT)]
        report = self.report()["cancellation_diagnostics"]
        self.assertEqual(report["observations"], [])
        row = report["carried_forward_observations"][0]
        self.assertEqual(row["termination"]["category"], "job_timeout")
        self.assertEqual(row["finalization"]["state"], "unresolved_after_job_completion")
        self.assertEqual(report["job_outcomes"][0]["carried_forward"]["conclusions"], {"cancelled": 1})

    def test_firefox_artifact_reference_uses_the_existing_browser_contract(self):
        self.github.jobs[(10, 1)][0]["name"] = "e2e-test / e2e-test (firefox-selection-new)"
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["wrapper_evidence"]["expected_artifact_name"], "e2e-artifacts-firefox-firefox-selection-new-10-1")

    def test_annotation_denial_remains_unknown_without_blocking_duration_monitor(self):
        self.github.annotation_status = 403
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["annotations"]["state"], "unavailable")
        self.assertEqual(row["termination"]["category"], "unknown")
        self.assertEqual(self.github.mutations, [])

    def test_report_survives_later_issue_inventory_failure(self):
        self.github.issue_status = 404
        with self.assertRaisesRegex(RuntimeError, "issues returned 404"):
            self.report(publish=True)
        saved = json.loads((self.output / "cancellation-diagnostics.json").read_text())
        self.assertTrue(saved["collection_complete"])
        self.assertEqual(len(saved["observations"]), 1)
        self.assertEqual(self.github.mutations, [])

    def test_wrong_attempt_fails_before_attributing_evidence_or_publishing(self):
        self.github.jobs[(10, 1)][0]["run_attempt"] = 2
        with self.assertRaisesRegex(ValueError, "different run or attempt"):
            self.report(publish=True)
        saved = json.loads((self.output / "cancellation-diagnostics.json").read_text())
        self.assertFalse(saved["collection_complete"])
        self.assertEqual(saved["observations"], [])
        self.assertEqual(self.github.mutations, [])

    def test_conflicting_service_evidence_is_retained_instead_of_choosing_cause(self):
        self.github.annotations[1] = [annotation(TIMEOUT), annotation(CONCURRENCY)]
        row = self.report()["cancellation_diagnostics"]["observations"][0]
        self.assertEqual(row["termination"]["category"], "conflicting_evidence")
        self.assertEqual({item["category"] for item in row["termination"]["evidence"]}, {"job_timeout", "concurrency_cancelled"})

    def test_failure_wrapper_and_timed_out_outcomes_are_not_treated_as_cancelled(self):
        self.github.jobs[(10, 1)] = [cancelled(1, conclusion="failure"), cancelled(2, conclusion="timed_out")]
        rows = self.report()["cancellation_diagnostics"]["observations"]
        self.assertEqual([row["job_conclusion"] for row in rows], ["failure", "timed_out"])
        self.assertEqual([row["termination"]["category"] for row in rows], ["unknown", "job_timeout"])
        self.assertEqual(rows[0]["wrapper_evidence"]["state"], "not_collected")


if __name__ == "__main__":
    unittest.main()
