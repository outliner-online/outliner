"""Cancellation during real startup-marker validation must retain cleanup ownership."""
from datetime import datetime, timezone
import errno
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


class StartupValidationCancellationTest(unittest.TestCase):
    def check_interrupted_validation(self, cancel):
        with tempfile.TemporaryDirectory(prefix='startup-cancellation-') as directory:
            root = Path(directory)
            marker = root / 'completed.json'
            (root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))
            service = ("import os,signal,time;from pathlib import Path;"
                       "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                       f"Path({str(root / 'service-pid')!r}).write_text(str(os.getpid()));time.sleep(60)")
            code = ("import os,subprocess,sys;"
                    f"os.mkfifo({str(marker)!r});"
                    f"subprocess.Popen([sys.executable,'-c',{service!r}],start_new_session=True)")
            process = subprocess.Popen([
                sys.executable, str(RUNNER), '--context', str(root / 'context.json'),
                '--status', str(root / 'status.json'), '--log', str(root / 'startup.log'),
                '--startup-completion', str(marker), '--timeout-seconds', '10' if cancel else '.4',
                '--job-budget-seconds', '30', '--grace-seconds', '.1',
                '--', sys.executable, '-c', code,
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            writer = None
            try:
                deadline = time.monotonic() + 3
                while writer is None:
                    try:
                        # Opening the real FIFO proves the production validator
                        # reached its read. Hold EOF until after interruption.
                        writer = os.open(marker, os.O_WRONLY | os.O_NONBLOCK)
                    except OSError as error:
                        if error.errno not in (errno.ENOENT, errno.ENXIO):
                            raise
                        if process.poll() is not None or time.monotonic() >= deadline:
                            self.fail('The real startup marker validator did not begin reading')
                        time.sleep(.01)
                while not (root / 'service-pid').exists():
                    if time.monotonic() >= deadline:
                        self.fail('The detached service did not install its signal handler')
                    time.sleep(.01)
                if cancel:
                    process.send_signal(signal.SIGINT)
                else:
                    time.sleep(.5)
                os.write(writer, b'{"status":"completed"}')
                os.close(writer)
                writer = None
                stdout, stderr = process.communicate(timeout=4)
                self.assertEqual(process.returncode, 130 if cancel else 124, stdout + stderr)
                status = json.loads((root / 'status.json').read_text())
                self.assertEqual(status['status'], 'interrupted' if cancel else 'timed_out')
                self.assertFalse(status.get('startup_completed'))
                self.assertNotIn('retained_service_processes', status)
                self.assertEqual(status['remaining_processes'], [])
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((root / 'service-pid').read_text()), 0)
            finally:
                if writer is not None:
                    os.close(writer)
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=3)
                if (root / 'service-pid').exists():
                    try:
                        os.kill(int((root / 'service-pid').read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_signal_during_marker_validation_reaps_services(self):
        self.check_interrupted_validation(cancel=True)

    def test_deadline_during_marker_validation_reaps_services(self):
        self.check_interrupted_validation(cancel=False)


if __name__ == '__main__':
    unittest.main()
