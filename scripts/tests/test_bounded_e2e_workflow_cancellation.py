"""Cancel the actual Bash entry PID through npm and real Playwright workers."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from bounded_e2e_workflow_fixture import prepare, workflow_job


def descendants(pid):
    rows = subprocess.run(['ps', '-eo', 'pid=,ppid='], check=True, capture_output=True,
                          text=True).stdout.splitlines()
    parents = dict(tuple(map(int, row.split())) for row in rows)
    owned = {pid}
    while True:
        children = {child for child, parent in parents.items() if parent in owned} - owned
        if not children:
            return owned - {pid}
        owned.update(children)


class WorkflowCancellationTest(unittest.TestCase):
    def run_case(self, signum=None):
        with tempfile.TemporaryDirectory(prefix='e2e-workflow-cancel-') as directory:
            root = Path(directory)
            env = prepare(root, signum is not None)
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
            owned = set()
            with (root / 'console.log').open('w') as console:
                entry = subprocess.Popen(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', 'step.sh'],
                                         cwd=root, env=env, stdout=console, stderr=subprocess.STDOUT,
                                         start_new_session=True)
                try:
                    if signum is not None:
                        ready = root / 'client/owned.json'
                        deadline = time.monotonic() + 20
                        while not ready.exists() and entry.poll() is None and time.monotonic() < deadline:
                            time.sleep(.02)
                        self.assertTrue(ready.exists(), (root / 'console.log').read_text())
                        owned = descendants(entry.pid) | set(json.loads(ready.read_text()))
                        self.assertGreaterEqual(len(owned), 3, 'real npm/Playwright process stack missing')
                        started = time.monotonic()
                        # GitHub signals this original PID, not its descendant tree.
                        os.kill(entry.pid, signum)
                        entry.wait(timeout=7.5)
                        self.assertLess(time.monotonic() - started, 7.5)
                    else:
                        entry.wait(timeout=20)
                    output = (root / 'console.log').read_text()
                    status = json.loads((root / 'job_logs/new-3b-command-status.json').read_text())
                    expected = 128 + signum if signum is not None else 0
                    self.assertEqual(entry.returncode, expected, output)
                    self.assertEqual(status['exit_code'], expected, output)
                    self.assertEqual(status['remaining_processes'], [])
                    self.assertEqual(status['status'], 'interrupted' if signum is not None else 'passed')
                    self.assertIn('startup_verified=true', (root / 'outputs').read_text())
                    self.assertIsNone(unrelated.poll(), 'cleanup touched an unrelated process')
                    self.assertTrue((root / 'job_logs/new-3b-command-status.supervisor.jsonl').is_file())
                    if signum is not None:
                        self.assertEqual(status['received_signal'], signum)
                        self.assertIn('NATIVE_TEST_READY', output)
                        for pid in owned:
                            with self.assertRaises(ProcessLookupError, msg=f'owned process {pid} survived'):
                                os.kill(pid, 0)
                    else:
                        self.assertEqual(status['test_counts']['expected'], 1)
                        self.assertEqual(status['test_counts']['skipped'], 0)
                finally:
                    if entry.poll() is None:
                        owned.update(descendants(entry.pid))
                        entry.terminate()
                        try:
                            entry.wait(timeout=7.5)
                        except subprocess.TimeoutExpired:
                            entry.kill()
                            entry.wait()
                    for pid in owned:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    unrelated.terminate()
                    unrelated.wait()

    def test_real_workflow_success(self):
        self.run_case()

    def test_sigint_to_original_entry_pid_cleans_detached_worker_child(self):
        self.run_case(signal.SIGINT)

    def test_sigterm_to_original_entry_pid_cleans_detached_worker_child(self):
        self.run_case(signal.SIGTERM)

    def test_workflow_preserves_failure_gates_and_bounds_finalization(self):
        job = workflow_job()
        self.assertEqual(job['timeout-minutes'], 45)
        self.assertFalse(job['strategy']['fail-fast'])
        steps = {step['name']: step for step in job['steps']}
        tests = next(step for step in job['steps'] if step.get('id') == 'tests')
        self.assertEqual(tests['timeout-minutes'], 23)
        self.assertFalse(tests.get('continue-on-error', False))
        self.assertEqual(tests['run'].count('exec python3 ../scripts/ci/run-bounded-e2e.py'), 3)
        self.assertEqual(tests['run'].count('--timeout-seconds=1200 --job-budget-seconds=1320'), 3)
        for name in ('Verify startup evidence', 'Record setup and execution status'):
            self.assertEqual(steps[name]['timeout-minutes'], 1)
            self.assertEqual(steps[name]['if'], 'always()')
            self.assertFalse(steps[name].get('continue-on-error', False))
        for name in ('Upload Logs & Artifacts', 'Upload safe startup diagnostics'):
            self.assertEqual(steps[name]['timeout-minutes'], 3)
            self.assertFalse(steps[name].get('continue-on-error', False))
        self.assertIn('cancelled()', steps['Upload Logs & Artifacts']['if'])
        self.assertIn("steps.tests.outputs.startup_verified == 'true'", steps['Upload Logs & Artifacts']['if'])
        self.assertIn("steps.tests.outputs.startup_verified != 'true'", steps['Upload safe startup diagnostics']['if'])


if __name__ == '__main__':
    unittest.main()
