"""Heartbeat evidence must remain useful even when the CI console stops reading."""
from datetime import datetime, timezone
import json
import signal
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'ci/run-bounded-e2e.py'


class SupervisorDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bounded-diagnostics-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'context.json').write_text(json.dumps({
            'startedAt': datetime.now(timezone.utc).isoformat(), 'runId': '123',
            'runAttempt': '2', 'ciShard': 'new-3b', 'commit': 'current-sha',
        }))

    def command(self, code, timeout=.8):
        return [sys.executable, str(RUNNER), '--context', str(self.root / 'context.json'),
                '--status', str(self.root / 'status.json'), '--log', str(self.root / 'command.log'),
                '--report', str(self.root / 'report.json'), '--heartbeat-seconds', '.1',
                '--timeout-seconds', str(timeout), '--job-budget-seconds', '60',
                '--grace-seconds', '.1', '--', sys.executable, '-u', '-c', code]

    def events(self):
        return [json.loads(line) for line in (self.root / 'status.supervisor.jsonl').read_text().splitlines()]

    def test_heartbeat_records_actual_owned_activity_without_raw_commands(self):
        code = ("import time; data=bytearray(8_000_000); print('SYNTHETIC_PRIVATE_OUTPUT',flush=True); "
                "end=time.monotonic()+.4\nwhile time.monotonic()<end: sum(range(10000))\ntime.sleep(60)")
        result = subprocess.run(self.command(code), capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 124, result.stderr)
        events = self.events()
        beats = [event for event in events if event['event'] == 'heartbeat' and event['phase'] == 'running']
        self.assertGreaterEqual(len(beats), 2)
        active = [event for event in beats if event['process_count'] and event['output_bytes']]
        self.assertTrue(active)
        self.assertTrue(any(event['live_cpu_seconds'] > 0 for event in active))
        self.assertTrue(any(event['summed_rss_bytes'] >= 8_000_000 for event in active))
        self.assertGreater(active[-1]['output_idle_seconds'], active[0]['output_idle_seconds'])
        remaining = [event['command_remaining_seconds'] for event in beats]
        self.assertEqual(remaining, sorted(remaining, reverse=True))
        self.assertTrue(all(0 <= value <= .8 for value in remaining))
        self.assertTrue(all(event['run_id'] == '123' and event['run_attempt'] == '2'
                            and event['project'] == 'new-3b' and event['checkout_sha'] == 'current-sha'
                            for event in events))
        serialized = json.dumps(events)
        self.assertNotIn('SYNTHETIC_PRIVATE_OUTPUT', serialized)
        self.assertNotIn('time.sleep', serialized)
        self.assertIn('SYNTHETIC_PRIVATE_OUTPUT', (self.root / 'command.log').read_text())
        self.assertIn('"event":"heartbeat"', result.stdout)
        self.assertEqual(events[-1]['status'], 'timed_out')
        self.assertEqual(events[-1]['process_count'], 0)

    def test_full_console_does_not_block_heartbeat_file_or_cleanup(self):
        process = subprocess.Popen(self.command("import time;print('x'*524288,flush=True);time.sleep(60)"),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # The subprocess must finish before anything drains its console.
            self.assertEqual(process.wait(timeout=5), 124)
        finally:
            process.communicate(timeout=3)
        events = self.events()
        self.assertTrue(any(event['event'] == 'heartbeat' for event in events))
        self.assertEqual(events[-1]['event'], 'finished')
        status = json.loads((self.root / 'status.json').read_text())
        self.assertGreater(status['diagnostic_console_dropped_bytes'], 0)
        self.assertEqual(status['remaining_processes'], [])
        self.assertEqual((self.root / 'command.log').stat().st_size, 524289)

    def test_success_emits_report_validation_and_terminal_evidence(self):
        report = {'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
                  'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}]}
        code = f"from pathlib import Path;Path({str(self.root / 'report.json')!r}).write_text({json.dumps(report)!r})"
        result = subprocess.run(self.command(code, timeout=3), capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.events()
        self.assertIn('validating_report', [event['event'] for event in events])
        self.assertEqual(events[-1]['event'], 'finished')
        self.assertEqual(events[-1]['exit_code'], 0)

    def test_signal_received_during_report_validation_cannot_pass(self):
        # A real FIFO controls validation's completion without replacing the
        # production parser. Supplying its bytes after the signal resumes it.
        report_path = self.root / 'report.json'
        code = f"import os;os.mkfifo({str(report_path)!r})"
        process = subprocess.Popen(self.command(code, timeout=5), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 3
            while True:
                try:
                    status = json.loads((self.root / 'status.json').read_text())
                except FileNotFoundError:
                    status = {}
                if status.get('phase') == 'validating_report':
                    break
                if process.poll() is not None or time.monotonic() >= deadline:
                    self.fail('The real report validator did not start')
                time.sleep(.01)
            process.send_signal(signal.SIGINT)
            report = json.dumps({
                'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
                'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}],
            })
            writer = f"from pathlib import Path;Path({str(report_path)!r}).write_text({report!r})"
            subprocess.run([sys.executable, '-c', writer], check=True, timeout=3)
            stdout, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 130, stdout + stderr)
            self.assertEqual(self.events()[-1]['status'], 'interrupted')
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()
