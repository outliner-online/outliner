"""Execute the shipped Bash startup boundary with real controlled processes.

These controls test supervision/exit propagation, not application readiness.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StartupWorkflowTest(unittest.TestCase):
    def run_case(self, mode, project='utils'):
        with tempfile.TemporaryDirectory(prefix='utils-startup-workflow-') as directory:
            root = Path(directory)
            (root / 'job_logs').mkdir()
            (root / 'scripts/ci').mkdir(parents=True)
            (root / 'job_logs/execution-context.json').write_text(json.dumps({
                'startedAt': datetime.now(timezone.utc).isoformat(),
            }))
            (root / 'scripts/ci/run-bounded-e2e.py').symlink_to(ROOT / 'scripts/ci/run-bounded-e2e.py')
            # A real executable deliberately succeeds, fails or hangs. No app,
            # Firebase response, readiness result or process API is mocked.
            code = """
                import os,sys,subprocess,time
                from pathlib import Path
                p=Path('attempts');n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n))
                print('STARTUP_PHASE_'+str(n),flush=True)
                mode=os.environ['CONTROL_MODE']
                if mode=='hang':
                    c=subprocess.Popen([sys.executable,'-c',
                        'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],
                        start_new_session=True)
                    Path('detached.pid').write_text(str(c.pid))
                    time.sleep(60)
                if mode=='failure' or (mode=='recover' and n==1):sys.exit(7)
            """
            (root / 'scripts/ci-e2e-start.sh').write_text(
                'exec ' + sys.executable + " -u - <<'PY'\n" + textwrap.dedent(code) + '\nPY\n'
            )
            workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
            block = workflow.split('      - name: Run E2E-specific startup (services + readiness)')[1]
            script = textwrap.dedent(block.split('        run: |\n')[1].split('        env:')[0])
            self.assertIn('--timeout-seconds=360 --job-budget-seconds=1320 --grace-seconds=10', script)
            script = script.replace('--timeout-seconds=360', '--timeout-seconds=2')
            script = script.replace('--job-budget-seconds=1320', '--job-budget-seconds=60')
            script = script.replace('--grace-seconds=10', '--grace-seconds=0.15')
            result = subprocess.run(['bash', '-c', script], cwd=root,
                                    env={**os.environ, 'E2E_PROJECT': project, 'CONTROL_MODE': mode},
                                    capture_output=True, text=True, timeout=12)
            expected = {'success': 0, 'recover': 0, 'failure': 7, 'hang': 124}[mode]
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            self.assertEqual(int((root / 'attempts').read_text()), 2 if mode in ['recover', 'failure'] else 1)
            self.assertIn('STARTUP_PHASE_1', (root / 'job_logs/setup-services-1.log').read_text())
            marker = root / 'job_logs/utils-startup-completed.json'
            status = root / 'job_logs/utils-startup-status.json'
            if project != 'utils':
                self.assertFalse(status.exists())
                self.assertFalse(marker.exists())
                return
            record = json.loads(status.read_text())
            self.assertEqual(record['exit_code'], expected)
            self.assertEqual(record['remaining_processes'], [])
            self.assertEqual(marker.exists(), expected == 0)
            self.assertIn('STARTUP_PHASE_1', (root / 'job_logs/setup-services-utils.log').read_text())
            if mode == 'hang':
                self.assertEqual(record['status'], 'timed_out')
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((root / 'detached.pid').read_text()), 0)

    def test_utils_success(self):
        self.run_case('success')

    def test_existing_single_retry_and_success_remain(self):
        self.run_case('recover')

    def test_two_original_failures_stay_nonzero(self):
        self.run_case('failure')

    def test_stuck_startup_keeps_logs_reaps_child_and_cannot_pass(self):
        self.run_case('hang')

    def test_other_shards_keep_original_success_and_failure_path(self):
        self.run_case('success', 'new-1')
        self.run_case('failure', 'new-1')


if __name__ == '__main__':
    unittest.main()
