"""Real signal controls for the supervisor's external-cancellation deadline."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'ci/run-bounded-e2e.py'


class ExternalCancellationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bounded-cancellation-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))

    def start(self, timeout=30):
        grandchild = (
            "import os,signal,time; from pathlib import Path; "
            "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            f"Path({str(self.root / 'ready')!r}).write_text(str(os.getpid())); time.sleep(60)"
        )
        code = (
            "import subprocess,sys,signal,time,os,json; from pathlib import Path; "
            "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            f"child=subprocess.Popen([sys.executable,'-c',{grandchild!r}],start_new_session=True); "
            f"Path({str(self.root / 'pids.json')!r}).write_text(json.dumps([os.getpid(),child.pid])); "
            "print('owned descendants ready',flush=True); time.sleep(60)"
        )
        process = subprocess.Popen([
            sys.executable, str(RUNNER), '--context', str(self.root / 'context.json'),
            '--status', str(self.root / 'status.json'), '--log', str(self.root / 'command.log'),
            '--report', str(self.root / 'report.json'), '--timeout-seconds', str(timeout),
            '--job-budget-seconds', '60', '--heartbeat-seconds', '.1',
            '--', sys.executable, '-u', '-c', code,
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop, process)
        deadline = time.monotonic() + 4
        while not (self.root / 'ready').exists():
            if time.monotonic() >= deadline or process.poll() is not None:
                self.fail('The real owned descendant did not become ready')
            time.sleep(.01)
        return process

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        process.communicate(timeout=7)

    def assert_finished(self, process, signum, started):
        stdout, stderr = process.communicate(timeout=6)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(process.returncode, 128 + signum, stderr)
        status = json.loads((self.root / 'status.json').read_text())
        self.assertEqual(status['status'], 'interrupted')
        self.assertEqual(status['received_signal'], signum)
        self.assertEqual(status['remaining_processes'], [])
        for pid in json.loads((self.root / 'pids.json').read_text()):
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        events = [json.loads(line) for line in (self.root / 'status.supervisor.jsonl').read_text().splitlines()]
        self.assertIn('signal_received', [event['event'] for event in events])
        self.assertEqual(events[-1]['event'], 'finished')
        self.assertEqual(events[-1]['exit_code'], 128 + signum)
        self.assertIn('[bounded-e2e]', stdout)
        return events

    def test_external_signals_reap_detached_children_before_runner_escalation(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
        self.addCleanup(self.stop, unrelated)
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=signum):
                (self.root / 'ready').unlink(missing_ok=True)
                process = self.start()
                started = time.monotonic()
                process.send_signal(signum)
                events = self.assert_finished(process, signum, started)
                self.assertTrue(any(event['event'] == 'cleanup_signal' and event['signal'] == 9 for event in events))
                self.assertIsNone(unrelated.poll(), 'Cleanup must not signal unrelated processes')

    def test_cancel_shortens_an_already_running_internal_timeout_cleanup(self):
        process = self.start(timeout=.4)
        deadline = time.monotonic() + 4
        while True:
            status = json.loads((self.root / 'status.json').read_text())
            if status['status'] == 'timed_out':
                break
            if time.monotonic() >= deadline:
                self.fail('Internal timeout did not begin its 10-second cleanup grace')
            time.sleep(.01)
        started = time.monotonic()
        process.send_signal(signal.SIGINT)
        self.assert_finished(process, signal.SIGINT, started)

    def test_second_signal_escalates_without_restarting_the_deadline(self):
        process = self.start()
        process.send_signal(signal.SIGINT)
        time.sleep(.1)
        started = time.monotonic()
        process.send_signal(signal.SIGTERM)
        self.assert_finished(process, signal.SIGINT, started)
        self.assertLess(time.monotonic() - started, 1.5)
        status = json.loads((self.root / 'status.json').read_text())
        self.assertEqual(status['last_received_signal'], signal.SIGTERM)


if __name__ == '__main__':
    unittest.main()
