"""Exercise the shipped new-3 outer deadline after its child has already exited."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'scripts/ci/run-bounded-e2e.py'


class New3WatchdogTest(unittest.TestCase):
    def command(self, root, project, code):
        workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
        branch = workflow.split('elif [[ "$project" =~ ^new-3[ab]$ ]]; then', 1)[1].split('elif ', 1)[0]
        tokens = shlex.split(branch.replace('\\\n', ' '), comments=True)
        self.assertEqual(tokens.pop(0), 'PLAYWRIGHT_HTML_OPEN=never')
        separator = tokens.index('--')
        prefix, native = tokens[:separator], tokens[separator + 1:]
        self.assertEqual([value.replace('$project', project) for value in native], [
            'npm', 'run', 'github:test:e2e', '--', '--project=' + project, '--reporter=line,json,html',
        ])
        for value in ('--timeout-seconds=1200', '--job-budget-seconds=1320', '--grace-seconds=10'):
            self.assertIn(value, prefix)
        if prefix[0] == 'timeout':
            self.assertEqual(prefix[:6], ['timeout', '--signal=TERM', '--kill-after=10s', '1320s',
                                          'python3', '../scripts/ci/run-bounded-e2e.py'])
        else:
            # Execute the old command too, so removing the watchdog reproduces
            # the actual blocking read instead of failing only a text assertion.
            self.assertEqual(prefix[:2], ['python3', '../scripts/ci/run-bounded-e2e.py'])
        substitutions = {
            '--kill-after=10s': '--kill-after=0.25s',
            '1320s': '1.5s',
            'python3': sys.executable,
            '../scripts/ci/run-bounded-e2e.py': str(RUNNER),
            '--context=../job_logs/execution-context.json': '--context=' + str(root / 'context.json'),
            '--status=../job_logs/${project}-command-status.json': '--status=' + str(root / 'status.json'),
            '--log=../job_logs/e2e-${E2E_BROWSER}-${project}-${E2E_EXECUTION_ID}.log': '--log=' + str(root / 'command.log'),
            '--report=${PLAYWRIGHT_JSON_OUTPUT_NAME}': '--report=' + str(root / 'report.json'),
            '--timeout-seconds=1200': '--timeout-seconds=0.5',
            '--job-budget-seconds=1320': '--job-budget-seconds=60',
            '--grace-seconds=10': '--grace-seconds=0.1',
        }
        actual = [substitutions.get(value, value) for value in prefix]
        self.assertFalse(any('$' in value for value in actual))
        return [*actual, '--', sys.executable, '-u', '-c', code]

    def run_probe(self, mode, project='new-3b', exit_code=0):
        with tempfile.TemporaryDirectory(prefix='new3-watchdog-') as directory:
            root = Path(directory)
            (root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))
            report = {
                'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
                'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}],
            }
            child_pid = root / 'child.pid'
            result_path = root / 'report.json'
            write_report = (f'os.mkfifo({str(result_path)!r})' if mode == 'fifo' else
                            f'Path({str(result_path)!r}).write_text({json.dumps(report)!r})')
            code = (
                'import os; from pathlib import Path; '
                f'Path({str(child_pid)!r}).write_text(str(os.getpid())); '
                + write_report + '; '
                "print('CONTROLLED_CHILD_COMPLETED', flush=True); "
                f'raise SystemExit({exit_code})'
            )
            process = subprocess.Popen(self.command(root, project, code), cwd=root,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, start_new_session=True,
                                       env={**os.environ, 'PLAYWRIGHT_HTML_OPEN': 'never'})
            before = time.monotonic()
            try:
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    state = json.loads((root / 'status.json').read_text())
                    self.fail('Shipped supervisor exceeded the 5s safety deadline: ' + json.dumps(state))
                elapsed = time.monotonic() - before
                status = json.loads((root / 'status.json').read_text())
                code = process.returncode if process.returncode >= 0 else 128 - process.returncode
                self.assertEqual(status['child_exit_code'], exit_code)
                self.assertIn('CONTROLLED_CHILD_COMPLETED', (root / 'command.log').read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(child_pid.read_text()), 0)
                if mode == 'fifo':
                    self.assertEqual(code, 137, stdout + stderr)
                    self.assertGreaterEqual(elapsed, 1.5)
                    self.assertLess(elapsed, 3)
                    self.assertEqual(status['status'], 'running')
                    self.assertNotIn('exit_code', status)
                    self.assertNotIn('test_counts', status)
                else:
                    self.assertEqual(code, exit_code, stdout + stderr)
                    self.assertEqual(status['status'], 'passed' if exit_code == 0 else 'failed')
                    self.assertEqual(status['exit_code'], exit_code)
                    self.assertEqual(status['remaining_processes'], [])
                    if exit_code == 0:
                        self.assertEqual(status['test_counts'], report['stats'])
            finally:
                # The successful fixture child is already gone at the blocked
                # report boundary. Clean only our own live process group
                # if a broken wrapper makes the regression hit its safety limit.
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.communicate(timeout=2)

    def test_fresh_fifo_report_cannot_outlive_the_outer_deadline(self):
        self.run_probe('fifo')

    def test_both_shipped_halves_preserve_verified_success(self):
        for project in ('new-3a', 'new-3b'):
            with self.subTest(project=project):
                self.run_probe('regular', project)

    def test_both_shipped_halves_preserve_original_child_failure(self):
        for project in ('new-3a', 'new-3b'):
            with self.subTest(project=project):
                self.run_probe('regular', project, exit_code=7)


if __name__ == '__main__':
    unittest.main()
