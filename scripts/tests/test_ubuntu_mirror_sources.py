"""Private synthetic source copies only; original host files are never used."""
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
spec=importlib.util.spec_from_file_location('mirror_sources',ROOT/'scripts/ci/ubuntu_mirror_download.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class SourceCopies(unittest.TestCase):
    def test_ubuntu_archive_only_vendor_security_and_originals_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);etc=root/'etc';dest=root/'private'
            (etc/'sources.list.d').mkdir(parents=True);dest.mkdir()
            ubuntu=etc/'sources.list.d/ubuntu.sources';ubuntu.write_text(SOURCES)
            vendor='deb [arch=amd64] https://packages.microsoft.com/ubuntu/26.04/prod resolute main\n'
            (etc/'sources.list.d/microsoft-prod.list').write_text(vendor)
            (etc/'apt-mirrors.txt').write_text(MIRRORS)
            changed=SOURCES.replace(m.__dict__.get('MIRROR_URI','mirror+file:/etc/apt/apt-mirrors.txt'),'mirror+file:'+str(dest/'mirrors.txt'))
            opts=m.copy_sources(etc,dest,changed,'https://archive.ubuntu.com/ubuntu/\tpriority:2\n')
            self.assertIn('Dir::Etc::sourceparts='+str(dest/'sources.list.d'),opts)
            self.assertEqual((dest/'sources.list.d/microsoft-prod.list').read_text(),vendor)
            self.assertEqual((dest/'sources.list.d/ubuntu.sources').read_text().split('\n\n')[1],SOURCES.split('\n\n')[1])
            self.assertEqual(ubuntu.read_text(),SOURCES)
            self.assertEqual((etc/'apt-mirrors.txt').read_text(),MIRRORS)
    def test_confirmed_unsafe_source_never_runs_apt_or_legacy(self):
        for field in ('Trusted: yes','Check-Valid-Until: no','Allow-Insecure: yes','Valid-Until-Min: 0'):
            with tempfile.TemporaryDirectory() as d,patch.object(m,'pipeline') as pipeline:
                etc=Path(d);(etc/'sources.list.d').mkdir()
                (etc/'sources.list.d/ubuntu.sources').write_text(SOURCES+'\n'+field+'\n')
                (etc/'apt-mirrors.txt').write_text(MIRRORS)
                self.assertEqual(m.main('firefox',int(time.time()*1000)+500000,etc),64)
                pipeline.assert_not_called()
    def test_later_unsafe_source_wins_over_earlier_unsupported_layout(self):
        with tempfile.TemporaryDirectory() as d,patch.object(m,'pipeline') as pipeline:
            etc=Path(d);(etc/'sources.list.d').mkdir()
            sources=SOURCES.replace('resolute resolute-updates resolute-backports','resolute-proposed')
            (etc/'sources.list.d/ubuntu.sources').write_text(sources+'\nAllow-Insecure: yes\n')
            (etc/'apt-mirrors.txt').write_text(MIRRORS)
            self.assertEqual(m.main('firefox',int(time.time()*1000)+500000,etc),64)
            pipeline.assert_not_called()
    def test_duplicate_ubuntu_source_preserves_legacy_instead_of_partial_override(self):
        with tempfile.TemporaryDirectory() as d,patch.object(m,'pipeline') as pipeline:
            etc=Path(d);(etc/'sources.list.d').mkdir()
            (etc/'sources.list.d/ubuntu.sources').write_text(SOURCES)
            (etc/'apt-mirrors.txt').write_text(MIRRORS)
            (etc/'sources.list').write_text('deb http://archive.ubuntu.com/ubuntu/ resolute main\n')
            self.assertEqual(m.main('chromium',int(time.time()*1000)+500000,etc),78)
            pipeline.assert_not_called()

class InterruptCleanup(unittest.TestCase):
    def test_cancelled_supervisor_does_not_leave_owned_lock_holder(self):
        import fcntl,json,os,signal,subprocess,time
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);lock=root/'lock';ready=root/'ready';pidfile=root/'pid'
            child=f'''import fcntl,os,pathlib,time
f=open({str(lock)!r},'w');fcntl.lockf(f,fcntl.LOCK_EX)
pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid()))
pathlib.Path({str(ready)!r}).touch();time.sleep(60)
'''
            control=f'''import sys,pathlib
sys.path.insert(0,{str(ROOT/'scripts/ci')!r})
import ubuntu_mirror_download as m
sys.exit(m.supervise([sys.executable,'-c',{child!r}],10,pathlib.Path({str(root/'log')!r})))
'''
            process=subprocess.Popen([sys.executable,'-c',control])
            try:
                until=time.monotonic()+3
                while not ready.exists() and time.monotonic()<until:time.sleep(.02)
                self.assertTrue(ready.exists())
                process.send_signal(signal.SIGINT)
                self.assertEqual(process.wait(timeout=3),130)
                with self.assertRaises(ProcessLookupError):os.kill(int(pidfile.read_text()),0)
                with lock.open('r+') as f:fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:
                if process.poll() is None:
                    process.terminate();process.wait(timeout=3)

class EffectiveConfig(unittest.TestCase):
    SAFE="ROOT='/'\nETC='etc/apt'\nMAIN='sources.list'\nPARTS='sources.list.d'\nTRUST='trusted.gpg'\nTRUST_PARTS='trusted.gpg.d'\n"
    def test_standard_layout_and_defaults_supported(self):
        with patch.dict(m.os.environ,{'APT_CONFIG':''}),patch.object(m.subprocess,'check_output',return_value=self.SAFE):
            self.assertTrue(m.effective_sources_supported())
    def test_signature_or_expiry_disabled_is_refused(self):
        for line in ("VALID_UNTIL='false'", "CHECK_DATE='no'", "UNAUTH='true'", "INSECURE='true'", "WEAK='yes'"):
            with patch.dict(m.os.environ,{'APT_CONFIG':''}),patch.object(m.subprocess,'check_output',return_value=self.SAFE+line):
                with self.assertRaises(ValueError):m.effective_sources_supported()
    def test_different_effective_sources_not_silently_used(self):
        with patch.dict(m.os.environ,{'APT_CONFIG':''}),patch.object(m.subprocess,'check_output',return_value=self.SAFE.replace("PARTS='sources.list.d'","PARTS='/other'")):
            self.assertFalse(m.effective_sources_supported())
