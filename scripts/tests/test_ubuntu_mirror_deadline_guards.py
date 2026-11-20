"""Negative process-boundary cases for issue #5971; no host acquisition."""
import subprocess
import time
from test_ubuntu_mirror_deadline import BoundaryFixture


class DeadlineGuards(BoundaryFixture):
    def test_privilege_wrapper_rejects_invalid_expired_excessive_and_consumed_inputs(self):
        for label, deadline, delay, expected in (
            ('missing', '', '.01', 64), ('malformed', 'not-a-deadline', '.01', 64),
            ('overflow', '9' * 30, '.01', 64),
            ('expired', str(time.monotonic_ns() // 1000000 - 1), '.01', 124),
            ('excessive', str(time.monotonic_ns() // 1000000 + 600000), '.01', 64),
            ('consumed', None, '.3', 124),
        ):
            with self.subTest(label=label):
                (self.root / 'events').unlink(missing_ok=True)
                value = str(time.monotonic_ns() // 1000000 + 150) if deadline is None else deadline
                result = subprocess.run(['bash', '-c',
                    'source "$1"; direct_runner_root bash -c "echo FORBIDDEN_ACQUISITION"',
                    'fixture', str(self.root / 'scripts/common-functions.sh')],
                    env={**self.env, 'DIRECT_RUNNER_OS_STRICT': '1',
                         'E2E_OS_WORK_DEADLINE': value, 'PRIVILEGE_DELAY': delay},
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3)
                self.assertEqual(result.returncode, expected, result.stdout)
                self.assertNotIn('FORBIDDEN_ACQUISITION', result.stdout)
                self.assertEqual(self.events('watchdog'), [])

    def test_acquisition_cli_rejects_missing_malformed_expired_and_excessive_deadlines(self):
        for value, expected in ((None, 2), ('bad', 2), ('0', 64),
                (str(time.monotonic_ns() // 1000000 + 600000), 64)):
            with self.subTest(value=value):
                args = [] if value is None else ['--deadline-ms', value]
                result = subprocess.run(['/usr/bin/python3', str(self.root / 'scripts/ci/ubuntu_mirror_download.py'),
                    '--browser', 'chromium', *args], env=self.env, text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3)
                self.assertEqual(result.returncode, expected, result.stdout)
                self.assertEqual(self.events('acquisition'), [])
                self.assertNotIn('FIXTURE_BROWSER_EXECUTED', result.stdout)


    def test_worker_rejects_invalid_deadline_before_readiness(self):
        for value, expected in (('', 64), ('bad', 64), ('0', 124),
                (str(time.monotonic_ns() // 1000000 + 600000), 64)):
            with self.subTest(value=value):
                result = subprocess.run(['bash', str(self.root / 'scripts/setup-direct-runner-os.sh'), '--worker'],
                    env={**self.env, 'E2E_OS_WORK_DEADLINE': value,
                         'E2E_OS_STAGE_FILE': str(self.root / 'stage')},
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3)
                self.assertEqual(result.returncode, expected, result.stdout)
                self.assertNotIn('stage: ready', result.stdout)
                self.assertEqual(self.events('acquisition'), [])
                self.assertEqual(self.events('watchdog'), [])
