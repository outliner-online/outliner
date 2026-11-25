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
    def environment(self, status="success"):
        return {
            **os.environ,
            "E2E_BROWSER": "chromium",
            "E2E_BROWSER_RUNTIME_REPORT": "",
            "E2E_JOB_STATUS": status,
            "E2E_STEP_OUTCOMES": json.dumps({"tests": {"outcome": status}}),
        }

    def workflow_status_command(self, timeout="30s"):
        workflow = WORKFLOW.read_text()
        record = workflow.index("- name: Record setup and execution status")
        upload = workflow.index("- name: Upload Logs & Artifacts", record)
        step = workflow[record:upload]
        command = step.split("        run: |\n", 1)[1]
        command = "\n".join(line[10:] for line in command.splitlines())
        command = command.replace("30s", timeout)
        command = command.replace(
            "node scripts/ci/record-e2e-execution-status.mjs",
            f"node {RECORDER}",
        )
        return command, step

    def new3_gate_command(self):
        workflow = WORKFLOW.read_text()
        gate = workflow.split("  new-3-complete:", 1)[1].split("  new-2-complete:", 1)[0]
        return gate.split("run: ", 1)[1].splitlines()[0]

    def test_actual_workflow_step_completes_and_required_check_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "job_logs").mkdir()
            (root / "job_logs/execution-context.json").write_text(
                json.dumps({"project": "tables-2"})
            )

            command, _ = self.workflow_status_command()
            result = subprocess.run(
                ["bash", "-c", command], cwd=root, env=self.environment(),
                text=True, capture_output=True, timeout=5,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads((root / "job_logs/execution-context.json").read_text())
            self.assertEqual(record["status"], "success")
            self.assertEqual(record["steps"]["tests"]["outcome"], "success")
            self.assertIn("finishedAt", record)

            gate = subprocess.run(
                ["bash", "-c", self.new3_gate_command()],
                env={**os.environ, "E2E_RESULT": "success"},
            )
            self.assertEqual(gate.returncode, 0)

    def test_blocked_workflow_step_and_required_check_are_non_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "job_logs").mkdir()
            runtime = root / "blocked-runtime-report"
            os.mkfifo(runtime)
            environment = self.environment()
            environment["E2E_BROWSER_RUNTIME_REPORT"] = str(runtime)

            command, _ = self.workflow_status_command(timeout="0.2s")
            result = subprocess.run(
                ["bash", "-c", command],
                cwd=root, env=environment, text=True, capture_output=True, timeout=3,
            )

            self.assertEqual(result.returncode, 124, result.stderr)

            gate = subprocess.run(
                ["bash", "-c", self.new3_gate_command()],
                env={**os.environ, "E2E_RESULT": "failure"},
            )
            self.assertNotEqual(gate.returncode, 0)

    def test_workflow_bounds_the_actual_recorder_before_artifact_upload(self):
        _, step = self.workflow_status_command()

        self.assertIn("set -euo pipefail", step)
        self.assertIn("timeout --signal=TERM --kill-after=5s 30s", step)
        self.assertIn("node scripts/ci/record-e2e-execution-status.mjs", step)


if __name__ == "__main__":
    unittest.main()
