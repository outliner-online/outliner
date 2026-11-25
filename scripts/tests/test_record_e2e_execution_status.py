import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
RECORDER = ROOT / "scripts/ci/record-e2e-execution-status.mjs"
WORKFLOW = ROOT / ".github/workflows/ci-test-e2e.yml"


class RecordE2EExecutionStatusTest(unittest.TestCase):
    def environment(self):
        return {
            **os.environ,
            "E2E_BROWSER": "chromium",
            "E2E_BROWSER_RUNTIME_REPORT": "",
            "E2E_JOB_STATUS": "failure",
            "E2E_STEP_OUTCOMES": json.dumps({"tests": {"outcome": "failure"}}),
        }

    def test_actual_recorder_completes_and_preserves_non_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "job_logs").mkdir()
            (root / "job_logs/execution-context.json").write_text(
                json.dumps({"project": "tables-2"})
            )

            result = subprocess.run(
                ["node", str(RECORDER)], cwd=root, env=self.environment(),
                text=True, capture_output=True, timeout=5,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads((root / "job_logs/execution-context.json").read_text())
            self.assertEqual(record["status"], "failure")
            self.assertEqual(record["steps"]["tests"]["outcome"], "failure")
            self.assertIn("finishedAt", record)

    def test_blocked_runtime_evidence_is_interrupted_and_non_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "job_logs").mkdir()
            runtime = root / "blocked-runtime-report"
            os.mkfifo(runtime)
            environment = self.environment()
            environment["E2E_BROWSER_RUNTIME_REPORT"] = str(runtime)

            result = subprocess.run(
                ["timeout", "--signal=TERM", "--kill-after=1s", "0.2s", "node", str(RECORDER)],
                cwd=root, env=environment, text=True, capture_output=True, timeout=3,
            )

            self.assertEqual(result.returncode, 124, result.stderr)

    def test_workflow_bounds_the_actual_recorder_before_artifact_upload(self):
        workflow = WORKFLOW.read_text()
        record = workflow.index("- name: Record setup and execution status")
        upload = workflow.index("- name: Upload Logs & Artifacts", record)
        step = workflow[record:upload]

        self.assertIn("set -euo pipefail", step)
        self.assertIn("timeout --signal=TERM --kill-after=5s 30s", step)
        self.assertIn("node scripts/ci/record-e2e-execution-status.mjs", step)


if __name__ == "__main__":
    unittest.main()
