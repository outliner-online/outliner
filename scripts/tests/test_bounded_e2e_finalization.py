"""A cancellation accepted while publishing success must never return success."""
from datetime import datetime, timezone
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).resolve().parents[1] / 'ci/run-bounded-e2e.py'


class FinalizationCancellationTest(unittest.TestCase):
    def test_late_signal_cannot_be_swallowed_after_computing_success(self):
        for _ in range(4):
            with tempfile.TemporaryDirectory(prefix='bounded-finalization-') as directory:
                root = Path(directory)
                status_path = root / 'status.json'
                (root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))
                report = {'stats': {'expected': 1, 'flaky': 0, 'skipped': 0, 'unexpected': 0},
                          'suites': [{'specs': [{'tests': [{'status': 'expected', 'results': [{'status': 'passed'}]}]}]}]}
                code = f"from pathlib import Path;Path({str(root / 'report.json')!r}).write_text({json.dumps(report)!r})"
                process = subprocess.Popen([
                    sys.executable, str(RUNNER), '--context', str(root / 'context.json'),
                    '--status', str(status_path), '--log', str(root / 'command.log'),
                    '--report', str(root / 'report.json'), '--timeout-seconds', '5',
                    '--job-budget-seconds', '30', '--', sys.executable, '-c', code,
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    deadline = time.monotonic() + 4
                    while process.poll() is None:
                        try:
                            status = json.loads(status_path.read_text())
                        except FileNotFoundError:
                            status = {}
                        if status.get('status') == 'passed':
                            # Use the real externally visible publication boundary,
                            # not a mock of cleanup, logging or signal delivery.
                            process.send_signal(signal.SIGINT)
                            break
                        if time.monotonic() >= deadline:
                            self.fail('The real supervisor never published its outcome')
                    stdout, stderr = process.communicate(timeout=3)
                    status = json.loads(status_path.read_text())
                    # A completed process can win the scheduling race. Only
                    # a cancellation actually accepted by its handler must
                    # override success; native SIGINT remains nonzero below.
                    if status.get('received_signal') == signal.SIGINT:
                        self.assertNotEqual(process.returncode, 0, stdout + stderr)
                        self.assertNotEqual(status['status'], 'passed')
                    if process.returncode != 0:
                        self.assertIn(process.returncode, (-signal.SIGINT, 128 + signal.SIGINT))
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()
