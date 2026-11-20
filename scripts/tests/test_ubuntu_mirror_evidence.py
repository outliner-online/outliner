"""Attempt-local budget policy regressions; no real APT/network or host inspection."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from test_ubuntu_mirror_candidate import SOURCES, MIRRORS

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/ci'))
spec=importlib.util.spec_from_file_location('attribution',ROOT/'scripts/ci/ubuntu_mirror_download.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
EC2='http://us-east-2.ec2.archive.ubuntu.com/ubuntu'
START='Get:1 '+EC2+' resolute/main amd64 fixture amd64 1.0 [11.5 MB]\n'
FAILED='E: Failed to fetch '+EC2+'/pool/main/a/a_1_amd64.deb Connection timed out\n'

class Evidence(unittest.TestCase):
    def test_native_target_pool_failure(self):self.assertTrue(m.retry_evidence(100,FAILED)[0])
    def test_unidentified_or_nonpackage_progress_is_not_enough(self):
        for text in ('', 'Get:1 '+EC2+' resolute/main amd64 package [11 MB]\n',FAILED):
            self.assertFalse(m.retry_evidence(124,text)[0])
    def test_started_package_budget_policy_is_not_current_owner_claim(self):
        self.assertEqual(m.retry_evidence(124,START),(True,'first-download-budget-policy-not-current-owner'))
    def test_target_start_followed_by_other_or_lock_is_not_eligible(self):
        for tail in ('Waiting for cache lock\n', 'Get:2 http://security.ubuntu.com/ubuntu resolute-security/main amd64 other 1 [5 B]\n', 'Get:2 mirror+file:/etc/apt/apt-mirrors.txt resolute/main amd64 other 1 [5 B]\n','Hash Sum mismatch\n','Release file is expired\n','E: Unable to locate package invalid\n'):
            self.assertFalse(m.retry_evidence(124,START+tail)[0])
    def test_real_apt_package_description_shape(self):
        # Captured from native APT 3.0.3 signed local file repository download.
        # Only URI is substituted; this is grammar validation, not EC2 execution.
        line='Get:1 file:/tmp/fixture resolute/main amd64 mirror-attribution-fixture all 1.0 [680 B]\n'
        self.assertFalse(m.retry_evidence(124,line)[0])
        self.assertTrue(m.retry_evidence(124,line.replace('file:/tmp/fixture',EC2))[0])
    def test_other_vendor_and_security_failure(self):
        for host in ('security.ubuntu.com','packages.microsoft.com'):
            self.assertFalse(m.retry_evidence(100,FAILED.replace('us-east-2.ec2.archive.ubuntu.com',host))[0])
    def test_mixed_origin_cannot_hide_non_target_wait(self):
        self.assertFalse(m.retry_evidence(100,'Get:2 http://security.ubuntu.com/ubuntu resolute-security/main package\n'+FAILED)[0])
    def test_lock_cannot_hide_behind_prior_get(self):
        self.assertFalse(m.retry_evidence(100,'Get:1 '+EC2+' resolute/main package\nWaiting for cache lock\n'+FAILED)[0])
    def test_unidentified_mirror_uri_is_not_attribution(self):
        self.assertFalse(m.retry_evidence(100,'Get:1 mirror+file:/etc/apt/apt-mirrors.txt resolute/main package\n'+FAILED)[0])
    def test_bad_signature_cannot_retry(self):self.assertFalse(m.retry_evidence(100,'NO_PUBKEY\n'+FAILED)[0])

class ActualWiring(unittest.TestCase):
    def main_fixture(self,download,code):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);etc=root/'etc';(etc/'sources.list.d').mkdir(parents=True)
            (etc/'sources.list.d/ubuntu.sources').write_text(SOURCES);(etc/'apt-mirrors.txt').write_text(MIRRORS)
            calls=[]
            def supervisor(argv,seconds,log):
                calls.append((argv,log.name))
                if argv[-1]=='update':log.write_text('Hit:1 '+EC2+' resolute InRelease\n');return 0
                if log.name == 'download-first.log':
                    if download is not None:log.write_text(download)
                    return code
                log.write_text('');return 0
            with patch.object(m.os,'geteuid',return_value=0),patch.object(m,'effective_sources_supported',return_value=True),patch.object(m,'required',return_value=['fixture']),patch.object(m,'transaction',return_value=[]),patch.object(m,'supervise',side_effect=supervisor):
                result=m.main('chromium',time.monotonic_ns()//1000000+500000,etc)
            return result,calls
    def test_update_ec2_then_non_ec2_lock_unknown_timeout_never_switch(self):
        cases=('Get:1 http://security.ubuntu.com/ubuntu resolute-security/main package\n',
               'Get:1 https://packages.microsoft.com/ubuntu/26.04/prod resolute/main package\n',
               'Waiting for cache lock\n','Reading package lists...\n',
               'Get:1 '+EC2+' resolute/main package\n')
        for log in cases:
            with self.subTest(log=log):
                result,calls=self.main_fixture(log,124)
                self.assertEqual(result,124)
                self.assertEqual([name for _,name in calls],['update.log','download-first.log'])
                self.assertFalse(any('--no-download' in argv for argv,_ in calls))
    def test_update_ec2_then_unknown_native_error_never_switch(self):
        result,calls=self.main_fixture('unknown error\n',100)
        self.assertEqual(result,100);self.assertEqual(len(calls),2)

    def test_missing_or_truncated_attempt_evidence_retains_native_exit(self):
        for output in (None, FAILED + 'x' * 262144):
            result,calls=self.main_fixture(output,100)
            self.assertEqual(result,100);self.assertEqual(len(calls),2)
    def test_explicit_target_native_failure_retries_then_installs(self):
        result,calls=self.main_fixture(FAILED,100)
        self.assertEqual(result,0)
        self.assertEqual([name for _,name in calls],['update.log','download-first.log','retry-update.log','download-retry.log','install-no-download.log'])

    def test_started_package_timeout_has_one_retry_then_offline_install(self):
        result,calls=self.main_fixture(START,124)
        self.assertEqual(result,0)
        self.assertEqual([name for _,name in calls],['update.log','download-first.log','retry-update.log','download-retry.log','install-no-download.log'])
