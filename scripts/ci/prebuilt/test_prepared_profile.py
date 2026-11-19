"""Contract/negative controls only; no image, browser or package acquisition."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('PREPARED_PROFILE_ROOT', '/workspace/apt5965-commit-316b'))
spec = importlib.util.spec_from_file_location('profile', HERE / 'prepared_profile.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Contracts(unittest.TestCase):
    def setUp(self):
        self.plan = m.plan(ROOT)

    def test_real_locks_match_plan(self):
        m.verify_plan(ROOT, self.plan)
        self.assertEqual({v['version'] for v in self.plan['sdk'].values()}, {'1.64.1'})

    def test_no_readiness_from_plan(self):
        self.assertFalse(self.plan['readiness'])
        self.assertEqual(self.plan['stage'], 'unexecuted-producer-plan')

    def test_base_index_verified_from_registry(self):
        registry = json.loads((HERE / 'base-metadata.json').read_text())
        self.assertEqual(registry['header_digest'], registry['body_sha256'])
        self.assertEqual(m.BASE.split('@')[1], registry['header_digest'])
        self.assertEqual(len([v for v in registry['manifest']['manifests']
                              if v['platform'] == {'architecture': 'amd64', 'os': 'linux'}]), 1)

    def test_wrong_digest_rejected(self):
        self.plan['base'] = 'mcr.microsoft.com/playwright@sha256:' + '0' * 64
        with self.assertRaises(ValueError):
            m.verify_plan(ROOT, self.plan)

    def test_mutated_lock_rejected(self):
        self.plan['inputs']['client/package-lock.json'] = '0' * 64
        with self.assertRaises(ValueError):
            m.verify_plan(ROOT, self.plan)

    def test_node26_profile_rejected(self):
        self.plan['node_major'] = 26
        with self.assertRaises(ValueError):
            m.verify_plan(ROOT, self.plan)

    def test_missing_sdk_integrity_rejected(self):
        del self.plan['sdk']['playwright-core']['integrity']
        with self.assertRaises(ValueError):
            m.verify_plan(ROOT, self.plan)

    def test_reduced_package_set_rejected(self):
        self.plan['required_by_repository'].pop()
        with self.assertRaises(ValueError):
            m.verify_plan(ROOT, self.plan)

    def test_fake_ready_rejected(self):
        self.plan['readiness'] = True
        with self.assertRaises(ValueError):
            m.verify_plan(ROOT, self.plan)

    def test_actual_repository_required_set(self):
        deps = m.required(ROOT)
        self.assertEqual(len(deps), 31)
        self.assertIn('lsof', deps)
        self.assertIn('libcairo2-dev', deps)
        self.assertIn('libgtk-3-0', deps)

    def test_expired_slice_does_not_spawn(self):
        with patch.object(m.subprocess, 'Popen', side_effect=AssertionError('must not spawn')):
            with self.assertRaises(ValueError):
                m.probe(['apt-get', 'update'], 0)

    def test_root_rejected_before_probe(self):
        with patch.object(m.os, 'getuid', return_value=0):
            with patch.object(m, 'probe', side_effect=AssertionError('must not probe')):
                with self.assertRaises(ValueError):
                    m.check(ROOT, self.plan)

    def test_failed_probe_is_not_success(self):
        with self.assertRaises(ValueError):
            m.probe(['/bin/false'], m.time.monotonic() + 2)

    def test_all_slice_probes_still_do_not_certify_runtime(self):
        # Contract-only injected results, not evidence of real browser execution.
        outputs = ['22.1.0', 'openjdk 21.0.1',
                   json.dumps({'browser': 'chromium', 'version': '1.64.1', 'packages': ['libx11-6']}),
                   json.dumps({'browser': 'firefox', 'version': '1.64.1', 'packages': ['libx11-6']}), '',
                   json.dumps({'chromium': 'launched-and-closed', 'firefox': 'launched-and-closed'})]
        with patch.object(m.os, 'getuid', return_value=1000), patch.object(m, 'firebase_version', return_value=self.plan['firebase']):
            with patch.object(m, 'probe', side_effect=outputs) as run:
                result = m.check(ROOT, self.plan)
                self.assertFalse(result['readiness'])
                self.assertTrue(result['blockers'])
                self.assertEqual(run.call_count, 6)
                commands = [c.args[0] for c in run.call_args_list]
                self.assertEqual(commands[4][0], 'bash')
                self.assertIn('verify_required_os_packages', commands[4][2])
                self.assertFalse(any(c[0] in ('apt-get', 'sudo', 'npm', 'npx', 'docker') for c in commands))

    def test_firebase_mismatch_prevents_browser_start(self):
        with patch.object(m.os, 'getuid', return_value=1000), patch.object(m, 'firebase_version', return_value='0.0.0'):
            with patch.object(m, 'probe', side_effect=AssertionError('must not launch')):
                with self.assertRaises(ValueError):
                    m.check(ROOT, self.plan)

    def test_partial_browser_report_rejected(self):
        outputs = ['22.1.0', 'openjdk 21.0.1',
                   json.dumps({'browser': 'chromium', 'version': '1.64.1', 'packages': ['libx11-6']}),
                   json.dumps({'browser': 'firefox', 'version': '1.64.1', 'packages': ['libx11-6']}), '',
                   json.dumps({'chromium': 'launched-and-closed'})]
        with patch.object(m.os, 'getuid', return_value=1000), patch.object(m, 'firebase_version', return_value=self.plan['firebase']):
            with patch.object(m, 'probe', side_effect=outputs):
                with self.assertRaises(ValueError):
                    m.check(ROOT, self.plan)

    def test_default_cli_cannot_claim_ready_without_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp) / 'plan.json'
            plan.write_text(json.dumps(self.plan))
            run = subprocess.run(['python3', str(HERE / 'prepared_profile.py'), 'check',
                                  '--root', str(ROOT), '--plan', str(plan)], capture_output=True, text=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse(json.loads(run.stdout)['readiness'])


class InstalledStateVerifier(unittest.TestCase):
    def verify(self, inventory):
        # Synthetic dpkg ENV boundary; run the ACTUAL repository Bash verifier.
        with tempfile.TemporaryDirectory() as tmp:
            cmd = Path(tmp) / 'dpkg-query'
            cmd.write_text('#!/bin/sh\nprintf "%s" "$FIXTURE_INSTALLED"\n')
            cmd.chmod(0o700)
            env = {**os.environ, 'PATH': tmp + ':' + os.environ['PATH'], 'FIXTURE_INSTALLED': inventory}
            return subprocess.run(['bash', '-c', 'source "$1/scripts/common-functions.sh"; '
                                   'verify_required_os_packages libgtk-3-0', 'contract', str(ROOT)],
                                  env=env, capture_output=True, timeout=2).returncode

    def test_real_provider_verifier_accepts_t64_alias(self):
        self.assertEqual(self.verify('libgtk-3-0t64\tinstall ok installed\tlibgtk-3-0 (= 3.24)\n'), 0)

    def test_config_files_provider_is_not_installed(self):
        self.assertNotEqual(self.verify('libgtk-3-0t64\tdeinstall ok config-files\tlibgtk-3-0\n'), 0)

    def test_missing_required_is_not_ready(self):
        self.assertNotEqual(self.verify('unrelated\tinstall ok installed\t\n'), 0)


if __name__ == '__main__':
    unittest.main()
