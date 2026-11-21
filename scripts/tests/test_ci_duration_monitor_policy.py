"""Policy regressions using native owner-closed shapes and current repo sources.

The GitHub fixture is the explicit isolated API boundary; no live issue writes.
"""

import copy
from datetime import timedelta
import json
import re
from pathlib import Path
import unittest
from unittest.mock import patch

import test_ci_duration_monitor as fixtures
from test_ci_duration_monitor import GitHub, NOW, REPOSITORY, Result, job, stamp
from scripts import ci_duration_monitor as monitor
from scripts.ci_duration_policy import native_tests

ROOT = Path(__file__).resolve().parents[2]


class PolicyTests(unittest.TestCase):
    setUp = fixtures.MonitorTests.setUp
    run_cli = fixtures.MonitorTests.run_cli
    report = fixtures.MonitorTests.report

    def set_jobs(self, jobs, *, runs=2):
        self.github.runs = [{**copy.deepcopy(self.github.runs[0]), "id": run_id} for run_id in range(10, 10 + runs)]
        self.github.jobs = {(run["id"], 1): copy.deepcopy(jobs) for run in self.github.runs}
        for run in self.github.runs:
            for item in self.github.jobs[(run["id"], 1)]:
                item["id"] += run["id"] * 1000

    def test_single_slow_run_attempts_and_different_shards_are_not_recurrence(self):
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(self.github.mutations, [])
        self.github.runs[0]["run_attempt"] = 2
        self.github.jobs[(10, 2)] = [job(2, attempt=2)]
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(self.github.mutations, [])
        self.github.runs[0]["run_attempt"] = 1
        self.github.runs.append({**self.github.runs[0], "id": 11})
        self.github.jobs[(11, 1)] = [job(3, name="Tests (2/4)")]
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(self.github.mutations, [])

    def test_default_branch_repository_workflow_and_native_measurements_fail_closed(self):
        for change in ("branch", "event", "repository", "source", "inactive", "unknown-variant", "no-native", "one-file", "retry", "short-tests", "logs-unavailable"):
            with self.subTest(change=change):
                self.github = GitHub()
                self.set_jobs([job(seconds=700)])
                original = self.github.request

                def request(method, path, payload=None):
                    if change == "logs-unavailable" and path.startswith("actions/jobs/"):
                        return Result(404, {})
                    if change == "source" and path.startswith("contents/") and "ref=" + "a" * 40 in path:
                        return Result(404, {})
                    if change == "inactive" and path.startswith("actions/workflows/") and "/runs?" not in path:
                        return Result(200, {"state": "disabled_manually", "path": ".github/workflows/ci.yml"})
                    return original(method, path, payload)

                for run in self.github.runs:
                    if change == "branch": run["head_branch"] = "old-prototype"
                    if change == "event": run["event"] = "pull_request"
                    if change == "repository": run["head_repository"] = {"full_name": "other/repo"}
                for jobs in self.github.jobs.values():
                    for item in jobs:
                        if change == "unknown-variant": item["name"] = "Tests (retired)"
                        if change in {"no-native", "one-file", "retry", "short-tests"}:
                            self.github.logs[item["id"]] = {
                                "no-native": "Run tests took 700 seconds",
                                "one-file": "Test Files 1 passed (1)\n Tests 2 passed (2)\n Duration 700s (tests 700s)",
                                "retry": "Test Files 2 passed (2)\n Tests 2 passed (2)\n Duration 700s (tests 700s) (retry x1)",
                                "short-tests": "Test Files 2 passed (2)\n Tests 2 passed (2)\n Duration 700s (tests 12s)",
                            }[change]
                with patch.object(self.github, "request", side_effect=request):
                    self.assertEqual(self.run_cli(recurring=False), 0)
                self.assertEqual(self.github.mutations, [])
                self.assertTrue(all(sample["diagnostic_reason"] for obs in self.report()["observations"] for sample in obs["samples"]))

    def test_real_five_owner_closed_shapes_remain_diagnostic_on_repeat(self):
        workflows = monitor.read_config(ROOT / ".github/ci-duration-monitor.json")
        self.github.sources = {str(path.relative_to(ROOT)): path.read_text() for path in (ROOT / ".github").rglob("*.yml")}
        for workflow in workflows:
            for family in workflow.families:
                for path in family.source_paths:
                    self.github.sources[path] = (ROOT / path).read_text()
        fixtures = json.loads((ROOT / "scripts/tests/fixtures/ci-duration/owner-closed.json").read_text())
        for row in fixtures:
            with self.subTest(issue=row["issue"]):
                workflow = next(item for item in workflows if any(re.fullmatch(f.job_pattern, row["name"]) for f in item.families)) if row["issue"] != 6003 else next(w for w in workflows if w.path.endswith("ci-test-container-build.yml"))
                template = job(row["job_id"], seconds={5998:708,5999:698,6000:603,6001:640,6003:657}[row["issue"]], name=row["name"], conclusion=row["conclusion"])
                # Preserve the exact native step timings and outcomes; move the
                # enclosing run timestamps into this deterministic scan window.
                template["steps"] = row["steps"]
                self.github.runs = [{**GitHub().runs[0], "path": workflow.path}]
                self.set_jobs([template])
                for jobs in self.github.jobs.values():
                    for item in jobs:
                        for step in item["steps"]:
                            seconds = monitor._seconds(step.get("started_at"), step.get("completed_at"))
                            if seconds is not None:
                                step.update(started_at=stamp(-seconds), completed_at=stamp())
                if row["issue"] == 6003:
                    for run in self.github.runs:
                        run.update(event="pull_request", head_branch="fix/direct-runner-apt-provenance")
                self.github.issues, self.github.calls = [], []
                for _ in range(2):
                    with patch.object(monitor, "logger"):
                        report = monitor.run_monitor(self.github, (workflow,), REPOSITORY, "b"*40, now=NOW, lookback_hours=48, publish=True)
                    self.assertEqual(report["actions"], [])
                    samples = [s for o in report["observations"] for s in o["samples"]]
                    self.assertEqual(len(samples), 2)
                    self.assertTrue(all(s["diagnostic_reason"] for s in samples))
                    self.assertTrue(all(s["steps"] for s in samples))
                self.assertEqual(self.github.mutations, [])
                # Identical later evidence must not restart an owner-closed family.
                observations, _ = monitor.collect(self.github, (workflow,), NOW.replace(day=19), monitor.CurrentSource(self.github, monitor._call, REPOSITORY))
                observed = next(o for o in observations if o.samples)
                self.github.issues = [{"number": row["issue"], "body": monitor._key(REPOSITORY, observed), "state": "closed", "closed_at": stamp(-1), "labels": [{"name": monitor.MANAGED_LABEL}]}]
                with patch.object(monitor, "logger"):
                    monitor.run_monitor(self.github, (workflow,), REPOSITORY, "b"*40, now=NOW, lookback_hours=48, publish=True)
                self.assertEqual(self.github.mutations, [])

    def test_manual_supported_native_work_opens_one_issue_and_new_regression_survives_closure(self):
        for run in self.github.runs:
            run["event"] = "workflow_dispatch"
        self.set_jobs([job(seconds=700)])
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(len(self.github.issues), 1)
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(len(self.github.mutations), 3)
        self.github.issues[0].update(state="closed", closed_at=stamp())
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(len(self.github.issues), 1)
        for run_id in [12, 13]:
            self.github.runs.append({**self.github.runs[0], "id": run_id})
            candidate = job(run_id, seconds=700)
            candidate["completed_at"] = stamp(run_id - 11)
            self.github.jobs[(run_id, 1)] = [candidate]
            self.assertEqual(self.run_cli(recurring=False, now=NOW + timedelta(seconds=3)), 0)
            self.assertEqual(len(self.github.issues), 1 if run_id == 12 else 2)
        self.assertEqual(self.github.issues[0]["state"], "closed")

    def test_common_dependency_acquisition_stays_one_shared_diagnostic(self):
        workflows = monitor.read_config(ROOT / ".github/ci-duration-monitor.json")
        selected = tuple(w for w in workflows if "ci-schedule-hosting-" in w.path)
        self.github.sources = {str(path.relative_to(ROOT)): path.read_text() for path in (ROOT / ".github").rglob("*.yml")}
        self.github.runs, self.github.jobs = [], {}
        for index, workflow in enumerate(selected):
            for family in workflow.families:
                for path in family.source_paths:
                    self.github.sources[path] = (ROOT / path).read_text()
            for offset in range(2):
                run_id = 10 + 2*index + offset
                self.github.runs.append({**GitHub().runs[0], "id": run_id, "path": workflow.path})
                candidate = job(run_id, 640, name=workflow.families[0].key)
                candidate["steps"] = [
                    {"name": "Install locked dependencies and emulator tools", "status": "completed", "conclusion": "success", "started_at": stamp(-595), "completed_at": stamp()},
                    {"name": "Verify real private Hosting and Functions boundary", "status": "completed", "conclusion": "success", "started_at": stamp(-34), "completed_at": stamp()},
                ]
                self.github.jobs[(run_id, 1)] = [candidate]
        with patch.object(monitor, "logger"):
            result = monitor.run_monitor(self.github, selected, REPOSITORY, "b"*40, now=NOW, lookback_hours=48, publish=True)
        self.assertEqual(result["actions"], [])
        self.assertEqual(len(result["shared_setup_diagnostics"]), 1)
        self.assertEqual(len(result["shared_setup_diagnostics"][0]["observations"]), 4)
        self.assertEqual(self.github.mutations, [])

    def test_current_real_main_and_manual_entrypoints_can_qualify(self):
        workflows = monitor.read_config(ROOT / ".github/ci-duration-monitor.json")
        sources = {str(path.relative_to(ROOT)): path.read_text() for path in (ROOT / ".github").rglob("*.yml")}
        for workflow in workflows:
            for family in workflow.families:
                for path in family.source_paths:
                    sources[path] = (ROOT / path).read_text()
        cases = [
            ("ci.yml", "unit-test / unit-test", "Run unit tests", "vitest"),
            ("ci-test-unit.yml", "unit-test", "Run unit tests", "vitest"),
            ("ci.yml", "e2e-test / e2e-test (basic)", "Run E2E tests (basic)", "playwright"),
            ("ci-test-e2e.yml", "e2e-test (firefox-selection-new)", "Run E2E tests (firefox-selection-new)", "playwright"),
        ]
        for filename, name, step, adapter in cases:
            with self.subTest(entrypoint=filename, job=name):
                self.github = GitHub()
                self.github.sources = sources
                workflow = next(w for w in workflows if w.path.endswith("/" + filename))
                self.github.runs[0].update(path=workflow.path, event="workflow_dispatch")
                candidate = job(seconds=700, name=name)
                candidate["steps"][0]["name"] = step
                self.set_jobs([candidate])
                for jobs in self.github.jobs.values():
                    for item in jobs:
                        self.github.logs[item["id"]] = (
                            "Test Files 20 passed (20)\n Tests 40 passed (40)\nDuration 700s (tests 650s)\n"
                            "Test Files 1 passed (1)\n Tests 1 passed (1)\nDuration 1s (tests 1s)" if adapter == "vitest" else
                            "✓ 1 [chromium] › first.spec.ts:1:1 › a (325s)\n✓ 2 [chromium] › second.spec.ts:1:1 › b (325s)\n2 passed (11m)"
                        )
                for _ in range(2):
                    with patch.object(monitor, "logger"):
                        result = monitor.run_monitor(self.github, (workflow,), REPOSITORY, "ignored-ref", now=NOW, lookback_hours=48, publish=True)
                    self.assertEqual(len(result["actions"]), 1)
                    self.assertEqual(len(self.github.issues), 1)
                    self.assertEqual(len(self.github.mutations), 3)
                    self.assertIn("blob/" + "b"*40, self.github.issues[0]["body"])

    def test_current_variant_still_qualifies_when_sibling_is_setup_dominated(self):
        self.set_jobs([job(seconds=700), job(2, seconds=900, name="Tests (2/4)")])
        for jobs in self.github.jobs.values():
            jobs[1]["steps"][0]["started_at"] = stamp(-40)
        self.assertEqual(self.run_cli(recurring=False), 0)
        self.assertEqual(len(self.github.issues), 1)
        self.assertIn("Tests (1/4)", self.github.issues[0]["body"])

    def test_retired_prototype_is_absent_even_on_default_branch_same_workflow(self):
        source = monitor.CurrentSource(self.github, monitor._call, REPOSITORY)
        workflows = monitor.read_config(ROOT / ".github/ci-duration-monitor.json")
        workflow = next(w for w in workflows if w.path.endswith("ci-test-container-build.yml"))
        self.github.sources[workflow.path] = (ROOT / workflow.path).read_text()
        fallback = monitor.Family("retired", "retired", ".*", ".*", (workflow.path,), "diagnostic")
        reason = source.reason(workflow, fallback, self.github.runs[0], "Prepared runtime smoke (not E2E migration)")
        self.assertEqual(reason, "job/variant is absent from the current active workflow")

    def test_legacy_pending_submission_cannot_bypass_policy(self):
        self.assertEqual(self.run_cli(), 0)
        self.github.issues[0]["body"] = self.github.issues[0]["body"].replace("<!-- ci-duration-policy:v2:recurring-native-tests:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->", "")
        self.github.issues[0]["labels"] = [{"name": monitor.MANAGED_LABEL}]
        self.github.events = {}
        self.github.runs = []
        self.github.calls = []
        self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])

    def test_retained_receipt_cannot_submit_after_default_source_changes(self):
        self.github.reject_before = "issues/1/labels"
        self.assertEqual(self.run_cli(), 1)
        self.github.runs, self.github.calls = [], []
        original = self.github.request
        def moved(method, path, payload=None):
            if path == "branches/main":
                return Result(200, {"commit": {"sha": "c"*40}})
            return original(method, path, payload)
        with patch.object(self.github, "request", side_effect=moved):
            self.assertEqual(self.run_cli(), 0)
        self.assertEqual(self.github.mutations, [])

    def test_native_reporters_reject_harness_and_accept_independent_tests(self):
        self.assertEqual(native_tests("Test Files 2 passed (2)\n Tests 3 passed (3)\nDuration 700s (setup 650s, tests 34s)", "vitest"), (34, 2))
        log = "✓ 1 [chromium] › first.spec.ts:1:1 › a (310s)\n✓ 2 [chromium] › second.spec.ts:1:1 › b (310s)\n2 passed (11m)"
        self.assertEqual(native_tests(log, "playwright"), (620, 2))
        self.assertEqual(native_tests("2026-11-21T00:00:00.000Z " + log.replace("a (310s)", "failed request handling (310s)"), "playwright"), (620, 2))
        self.assertIsNone(native_tests(log + " 1 flaky", "playwright"))
        self.assertIsNone(native_tests(log.replace("second.spec.ts", "first.spec.ts"), "playwright"))


if __name__ == "__main__":
    unittest.main()
