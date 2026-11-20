"""Execute the actual normal workflow command with isolated real processes."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


class StartupWorkflowTest(unittest.TestCase):
    def run_case(self, mode, project='core-8', expired=False, artifact_check=None):
        with tempfile.TemporaryDirectory(prefix='all-shard-startup-') as directory:
            root = Path(directory)
            (root / 'job_logs').mkdir()
            (root / 'scripts/ci').mkdir(parents=True)
            started = datetime.now(timezone.utc) - timedelta(seconds=61 if expired else 0)
            (root / 'job_logs/execution-context.json').write_text(json.dumps({
                'startedAt': started.isoformat(), 'executionId': 'fixture-1', 'project': project,
            }))
            for name in ('run-bounded-e2e.py', 'verify-startup-evidence.py'):
                (root / 'scripts/ci' / name).symlink_to(ROOT / 'scripts/ci' / name)
            wrapper = (ROOT / 'scripts/ci/run-e2e-startup.sh').read_text()
            self.assertIn('--timeout-seconds=360 --job-budget-seconds=1320 --grace-seconds=10', wrapper)
            wrapper = wrapper.replace('--timeout-seconds=360', '--timeout-seconds=2')
            wrapper = wrapper.replace('--job-budget-seconds=1320', '--job-budget-seconds=60')
            wrapper = wrapper.replace('--grace-seconds=10', '--grace-seconds=0.15')
            (root / 'scripts/ci/run-e2e-startup.sh').write_text(wrapper)
            fixture = ROOT / 'scripts/tests/fixtures/bounded-startup'
            (root / 'scripts/ci-e2e-start.sh').symlink_to(fixture / 'start.sh')
            (root / 'scripts/control.py').symlink_to(fixture / 'control.py')
            # Seed a previous execution's completion. Production must replace it.
            marker = root / f'job_logs/{project}-startup-completed.json'
            marker.write_text('{"status":"completed"}')
            os.utime(marker, (1, 1))
            workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
            block = workflow.split('      - name: Run E2E-specific startup (services + readiness)')[1]
            command = textwrap.dedent(block.split('        run: |\n')[1].split('        env:')[0])
            self.assertIn('bash scripts/ci/run-e2e-startup.sh', command)
            tests = workflow.split('      - name: Run E2E tests (${{ matrix.project }})')[1]
            self.assertLess(tests.index('verify-startup-evidence.py --require-success'), tests.index('cd client'))
            command += '\npython3 scripts/ci/verify-startup-evidence.py --require-success\ntouch launched\n'
            sentinel = 'SYNTHETIC_SECRET_' + uuid.uuid4().hex
            env = {**os.environ, 'E2E_PROJECT': project, 'E2E_EXECUTION_ID': 'fixture-1',
                   'CONTROL_MODE': mode, 'SECRET_SENTINEL': sentinel,
                   'WRITE_SERVICE_FILES': '1' if artifact_check else ''}
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
            wall_started = time.time()
            before = time.monotonic()
            try:
                result = subprocess.run(['bash', '-euo', 'pipefail', '-c', command], cwd=root,
                                        env=env, capture_output=True, text=True, timeout=10)
                elapsed = time.monotonic() - before
                expected = 124 if expired or mode in ('pre', 'post', 'late') else 7 if mode == 'failure' else 0
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assertNotIn(sentinel, result.stdout + result.stderr)
                self.assertIsNone(unrelated.poll(), 'cleanup touched an unrelated process')
                record = json.loads((root / f'job_logs/{project}-startup-status.json').read_text())
                self.assertEqual(record['exit_code'], expected)
                self.assertEqual(record['shard'], project)
                self.assertEqual(record['execution_id'], 'fixture-1')
                self.assertAlmostEqual(record['elapsed_seconds'], elapsed, delta=.5)
                self.assertEqual((root / 'launched').exists(), expected == 0)
                self.assertEqual((root / 'ready').exists(), not expired and mode not in ('pre', 'failure'))
                self.assertEqual(marker.exists(), expected == 0)
                self.assertLess(elapsed, 3.5)
                if not expired:
                    self.assertEqual(int((root / 'attempts').read_text()), 2 if mode in ('recover', 'late', 'failure') else 1)
                else:
                    self.assertFalse((root / 'attempts').exists())
                if mode in ('pre', 'post', 'late') and not expired:
                    self.assertGreater(elapsed, 1.9)
                    self.assertLess(elapsed, 2.7)
                    self.assertLessEqual(record['budget_seconds'], 2)
                    self.assertEqual(record['phase'], 'pre_readiness' if mode == 'pre' else 'post_readiness')
                if mode == 'recover':
                    self.assertGreater(elapsed, .7)
                    self.assertLess(elapsed, 2)
                if expected:
                    self.assertEqual(record.get('remaining_processes', []), [])
                # Run the shipped always() evidence check even after failure.
                check = subprocess.run([sys.executable, 'scripts/ci/verify-startup-evidence.py'],
                                       cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
                for path in (root / 'job_logs').iterdir():
                    self.assertNotIn(sentinel, path.read_text())
                    if path.name != 'execution-context.json':
                        self.assertGreaterEqual(path.stat().st_mtime, wall_started)
                self.assertIn('elapsed_seconds', record)
                self.assertIn('attempt', record)
                pids = [int(pid) for pid in (root / 'owned.pids').read_text().split()] if not expired else []
                for pid in pids:
                    if expected:
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pid, 0)
                    else:
                        self.assertIn(pid, [row['pid'] for row in record['retained_service_processes']])
                        os.kill(pid, 0)
                if artifact_check:
                    artifact_check(root, env, sentinel, expected)
            finally:
                unrelated.terminate()
                unrelated.wait()
                if (root / 'owned.pids').exists():
                    for pid in (root / 'owned.pids').read_text().split():
                        try:
                            os.kill(int(pid), signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_normal_pre_readiness_stall(self):
        self.run_case('pre')

    def test_normal_post_readiness_stall(self):
        self.run_case('post')

    def test_retry_completes_inside_original_deadline(self):
        self.run_case('recover')

    def test_retry_does_not_renew_deadline(self):
        self.run_case('late')

    def test_exhausted_job_relative_budget_does_not_launch(self):
        self.run_case('success', expired=True)

    def test_utils_regression_success_failure_and_stall(self):
        for mode in ('success', 'failure', 'pre'):
            self.run_case(mode, 'utils')


if __name__ == '__main__':
    unittest.main()
