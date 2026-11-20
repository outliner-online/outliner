"""Real own-process cleanup + synthetic APT command adapters. No real APT/network."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/ci'))
spec=importlib.util.spec_from_file_location('download',ROOT/'scripts/ci/ubuntu_mirror_download.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Pipeline(unittest.TestCase):
    def exercise(self,statuses,drift=False):
        calls=[];statuses=dict(statuses)
        def run(stage,argv,cap):calls.append((stage,argv,cap));return statuses.get(stage,0)
        def resolve(opts,pkgs):return ['changed'] if drift and 'retry' in opts else ['same']
        result=m.pipeline(run,resolve,['normal'],['a','b'],lambda:500,lambda code:['retry'])
        return result,calls
    def test_normal_first_success_install_once_no_download(self):
        code,calls=self.exercise({});self.assertEqual(code,0)
        self.assertEqual([x[0] for x in calls],['update','download-first','install-no-download'])
        self.assertIn('--download-only',calls[1][1]);self.assertIn('--no-download',calls[-1][1])
        self.assertEqual(calls[1][2],150);self.assertEqual(calls[-1][2],500)
    def test_slow_first_then_one_retry(self):
        code,calls=self.exercise({'download-first':124});self.assertEqual(code,0)
        self.assertEqual([x[0] for x in calls],['update','download-first','retry-update','download-retry','install-no-download'])
        self.assertLessEqual(calls[3][2],270)
    def test_both_fail_no_install(self):
        code,calls=self.exercise({'download-first':124,'download-retry':100});self.assertEqual(code,100)
        self.assertNotIn('install-no-download',[x[0] for x in calls])
    def test_dpkg_failure_not_retried(self):
        code,calls=self.exercise({'install-no-download':42});self.assertEqual(code,42)
        self.assertEqual(sum(x[0]=='install-no-download' for x in calls),1)
        self.assertNotIn('download-retry',[x[0] for x in calls])
    def test_update_failure_never_switches_pool(self):
        code,calls=self.exercise({'update':100});self.assertEqual(code,100);self.assertEqual(len(calls),1)
    def test_resolution_drift_blocks_dpkg(self):
        code,calls=self.exercise({'download-first':124},True);self.assertEqual(code,64)
        self.assertNotIn('install-no-download',[x[0] for x in calls])
    def test_uncertain_cleanup_never_retries(self):
        code,calls=self.exercise({'download-first':125});self.assertEqual(code,125)
        self.assertEqual(len(calls),2)
    def test_no_remaining_budget(self):
        calls=[]
        code=m.pipeline(lambda *a:(calls.append(a) or 0),lambda *a:[],[],[],lambda:100,lambda *a:self.fail())
        self.assertEqual(code,124);self.assertEqual(len(calls),1)
    def test_normal_native_security_flags(self):
        options=m.apt_options()
        for expected in ('APT::Get::AllowUnauthenticated=false','Acquire::Check-Date=true','Acquire::Check-Valid-Until=true','APT::Update::Error-Mode=any'):
            self.assertIn(expected,options)

class OwnProcesses(unittest.TestCase):
    def test_native_failure_status(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(m.supervise([sys.executable,'-c','raise SystemExit(100)'],2,Path(d)/'log'),100)
    def test_timeout_reaps_detached_child_and_releases_real_lock(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);lock=root/'apt.lock';pidfile=root/'child.json';ready=root/'ready'
            child=f'''import fcntl,os,pathlib,signal,time,json
f=open({str(lock)!r},'w');fcntl.lockf(f,fcntl.LOCK_EX)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
pathlib.Path({str(pidfile)!r}).write_text(json.dumps(os.getpid()))
pathlib.Path({str(ready)!r}).touch()
time.sleep(60)
'''
            parent=f'''import subprocess,sys,time,pathlib
subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True)
while not pathlib.Path({str(ready)!r}).exists():time.sleep(.01)
time.sleep(60)
'''
            start=time.monotonic();code=m.supervise([sys.executable,'-c',parent],.4,root/'log')
            self.assertEqual(code,124);self.assertLess(time.monotonic()-start,2.5)
            pid=json.loads(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)
            with lock.open('r+') as stream:fcntl.lockf(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def test_term_handler_zero_is_still_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            script='import signal,sys,time;signal.signal(signal.SIGTERM,lambda *_:sys.exit(0));time.sleep(60)'
            self.assertEqual(m.supervise([sys.executable,'-c',script],.2,Path(d)/'log'),124)

class Unsupported(unittest.TestCase):
    def test_missing_or_unrecognised_profile_never_runs_apt(self):
        with tempfile.TemporaryDirectory() as d,patch.object(m,'pipeline') as pipeline:
            self.assertEqual(m.main('chromium',int(time.time()*1000)+500000,Path(d)),78)
            pipeline.assert_not_called()
    def test_azure_or_plain_list_preserves_legacy(self):
        from test_ubuntu_mirror_candidate import SOURCES
        for mirrors in ('https://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n',m.__dict__.get('FIRST','http://us-east-2.ec2.archive.ubuntu.com/ubuntu/')+'\nhttps://archive.ubuntu.com/ubuntu/\n'):
            with tempfile.TemporaryDirectory() as d,patch.object(m,'pipeline') as pipeline:
                root=Path(d);(root/'sources.list.d').mkdir();(root/'sources.list.d/ubuntu.sources').write_text(SOURCES)
                (root/'apt-mirrors.txt').write_text(mirrors)
                self.assertEqual(m.main('chromium',int(time.time()*1000)+500000,root),78)
                pipeline.assert_not_called()
    def test_workflow_and_existing_outer_boundary_unchanged(self):
        workflow=(ROOT/'.github/workflows/ci-test-e2e.yml').read_bytes()
        # Checkout is shallow in CI: assert the supported contract directly,
        # never require an unavailable historical parent object.
        import re
        declared=re.findall(rb'^        project: \[([^\]]+)\]',workflow,re.M)
        self.assertEqual(len(declared),1)
        rows=[v.strip() for v in declared[0].decode().split(',')]
        expected='basic core-1 core-2 core-3 core-4 core-4b core-5 core-6 core-7 core-8 new-1 new-2-1 new-2-2 new-3a new-3b new-4 new-5 auth utils server yjs tables-1 tables-2 schedule onprem firefox-selection-core-4 firefox-selection-core-4b firefox-selection-new firefox-selection-basic'.split()
        self.assertEqual(rows,expected)
        self.assertIn(b'  e2e-test:\n    runs-on: ubuntu-latest',workflow)
        self.assertIn(b'    needs: e2e-test\n',workflow)
        self.assertIn(b'    needs: [e2e-test, selection-coverage]\n',workflow)
        self.assertIn(b'  selection-coverage:',workflow)
        added = ("      - name: Verify mirror-only control and owned-child cleanup\n"
                 "        run: python3 -m unittest discover -s scripts/tests -p 'test_ubuntu_mirror*.py' -v\n").encode()
        self.assertEqual(workflow.count(added),1)
        text=(ROOT/'scripts/setup-direct-runner-os.sh').read_text()
        self.assertIn('budget=${E2E_OS_BUDGET_SECONDS:-600}',text)
        self.assertIn('budget > 600',text)
        self.assertIn('verify_required_os_packages "${required_sdk[@]}"',text)

class RealChildPipeline(unittest.TestCase):
    def test_slow_download_child_then_fallback_offline_install(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);state=root/'state';lock=root/'lock';script=root/'apt-fixture.py'
            script.write_text('''import fcntl,json,pathlib,sys,time
root=pathlib.Path(sys.argv[1]);args=sys.argv[2:]
state=root/'state';data=json.loads(state.read_text()) if state.exists() else {'downloads':0,'installs':0}
if '--download-only' in args:
    data['downloads']+=1;state.write_text(json.dumps(data))
    if '--fallback' not in args:
        with (root/'lock').open('w') as f:
            fcntl.lockf(f,fcntl.LOCK_EX);print('fixture acquisition progress',flush=True);time.sleep(60)
    else:(root/'verified-deb').write_bytes(b'fixture-deb')
elif '--no-download' in args:
    assert (root/'verified-deb').read_bytes()==b'fixture-deb'
    with (root/'lock').open('r+') as f:fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
    data['installs']+=1;state.write_text(json.dumps(data))
''')
            deadline=time.monotonic()+4
            def run(stage,argv,cap):
                return m.supervise([sys.executable,str(script),str(root),*argv[1:]],cap,root/'log')
            def retry(code):
                self.assertEqual(code,124)
                with lock.open('r+') as f:fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
                return ['--fallback']
            with patch.object(m,'FIRST_SECONDS',.2),patch.object(m,'RETRY_SECONDS',1),patch.object(m,'RESERVE_SECONDS',.1):
                code=m.pipeline(run,lambda *a:[],[],['fixture'],lambda:max(0,deadline-time.monotonic()),retry)
            self.assertEqual(code,0)
            self.assertEqual(json.loads(state.read_text()),{'downloads':2,'installs':1})
