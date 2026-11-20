"""Regression controls for the actual all-shard startup evidence gate."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StartupEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='startup-evidence-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.logs = self.root / 'job_logs'
        self.logs.mkdir()
        self.start = datetime.now(timezone.utc) - timedelta(seconds=1)
        (self.logs / 'execution-context.json').write_text(json.dumps({
            'startedAt': self.start.isoformat(), 'executionId': 'fixture-1', 'project': 'core-8',
        }))
        self.status = self.logs / 'core-8-startup-status.json'
        self.output = self.logs / 'setup-services-core-8.log'
        self.marker = self.logs / 'core-8-startup-completed.json'
        self.value = dict(status='passed', command_started=True, exit_code=0, child_exit_code=0,
                          phase='completion', attempt=1, elapsed_seconds=.5,
                          updated_at=datetime.now(timezone.utc).isoformat(), shard='core-8',
                          execution_id='fixture-1', nonce='unique', startup_completed=True,
                          remaining_processes=[])
        self.marker.write_text(json.dumps(dict(status='completed', shard='core-8',
                                              execution_id='fixture-1', nonce='unique')))

    def check(self, expected, require_success=False):
        workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
        block = workflow.split('      - name: Verify startup evidence\n')[1]
        self.assertIn('if: always()', block.split('        run: |')[0])
        self.assertLess(workflow.index('      - name: Verify startup evidence'),
                        workflow.index('      - name: Upload Logs & Artifacts'))
        command = [sys.executable, str(ROOT / 'scripts/ci/verify-startup-evidence.py')]
        if require_success:
            command.append('--require-success')
        result = subprocess.run(command, cwd=self.root, env={**os.environ,
                                'E2E_PROJECT': 'core-8', 'E2E_EXECUTION_ID': 'fixture-1'},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        evidence = json.loads((self.logs / 'core-8-startup-evidence.json').read_text())
        self.assertEqual(evidence['status'], 'available' if expected == 0 else 'missing_or_invalid')

    def write(self):
        for path in (self.status, self.output):
            path.write_text(json.dumps(self.value))

    def test_success_requires_current_completion_and_diagnostics(self):
        self.write()
        self.check(0, True)
        for path in (self.marker, self.status, self.output):
            data = path.read_text()
            path.unlink()
            self.check(1, True)
            path.write_text(data)

    def test_failure_evidence_available_but_cannot_launch(self):
        self.value.update(status='timed_out', exit_code=124, phase='readiness')
        self.value.pop('startup_completed')
        self.marker.unlink()
        self.write()
        self.check(0)
        self.check(1, True)

    def test_wrong_identity_nonce_stale_and_invalid_evidence_cannot_launch(self):
        for field, value in [('shard', 'utils'), ('execution_id', 'old-run'), ('nonce', 'old-nonce'),
                             ('updated_at', '2000-01-01T00:00:00+00:00'),
                             ('phase', 'unverified'), ('attempt', 3), ('elapsed_seconds', float('nan')),
                             ('error', 'SYNTHETIC_SECRET'), ('unknown', 'SYNTHETIC_SECRET')]:
            with self.subTest(field=field):
                original = self.value.copy()
                self.value[field] = value
                self.write()
                self.check(1, True)
                self.value = original
        self.write()
        os.utime(self.status, (1, 1))
        self.check(1, True)
        self.write()
        self.marker.write_text('not JSON')
        self.check(1, True)

    def test_failed_cleanup_cannot_launch(self):
        self.value.update(status='cleanup_failed', exit_code=125,
                          remaining_processes=[dict(pid=123, ppid=1, state='S')])
        self.value.pop('startup_completed')
        self.write()
        self.check(0)
        self.check(1, True)


if __name__ == '__main__':
    unittest.main()
