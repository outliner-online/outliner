"""Real process controls for the explicit startup-completion validator."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'ci/run-bounded-e2e.py'


class StartupCompletionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='startup-completion-')
        self.root = Path(self.temp.name)
        self.marker = self.root / 'completed.json'
        (self.root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))

    def tearDown(self):
        self.temp.cleanup()

    def run_code(self, code, timeout=3):
        (self.root / 'startup.log').unlink(missing_ok=True)
        result = subprocess.run([
            sys.executable, str(RUNNER), '--context', str(self.root / 'context.json'),
            '--status', str(self.root / 'status.json'), '--log', str(self.root / 'startup.log'),
            '--startup-completion', str(self.marker), '--timeout-seconds', str(timeout),
            '--job-budget-seconds', '60', '--grace-seconds', '0.15',
            '--', sys.executable, '-u', '-c', code,
        ], cwd=self.root, capture_output=True, text=True, timeout=10)
        self.status = json.loads((self.root / 'status.json').read_text())
        return result

    def test_completed_command_and_original_nonzero_are_preserved(self):
        for code in [0, 7]:
            with self.subTest(code=code):
                result = self.run_code(
                    "from pathlib import Path; Path('completed.json').write_text('{\"status\":\"completed\"}'); "
                    f"print('real startup output',flush=True); raise SystemExit({code})"
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(self.status['child_exit_code'], code)
                self.assertEqual(self.status['status'], 'passed' if code == 0 else 'failed')
                self.assertEqual((self.root / 'startup.log').read_text(), 'real startup output\n')
                self.assertEqual(self.status['remaining_processes'], [])

    def test_zero_exit_with_missing_stale_or_invalid_marker_cannot_pass(self):
        for kind in ['missing', 'stale', 'invalid', 'wrong state']:
            with self.subTest(kind=kind):
                self.marker.unlink(missing_ok=True)
                code = "print('returned without proving completion')"
                if kind == 'stale':
                    self.marker.write_text('{"status":"completed"}')
                elif kind in ['invalid', 'wrong state']:
                    content = 'invalid JSON' if kind == 'invalid' else '{"status":"starting"}'
                    code = f"from pathlib import Path; Path('completed.json').write_text({content!r})"
                result = self.run_code(code)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertEqual(self.status['status'], 'supervisor_failed')

    def test_timeout_cannot_pass_even_if_term_writes_completed_and_exits_zero(self):
        result = self.run_code(
            "import signal,time,sys; from pathlib import Path; "
            "signal.signal(signal.SIGTERM, lambda *_: "
            "(Path('completed.json').write_text('{\"status\":\"completed\"}'),sys.exit(0))); "
            "print('before stuck initialization',flush=True);time.sleep(60)", timeout=0.4
        )
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertEqual(self.status['child_exit_code'], 0)
        self.assertEqual(self.status['status'], 'timed_out')
        self.assertEqual(self.status['remaining_processes'], [])
        self.assertIn('before stuck initialization', (self.root / 'startup.log').read_text())

    def test_missing_marker_does_not_hand_off_live_services(self):
        result = self.run_code(
            "import subprocess,sys;from pathlib import Path; "
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True); "
            "Path('pid').write_text(str(child.pid))"
        )
        self.assertEqual(result.returncode, 125, result.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.root / 'pid').read_text()), 0)

    def test_completed_startup_hands_live_services_to_the_e2e_step(self):
        result = self.run_code(
            "import subprocess,sys;from pathlib import Path; "
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True); "
            "Path('pid').write_text(str(child.pid)); "
            "Path('completed.json').write_text('{\"status\":\"completed\"}')"
        )
        pid = int((self.root / 'pid').read_text())
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(self.status['startup_completed'])
            self.assertIn(pid, [row['pid'] for row in self.status['retained_service_processes']])
            self.assertEqual(self.status['remaining_processes'], self.status['retained_service_processes'])
            os.kill(pid, 0)
        finally:
            os.kill(pid, 9)


if __name__ == '__main__':
    unittest.main()
