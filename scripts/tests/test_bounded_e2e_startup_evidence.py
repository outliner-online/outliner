"""Collected bounded-E2E regressions for the shipped utils evidence check."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UtilsEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='utils-evidence-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.logs = self.root / 'job_logs'
        self.logs.mkdir()
        # Other upload inputs must not disguise missing startup diagnostics.
        (self.logs / 'execution-context.json').write_text('{}')
        (self.root / 'scripts/ci').mkdir(parents=True)
        (self.root / 'scripts/ci/verify-utils-startup-evidence.py').symlink_to(
            ROOT / 'scripts/ci/verify-utils-startup-evidence.py')

    def record(self, status='passed', started=True):
        value = {'status': status, 'command_started': started,
                 'exit_code': 0 if status == 'passed' else 124}
        if status == 'passed':
            value['startup_completed'] = True
            (self.logs / 'utils-startup-completed.json').write_text('{"status":"completed"}')
        (self.logs / 'utils-startup-status.json').write_text(json.dumps(value))
        if started:
            (self.logs / 'setup-services-utils.log').write_text('real command output\n')

    def check(self, expected):
        workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
        block = workflow.split('      - name: Verify utils startup evidence\n')[1]
        self.assertIn("if: always() && matrix.project == 'utils'", block.split('        run: |')[0])
        self.assertLess(workflow.index('      - name: Verify utils startup evidence'),
                        workflow.index('      - name: Upload Logs & Artifacts'))
        script = textwrap.dedent(block.split('        run: |\n')[1].split('\n      - name:')[0])
        result = subprocess.run(['bash', '-euo', 'pipefail', '-c', script], cwd=self.root,
                                env=os.environ.copy(), capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        result_record = json.loads((self.logs / 'utils-startup-evidence.json').read_text())
        self.assertEqual(result_record['status'], 'available' if expected == 0 else 'missing_or_invalid')
        return result_record

    def test_success_requires_status_output_and_completion(self):
        self.record()
        self.check(0)

    def test_failure_preserves_evidence_without_requiring_success_marker(self):
        self.record('timed_out')
        self.check(0)
        record = json.loads((self.logs / 'utils-startup-status.json').read_text())
        self.assertEqual(record['exit_code'], 124)

    def test_not_started_reports_output_unavailable_without_inventing_it(self):
        self.record('not_started', started=False)
        result = self.check(0)
        self.assertEqual(result['output'], 'not_produced_command_not_started')
        self.assertFalse((self.logs / 'setup-services-utils.log').exists())

    def test_missing_status_is_not_hidden_by_other_upload_inputs(self):
        self.record()
        (self.logs / 'utils-startup-status.json').unlink()
        self.assertIn('utils-startup-status.json', ' '.join(self.check(1)['errors']))

    def test_missing_output_is_not_hidden_by_other_upload_inputs(self):
        self.record('failed')
        (self.logs / 'setup-services-utils.log').unlink()
        self.assertIn('setup-services-utils.log', ' '.join(self.check(1)['errors']))

    def test_missing_completion_cannot_be_claimed_available(self):
        self.record()
        (self.logs / 'utils-startup-completed.json').unlink()
        self.assertIn('utils-startup-completed.json', ' '.join(self.check(1)['errors']))

    def test_invalid_status_cannot_be_claimed_available(self):
        self.record()
        (self.logs / 'utils-startup-status.json').write_text('not JSON')
        self.check(1)

    def test_incomplete_execution_outcome_is_not_available(self):
        self.record()
        (self.logs / 'utils-startup-status.json').write_text(json.dumps({
            'status': 'running', 'command_started': True, 'exit_code': 1,
        }))
        self.check(1)


if __name__ == '__main__':
    unittest.main()
