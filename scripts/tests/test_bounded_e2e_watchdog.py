"""Exercise a never-finishing report through the shipped step and runner signals.

The external deadline is runner emulation, not a claim that the Python parser
or a hosted runner always enforces its own deadline while blocked in I/O.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest

from bounded_e2e_workflow_fixture import prepare, workflow_job


class New3WatchdogTest(unittest.TestCase):
    def prepare_step(self, root, project, code):
        env = prepare(root, interrupt=False)
        job = workflow_job()
        step = next(value for value in job['steps'] if value.get('id') == 'tests')
        self.assertEqual(job['timeout-minutes'], 45)
        self.assertEqual(step['timeout-minutes'], 23)
        self.assertFalse(step.get('continue-on-error', False))
        source = step['run']
        self.assertEqual((root / 'step.sh').read_text(), source.replace('${{ matrix.project }}', 'new-3b'))
        branch = source.split('elif [[ "$project" =~ ^new-3[ab]$ ]]; then', 1)[1].split('elif ', 1)[0]
        tokens = shlex.split(branch.replace('\\\n', ' '), comments=True)
        self.assertEqual(tokens[:4], ['PLAYWRIGHT_HTML_OPEN=never', 'exec', 'python3',
                                     '../scripts/ci/run-bounded-e2e.py'])
        native = tokens[tokens.index('--') + 1:]
        self.assertEqual([value.replace('$project', project) for value in native], [
            'npm', 'run', 'github:test:e2e', '--', '--project=' + project, '--reporter=line,json,html',
        ])
        budgets = '--timeout-seconds=1200 --job-budget-seconds=1320 --grace-seconds=10'
        self.assertEqual(branch.count(budgets), 1)
        command = '-- npm run github:test:e2e -- --project="$project" --reporter=line,json,html'
        self.assertEqual(branch.count(command), 1)
        # Retain the full shipped Bash control flow, startup verifier and direct
        # exec. Only the controlled command and fixture budgets are substituted.
        modified = branch.replace(command, '-- ' + shlex.join([sys.executable, '-u', '-c', code]))
        modified = modified.replace(budgets, '--timeout-seconds=0.5 --job-budget-seconds=60 --grace-seconds=0.1')
        script = source.replace(branch, modified, 1).replace('${{ matrix.project }}', project)
        (root / 'step.sh').write_text(script)
        # The shared helper prepares new-3b. Keep the same verified evidence
        # format while changing only its fixture identity for the other half.
        for original in list((root / 'job_logs').iterdir()):
            value = json.loads(original.read_text())
            for key in ('ciShard', 'project', 'shard'):
                if value.get(key) == 'new-3b':
                    value[key] = project
            target = original.with_name(original.name.replace('new-3b', project))
            target.write_text(json.dumps(value))
            if target != original:
                original.unlink()
        env['E2E_PROJECT'] = project
        # Scale the actual configured step deadline, independently of the
        # supervisor's shorter internal command deadline.
        return env, step['timeout-minutes'] * 60 * (1.5 / (23 * 60))

    def emulate_runner_deadline(self, entry, root, status_path, started, budget):
        deadline = started + budget
        while time.monotonic() < deadline:
            self.assertIsNone(entry.poll(), (root / 'console.log').read_text())
            time.sleep(min(.01, max(0, deadline - time.monotonic())))
        status = json.loads(status_path.read_text())
        self.assertEqual(status['phase'], 'validating_report')
        self.assertEqual(status['status'], 'running')
        self.assertEqual(status['child_exit_code'], 0)
        self.assertNotIn('test_counts', status)
        self.assertLess(status['budget_seconds'], budget)
        with self.assertRaises(ProcessLookupError):
            os.kill(int((root / 'child.pid').read_text()), 0)
        # Verify exec preserved the original entry PID as the real supervisor.
        command = Path(f'/proc/{entry.pid}/cmdline').read_bytes().split(b'\0')
        self.assertEqual(command[1], b'../scripts/ci/run-bounded-e2e.py')
        # Emulate the runner's 7.5s INT grace and 2.5s TERM grace, scaled only
        # for this fixture. No writer ever opens the FIFO to release validation.
        for signum, seconds in ((signal.SIGINT, 7.5), (signal.SIGTERM, 2.5)):
            entry.send_signal(signum)
            with self.assertRaises(subprocess.TimeoutExpired):
                entry.wait(timeout=seconds * .04)
        entry.kill()
        entry.wait(timeout=2)

    def run_probe(self, mode, project='new-3b', exit_code=0):
        with tempfile.TemporaryDirectory(prefix='new3-watchdog-') as directory:
            root = Path(directory)
            report = {
                'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
                'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}],
            }
            child_pid = root / 'child.pid'
            result_path = root / 'job_logs/report.json'
            write_report = (f'os.mkfifo({str(result_path)!r})' if mode == 'fifo' else
                            f'Path({str(result_path)!r}).write_text({json.dumps(report)!r})')
            code = (
                'import os; from pathlib import Path; '
                f'Path({str(child_pid)!r}).write_text(str(os.getpid())); '
                + write_report + '; '
                "print('CONTROLLED_CHILD_COMPLETED', flush=True); "
                f'raise SystemExit({exit_code})'
            )
            env, budget = self.prepare_step(root, project, code)
            status_path = root / f'job_logs/{project}-command-status.json'
            with (root / 'console.log').open('w') as console:
                started = time.monotonic()
                entry = subprocess.Popen(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', 'step.sh'],
                                         cwd=root, env=env, stdin=subprocess.DEVNULL,
                                         stdout=console, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    if mode == 'fifo':
                        self.emulate_runner_deadline(entry, root, status_path, started, budget)
                    else:
                        entry.wait(timeout=budget)
                    elapsed = time.monotonic() - started
                    status = json.loads(status_path.read_text())
                    output = (root / 'console.log').read_text()
                    code = entry.returncode if entry.returncode >= 0 else 128 - entry.returncode
                    self.assertEqual(status['child_exit_code'], exit_code)
                    self.assertIn('startup_verified=true', (root / 'outputs').read_text())
                    self.assertIn('CONTROLLED_CHILD_COMPLETED',
                                  (root / f'job_logs/e2e-chromium-{project}-fixture-1.log').read_text())
                    with self.assertRaises(ProcessLookupError):
                        os.kill(int(child_pid.read_text()), 0)
                    events = [json.loads(line) for line in status_path.with_suffix('.supervisor.jsonl').read_text().splitlines()]
                    if mode == 'fifo':
                        self.assertEqual(code, 137, output)
                        self.assertGreaterEqual(elapsed, budget)
                        self.assertLess(elapsed, 3)
                        self.assertTrue(stat.S_ISFIFO(result_path.stat().st_mode))
                        self.assertEqual(status['phase'], 'validating_report')
                        self.assertEqual(status['status'], 'running')
                        self.assertNotIn('exit_code', status)
                        self.assertNotIn('test_counts', status)
                        self.assertEqual(events[-1]['event'], 'validating_report')
                        self.assertNotIn('finished', [event['event'] for event in events])
                    else:
                        self.assertEqual(code, exit_code, output)
                        self.assertEqual(status['status'], 'passed' if exit_code == 0 else 'failed')
                        self.assertEqual(status['exit_code'], exit_code)
                        self.assertEqual(status['remaining_processes'], [])
                        self.assertEqual(events[-1]['event'], 'finished')
                        self.assertEqual(events[-1]['exit_code'], exit_code)
                        if exit_code == 0:
                            self.assertEqual(status['test_counts'], report['stats'])
                finally:
                    # Never signal the exited child PID. Only the still-live
                    # process group created by this fixture is eligible here.
                    if entry.poll() is None:
                        try:
                            os.killpg(entry.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    entry.wait(timeout=2)

    def test_never_written_fifo_is_bounded_by_emulated_runner_deadline(self):
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
