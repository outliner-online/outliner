"""Synthetic resolute Deb822/list fixtures, NOT real runner/source proof."""
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('mirror',ROOT/'scripts/ci/ubuntu_mirror_candidate.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SOURCES='''# synthetic Ubuntu26, actual raw source has not been retained
Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: resolute resolute-updates resolute-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: resolute-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
'''
MIRRORS=m.FIRST+'\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n'
FAILED=m.FIRST+'pool/main/x/x_1_amd64.deb'
OBSERVED_SOURCES='''# Redacted runner image source guidance; comments are not semantic APT fields.

# A second redacted comment paragraph precedes the configured sources.

Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: resolute resolute-updates resolute-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: resolute-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
'''

class Plan(unittest.TestCase):
    def plan(self,**kw):
        args=dict(sources=SOURCES,mirrors=MIRRORS,failed_uri=FAILED,native_exit=100,remaining_ms=200000,nonce='a'*32,failure_kind='transport-error');args.update(kw)
        return m.fallback_plan(**args)
    def test_only_existing_next_and_archive_paragraph_changed(self):
        p=self.plan();self.assertEqual(p['private_mirrorlist'],'https://archive.ubuntu.com/ubuntu/\tpriority:2\n')
        self.assertEqual(p['ubuntu_sources'].split('\n\n')[1],SOURCES.split('\n\n')[1])
        self.assertEqual(p['ubuntu_sources'].replace('mirror+file:/tmp/outliner-apt-'+'a'*32+'/mirrors.txt',m.MIRROR_URI),SOURCES)
        self.assertFalse(p['ready_for_real_runner']);self.assertFalse(p['host_files_changed'])
    def test_observed_runner_comment_and_shared_mirrorlist_layout(self):
        plan=self.plan(sources=OBSERVED_SOURCES)
        self.assertIn('Suites: resolute-security\n', plan['ubuntu_sources'])
        self.assertEqual(plan['ubuntu_sources'].count('mirror+file:/etc/apt/apt-mirrors.txt'), 1)
        self.assertEqual(plan['ubuntu_sources'].count('/tmp/outliner-apt-'), 1)
    def test_security_fixed_origin_slash_variants_preserve_original_bytes(self):
        for uri in ('http://security.ubuntu.com/ubuntu','http://security.ubuntu.com/ubuntu/',
                    'https://security.ubuntu.com/ubuntu','https://security.ubuntu.com/ubuntu/'):
            with self.subTest(uri=uri):
                original=SOURCES.replace('http://security.ubuntu.com/ubuntu/',uri)
                original=original.replace('Suites: resolute-security','# security paragraph preserved\nSuites: resolute-security')
                plan=self.plan(sources=original)
                self.assertEqual(plan['ubuntu_sources'].split('\n\n')[1].encode(),original.split('\n\n')[1].encode())
                self.assertEqual(plan['ubuntu_sources'].replace('mirror+file:/tmp/outliner-apt-'+'a'*32+'/mirrors.txt',m.MIRROR_URI),original)
    def test_security_near_matches_and_other_suites_remain_unsupported(self):
        for uri in ('http://security.ubuntu.com','http://security.ubuntu.com/ubuntu//',
                    'http://security.ubuntu.com/ubuntu/pool','http://security.ubuntu.com/Ubuntu',
                    'http://security.ubuntu.com/ubuntu?','http://security.ubuntu.com/ubuntu#',
                    'http://security.ubuntu.com:80/ubuntu','http://user@security.ubuntu.com/ubuntu',
                    'http://security.ubuntu.com.evil.invalid/ubuntu','http://archive.ubuntu.com/ubuntu',
                    'ftp://security.ubuntu.com/ubuntu','http://security.ubuntu.com/ubuntu https://security.ubuntu.com/ubuntu'):
            with self.subTest(uri=uri),self.assertRaises(ValueError):
                self.plan(sources=SOURCES.replace('http://security.ubuntu.com/ubuntu/',uri))
        with self.assertRaises(ValueError):
            self.plan(sources=SOURCES.replace('resolute-security','resolute-proposed'))
    def test_wrong_origin_or_pocket(self):
        for uri in (FAILED.replace('us-east-2.ec2.archive.ubuntu.com','packages.microsoft.com'),FAILED.replace('/pool/','/dists/'),FAILED.replace('http://','http://user:secret@')):
            with self.assertRaises(ValueError):self.plan(failed_uri=uri)
    def test_no_new_mirror_or_priority_assumption(self):
        for mirrors in (MIRRORS.replace('archive.ubuntu.com/ubuntu/','evil.invalid/ubuntu/',1),MIRRORS.replace(m.FIRST,m.FIRST+'\tpriority:1'),m.FIRST+'\n'):
            with self.assertRaises(ValueError):self.plan(mirrors=mirrors)
    def test_other_release_not_assumed_compatible(self):
        with self.assertRaises(ValueError):self.plan(sources=SOURCES.replace('resolute','noble'))
    def test_security_pocket_required(self):
        with self.assertRaises(ValueError):self.plan(sources=SOURCES.split('\n\n')[0])
    def test_trust_and_expiry_not_relaxed(self):
        for line in ('Trusted: yes','Check-Valid-Until: no','Check-Date: no','Allow-Insecure: yes'):
            with self.assertRaises(ValueError):self.plan(sources=SOURCES+'\n'+line+'\n')
    def test_later_unsafe_override_is_not_masked_by_earlier_unsupported_layout(self):
        sources=SOURCES.replace('resolute resolute-updates resolute-backports','resolute-proposed')
        sources += '\nAllow-Insecure: yes\n'
        with self.assertRaisesRegex(ValueError, '^unsupported-source-security-override$'):
            self.plan(sources=sources)
    def test_later_unsafe_override_is_not_masked_by_earlier_deb822_folding(self):
        sources=SOURCES.replace('Types: deb','Types: deb\n folded-value',1)
        sources += '\nAllow-Insecure: yes\n'
        with self.assertRaisesRegex(ValueError, '^unsupported-source-security-override$'):
            self.plan(sources=sources)
    def test_deadline_not_reset(self):
        for remaining in (0,5000,600000):
            with self.assertRaises(ValueError):self.plan(remaining_ms=remaining)
    def test_no_retry_for_config_or_dpkg_exit(self):
        with self.assertRaises(ValueError):self.plan(native_exit=64)

class Sequence(unittest.TestCase):
    def exercise(self,codes):
        events=[];codes=iter(codes)
        def download(plan,budget):events.append(('download',plan,budget));return next(codes)
        def install(**kw):events.append(('install',kw));return 0
        def retry(code,budget):events.append(('plan',code,budget));return {'existing-next-only':True}
        code=m.sequence(download,install,retry,lambda:200000)
        return code,events
    def test_first_success_no_retry(self):
        code,events=self.exercise([0]);self.assertEqual(code,0);self.assertEqual([e[0] for e in events],['download','install'])
        self.assertEqual(events[-1][1],{'no_download':True,'remaining_ms':200000})
    def test_one_retry_then_install(self):
        code,events=self.exercise([100,0]);self.assertEqual(code,0)
        self.assertEqual([e[0] for e in events],['download','plan','download','install'])
    def test_both_fail_no_dpkg(self):
        code,events=self.exercise([100,100]);self.assertEqual(code,100)
        self.assertNotIn('install',[e[0] for e in events])
    def test_dpkg_failure_not_retried(self):
        calls=[]
        code=m.sequence(lambda *a:0,lambda **kw:(calls.append(kw) or 42),lambda *a:self.fail('retry'),lambda:200000)
        self.assertEqual(code,42);self.assertEqual(len(calls),1)

class Deadline(unittest.TestCase):
    def test_no_budget_reset(self):
        budgets=iter([500000,100000,90000,80000]);events=[]
        codes=iter([100,0])
        result=m.sequence(lambda plan,budget:(events.append(budget) or next(codes)),
                          lambda **kw:(events.append(kw['remaining_ms']) or 0),
                          lambda code,budget:(events.append(budget) or {}),lambda:next(budgets))
        self.assertEqual(result,0);self.assertEqual(events,[500000,100000,90000,80000])
    def test_exhausted_budget_never_installs(self):
        self.assertEqual(m.sequence(lambda *a:0,lambda **kw:self.fail('dpkg'),lambda *a:self.fail('retry'),lambda:0),124)
    def test_signature_failure_cannot_select_mirror(self):
        with self.assertRaises(ValueError):
            m.fallback_plan(SOURCES,MIRRORS,FAILED,100,200000,'a'*32,'signature-error')
