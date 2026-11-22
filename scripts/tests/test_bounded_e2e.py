"""Real subprocess regressions for the Linux E2E deadline/evidence boundary."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'ci/run-bounded-e2e.py'


class BoundedE2ETest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bounded-e2e-')
        self.root = Path(self.temporary.name)
        self.context = self.root / 'context.json'
        self.context.write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))
        self.report = self.root / 'results.json'
        self.report.write_text(json.dumps({
            'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
            'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}],
        }))

    def tearDown(self):
        self.temporary.cleanup()

    def run_command(self, code, timeout=3, fresh_report=True):
        if fresh_report:
            code = (f"from pathlib import Path; Path({str(self.report)!r}).write_text("
                    f"{self.report.read_text()!r}); " + code)
        result = subprocess.run([
            sys.executable, str(RUNNER), '--context', str(self.context),
            '--status', str(self.root / 'status.json'), '--log', str(self.root / 'command.log'),
            '--report', str(self.report),
            '--timeout-seconds', str(timeout), '--job-budget-seconds', '60', '--grace-seconds', '0.15',
            '--', sys.executable, '-u', '-c', code,
        ], capture_output=True, text=True, timeout=10)
        self.status = json.loads((self.root / 'status.json').read_text())
        return result

    def assert_children_gone(self):
        for pid in json.loads((self.root / 'pids.json').read_text()):
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        self.assertEqual(self.status['remaining_processes'], [])

    def test_success_and_original_failure_preserve_status_and_output(self):
        for code in [0, 7]:
            with self.subTest(code=code):
                attachment = self.root / 'failed-attempt.json'
                result = self.run_command(
                    f"from pathlib import Path; Path({str(attachment)!r}).write_text('original bytes'); "
                    f"print('test output', flush=True); raise SystemExit({code})"
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(self.status['child_exit_code'], code)
                self.assertEqual(self.status['status'], 'passed' if code == 0 else 'failed')
                self.assertIn('test output', (self.root / 'command.log').read_text())
                self.assertEqual(attachment.read_text(), 'original bytes')

    def test_context_identity_is_retained_without_inventing_a_job_id(self):
        context = json.loads(self.context.read_text())
        context.update(runId='1234', runAttempt='2', ciShard='tables-2', commit='fixture-sha')
        self.context.write_text(json.dumps(context))
        result = self.run_command("print('identified command')")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({key: self.status[key] for key in ('run_id', 'run_attempt', 'project', 'checkout_sha')},
                         {'run_id': '1234', 'run_attempt': '2', 'project': 'tables-2', 'checkout_sha': 'fixture-sha'})
        self.assertNotIn('job_id', self.status)

    def test_missing_context_identity_remains_unknown(self):
        result = self.run_command("print('local command')")
        self.assertEqual(result.returncode, 0, result.stderr)
        for key in ('run_id', 'run_attempt', 'project', 'checkout_sha'):
            self.assertIsNone(self.status[key])
        self.assertNotIn('job_id', self.status)

    def test_timeout_is_failure_even_when_term_handler_exits_zero(self):
        result = self.run_command(
            "import signal,time,sys; signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); "
            "print('before timeout', flush=True); time.sleep(60)", timeout=0.4
        )
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertEqual(self.status['status'], 'timed_out')
        self.assertEqual(self.status['child_exit_code'], 0)
        self.assertEqual(self.status['remaining_processes'], [])
        self.assertIn('before timeout', (self.root / 'command.log').read_text())

    def test_interruption_is_nonzero_and_cleans_up(self):
        result = self.run_command(
            "import os,signal,time; os.kill(os.getppid(), signal.SIGTERM); time.sleep(60)"
        )
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertEqual(self.status['status'], 'interrupted')
        self.assertEqual(self.status['received_signal'], 15)
        self.assertEqual(self.status['remaining_processes'], [])

    def detached_child(self, parent_exits):
        pid_file = self.root / 'pids.json'
        grandchild = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
        code = (
            "import subprocess,sys,signal,time,os,json; from pathlib import Path; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            f"child=subprocess.Popen([sys.executable,'-c',{grandchild!r}],start_new_session=True); "
            f"Path({str(pid_file)!r}).write_text(json.dumps([os.getpid(),child.pid])); "
            "print('detached child started',flush=True); "
            + ("time.sleep(0.1)" if parent_exits else "time.sleep(60)")
        )
        result = self.run_command(code, timeout=0.5)
        self.assertEqual(result.returncode, 1 if parent_exits else 124, result.stderr)
        self.assertEqual(self.status['status'], 'orphaned_children' if parent_exits else 'timed_out')
        self.assert_children_gone()
        self.assertIn('detached child started', (self.root / 'command.log').read_text())

    def test_timeout_reaps_term_ignoring_detached_descendant(self):
        self.detached_child(parent_exits=False)

    def test_parent_success_with_live_descendant_is_not_success(self):
        self.detached_child(parent_exits=True)

    def test_exhausted_job_budget_does_not_run_command_or_pass(self):
        self.context.write_text(json.dumps({
            'startedAt': (datetime.now(timezone.utc) - timedelta(seconds=90)).isoformat(),
        }))
        sentinel = self.root / 'should-not-exist'
        result = self.run_command(f"from pathlib import Path; Path({str(sentinel)!r}).touch()")
        self.assertEqual(result.returncode, 124)
        self.assertEqual(self.status['status'], 'not_started')
        self.assertFalse(self.status['command_started'])
        self.assertFalse(sentinel.exists())

    def test_remaining_job_budget_caps_the_command_deadline(self):
        self.context.write_text(json.dumps({
            'startedAt': (datetime.now(timezone.utc) - timedelta(seconds=58)).isoformat(),
        }))
        result = self.run_command("import time; time.sleep(60)", timeout=10)
        self.assertEqual(result.returncode, 124)
        self.assertEqual(self.status['status'], 'timed_out')
        self.assertLessEqual(self.status['budget_seconds'], 2)
        self.assertEqual(self.status['remaining_processes'], [])

    def test_blocked_console_cannot_block_timeout_or_lose_file_output(self):
        command = [sys.executable, str(RUNNER), '--context', str(self.context),
                   '--status', str(self.root / 'status.json'), '--log', str(self.root / 'command.log'),
                   '--report', str(self.report), '--timeout-seconds', '0.4',
                   '--job-budget-seconds', '60', '--grace-seconds', '0.15', '--', sys.executable,
                   '-u', '-c', "import time;print('x'*524288,flush=True);time.sleep(60)"]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # Deliberately do not drain stdout until the supervisor has exited.
            self.assertEqual(process.wait(timeout=3), 124)
        finally:
            process.communicate(timeout=10)
        status = json.loads((self.root / 'status.json').read_text())
        self.assertEqual(status['status'], 'timed_out')
        self.assertGreater(status['console_dropped_bytes'], 0)
        self.assertEqual(status['remaining_processes'], [])
        self.assertEqual((self.root / 'command.log').stat().st_size, 524289)

    def test_missing_empty_skipped_and_expected_failure_reports_cannot_pass(self):
        for kind in ['missing', 'empty', 'skipped', 'expected failure', 'stale', 'missing attachment']:
            with self.subTest(kind=kind):
                report = {'stats': {'expected': 0, 'flaky': 0, 'skipped': 0, 'unexpected': 0}, 'suites': []}
                if kind in ['skipped', 'expected failure']:
                    report['stats']['skipped' if kind == 'skipped' else 'expected'] = 1
                    report['suites'] = [{'specs': [{'tests': [{
                        'status': 'skipped' if kind == 'skipped' else 'expected',
                        'results': [{'status': 'skipped' if kind == 'skipped' else 'failed'}],
                    }]}]}]
                self.report.write_text(json.dumps(report))
                if kind == 'missing':
                    self.report.unlink()
                if kind in ['stale', 'missing attachment']:
                    self.report.write_text(json.dumps({
                        'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
                        'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}],
                    }))
                if kind == 'missing attachment':
                    value = json.loads(self.report.read_text())
                    value['suites'][0]['specs'][0]['tests'][0]['results'][0]['attachments'] = [
                        {'path': str(self.root / 'absent-attachment.json')},
                    ]
                    self.report.write_text(json.dumps(value))
                result = self.run_command("print('command exited zero')", fresh_report=kind not in ['missing', 'stale'])
                self.assertEqual(result.returncode, 125)
                self.assertEqual(self.status['status'], 'supervisor_failed')
                self.assertNotEqual(self.status.get('exit_code'), 0)
                self.assertEqual(self.status['child_exit_code'], 0)


if __name__ == '__main__':
    unittest.main()
