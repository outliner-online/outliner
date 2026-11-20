"""Issue #5971: actual entrypoint, privilege command and acquisition CLI.

Offline OS/SDK/privilege adapters never install host packages. These tests exercise
the real sudo command handoff; APT_DEADLINE_REAL_SUDO=1 additionally requires
actual sudo inside a disposable nonroot fixture. Browsers are adapters here.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'scripts/tests/fixtures/apt-deadline'
sys.path.insert(0, str(ROOT / 'scripts/tests'))
from test_ubuntu_mirror_candidate import SOURCES, MIRRORS


class BoundaryFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / 'scripts'
        shutil.copytree(ROOT / 'scripts/ci', scripts / 'ci', ignore=shutil.ignore_patterns('__pycache__'))
        for name in ('setup-direct-runner-os.sh', 'common-functions.sh'):
            shutil.copyfile(ROOT / 'scripts' / name, scripts / name)
        with (scripts / 'common-functions.sh').open('a') as stream:
            stream.write('\n' + (FIXTURE / 'functions.sh').read_text())
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('node', 'sudo', 'date', 'timeout', 'apt-get'):
            target = self.bin / name
            shutil.copyfile(FIXTURE / 'commands.py', target)
            target.chmod(0o755)
        apt = self.root / 'apt'
        (apt / 'sources.list.d').mkdir(parents=True)
        (apt / 'sources.list.d/ubuntu.sources').write_text(SOURCES)
        (apt / 'apt-mirrors.txt').write_text(MIRRORS)
        self.env = {**os.environ, 'FIXTURE_DIR': str(self.root),
                    'PATH': str(self.bin) + ':' + os.environ['PATH'],
                    'PYTHONPATH': str(FIXTURE), 'PYTHONDONTWRITEBYTECODE': '1', 'E2E_OS_BUDGET_SECONDS': '600'}
        self.env.setdefault('APT_DEADLINE_REAL_SUDO', '1' if Path('/usr/bin/sudo').exists() else '0')
        for key in ('SKIP_APT_INSTALL', 'E2E_OS_WORK_DEADLINE', 'E2E_MIRROR_OFFLINE_READY', 'BASH_ENV'):
            self.env.pop(key, None)

    def run_setup(self, **env):
        started = time.monotonic()
        result = subprocess.run(['bash', str(self.root / 'scripts/setup-direct-runner-os.sh')],
                                env={**self.env, **env}, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=12)
        print(result.stdout, flush=True)
        return result, time.monotonic() - started

    def events(self, kind):
        path = self.root / 'events'
        return [row for line in (path.read_text().splitlines() if path.exists() else [])
                if (row := json.loads(line))['kind'] == kind]


class DeadlineBoundary(BoundaryFixture):
    def test_fresh_handoff_survives_both_wall_clock_adjustments_and_fallback(self):
        for shift in ('-3600', '3600'):
            with self.subTest(shift=shift):
                for name in ('events', 'crossed', 'installed', 'clock', 'identity'):
                    (self.root / name).unlink(missing_ok=True)
                result, elapsed = self.run_setup(WALL_SHIFT=shift, FALLBACK='1')
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertTrue((self.root / 'installed').exists())
                self.assertIn('stage=ready exit=0', result.stdout)
                self.assertIn('FIXTURE_BROWSER_EXECUTED', result.stdout)
                self.assertIn('stage=download-retry exit=0', result.stdout)
                self.assertLess(elapsed, 5)
                stages = self.events('acquisition')
                self.assertEqual(len(stages), 5)
                identity = json.loads((self.root / 'identity').read_text())
                self.assertEqual(identity['deadline'], self.events('privilege')[0]['deadline'])
                if self.env['APT_DEADLINE_REAL_SUDO'] == '1':
                    self.assertEqual(identity['uid'], 0)
                self.assertIn('--no-download', stages[-1]['args'])
                self.assertGreater(abs(stages[1]['wall'] - stages[0]['wall']), 7000)
                # Both privilege transition and stage work consume the original
                # allowance, independently observed by real child markers.
                watchdogs = self.events('watchdog')
                self.assertEqual(watchdogs[0]['args'][2], '595')
                self.assertLess(float(watchdogs[1]['args'][2]), 594.9)
                import re
                install = float(re.search(r'stage=install-no-download started=\S+ budget=(\S+)', result.stdout)[1])
                self.assertLess(install, float(watchdogs[1]['args'][2]) - 2)
                update = float(re.search(r'stage=update started=\S+ budget=(\S+)', result.stdout)[1])
                self.assertLess(install, update - .4)

    def test_stalled_acquisition_fails_with_native_watchdog_and_grace(self):
        result, elapsed = self.run_setup(STALL='1', E2E_OS_BUDGET_SECONDS='10')
        self.assertEqual(result.returncode, 124, result.stdout)
        self.assertLess(elapsed, 10)
        self.assertGreater(elapsed, 3)
        self.assertNotIn('stage=ready', result.stdout)
        self.assertEqual(len(self.events('stalled')), 1)
        for row in self.events('stalled'):
            with self.assertRaises(ProcessLookupError):
                os.kill(row['pid'], 0)

    def test_consumed_before_privilege_has_no_acquisition_or_readiness(self):
        result, elapsed = self.run_setup(PRIVILEGE_DELAY='2.3', E2E_OS_BUDGET_SECONDS='7')
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(elapsed, 8)
        self.assertNotIn('stage=ready', result.stdout)
        self.assertFalse((self.root / 'installed').exists())
        self.assertEqual(self.events('acquisition'), [])


    def test_unsupported_source_retains_legacy_setup(self):
        path = self.root / 'apt/sources.list.d/ubuntu.sources'
        path.write_text(SOURCES.replace('resolute', 'noble'))
        result, elapsed = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('APT mirror profile unsupported/target absent; using existing setup.', result.stdout)
        self.assertIn('stage=ready exit=0', result.stdout)
        self.assertEqual(len(self.events('acquisition')), 1)
        self.assertEqual(self.events('acquisition')[0]['args'][-1], 'update')
        self.assertFalse((self.root / 'installed').exists())


if __name__ == '__main__':
    unittest.main()
