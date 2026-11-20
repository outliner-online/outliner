#!/usr/bin/env python3
"""Strict-runner only: confirmed EC2 priority1 download failover, not dpkg retry.
No host source/config mutation. Unsupported profiles return78 for legacy setup.
"""
import argparse
import ctypes
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from ubuntu_mirror_candidate import fallback_plan, source_fields

ROOT = Path(__file__).resolve().parents[2]
FIRST_SECONDS = 150
RETRY_SECONDS = 270
RESERVE_SECONDS = 120
UNSUPPORTED = 78

# Reuse only the repository's established owned-descendant reader, not its E2E
# report policy. No other processes are selected or signalled.
spec = importlib.util.spec_from_file_location('owned_e2e', ROOT / 'scripts/ci/run-bounded-e2e.py')
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)


def supervise(argv, seconds, log):
    if seconds <= 0:
        return 124
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):
        return 125
    interrupted = [None]
    previous = {sig: signal.signal(sig, lambda number, _frame: interrupted.__setitem__(0, number))
                for sig in (signal.SIGTERM, signal.SIGINT)}
    child = None
    started = time.monotonic()
    reason = None
    stopping = None
    try:
        with log.open('ab') as stream:
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stream,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            while True:
                code = child.poll()
                rows = owned.descendants()
                for row in rows:
                    if row['ppid'] == os.getpid() and row['pid'] != child.pid:
                        try:
                            os.waitpid(row['pid'], os.WNOHANG)
                        except ChildProcessError:
                            pass
                rows = owned.descendants()
                now = time.monotonic()
                if reason is None:
                    if interrupted[0]:
                        reason = 128 + interrupted[0]
                    elif now - started >= seconds:
                        reason = 124
                    elif code is not None and rows:
                        reason = code if code > 0 else 125
                    elif code is not None:
                        return code if code >= 0 else 128 - code
                    if reason is not None:
                        stopping = now
                if reason is not None:
                    for row in rows:
                        if row['state'] != 'Z':
                            try:
                                os.kill(row['pid'], signal.SIGTERM if now - stopping < 0.8 else signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            except PermissionError:
                                return 125
                    if code is not None and not rows:
                        return reason
                    if now - stopping > 1.5:
                        return 125  # Cleanup uncertain: never retry or enter dpkg.
                time.sleep(0.02)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def read_public(path, cap):
    if path.resolve() != path or not path.is_file() or path.stat().st_size > cap:
        raise ValueError('unsupported-public-file')
    return path.read_text()


def source_shape_summary(sources):
    """Bounded fixed enums only; no raw field, URI, path or exception output."""
    suite_sets = {
        frozenset(('resolute', 'resolute-updates', 'resolute-backports')): 'archive-three',
        frozenset(('resolute-security',)): 'security-only',
        frozenset(('resolute', 'resolute-updates', 'resolute-backports', 'resolute-security')): 'archive-and-security',
    }
    public_uris = {'mirror+file:/etc/apt/apt-mirrors.txt': 'image-mirrorlist'}
    for scheme in ('http', 'https'):
        for suffix in ('/ubuntu', '/ubuntu/'):
            public_uris[scheme + '://security.ubuntu.com' + suffix] = 'security-' + scheme
            public_uris[scheme + '://archive.ubuntu.com' + suffix] = 'archive-' + scheme
    for suffix in ('/ubuntu', '/ubuntu/'):
        public_uris['http://us-east-2.ec2.archive.ubuntu.com' + suffix] = 'ec2-http'
    blocks = [block for block in re.split(r'\n[ \t]*\n', sources) if block.strip()]
    rows = []
    unknown = max(0, len(blocks) - 3)
    for block in blocks[:3]:
        try:
            fields = source_fields(block)
        except ValueError:
            fields = {}
        suite = suite_sets.get(frozenset(fields.get('Suites', '').split()), 'other')
        uri = public_uris.get(fields.get('URIs'), 'other')
        rows.append({'suites': suite, 'uri': uri})
        unknown += suite == 'other' or uri == 'other'
    return {'paragraphs': rows, 'unknown_count': unknown}


def profile(etc):
    sources = read_public(etc / 'sources.list.d/ubuntu.sources', 16384)
    mirrors = read_public(etc / 'apt-mirrors.txt', 4096)
    print('APT-MIRROR source-shape=' + json.dumps(source_shape_summary(sources), sort_keys=True), flush=True)
    # A diagnostic only: never log raw URI credentials, config or exception text.
    keys = set()
    for line in mirrors.splitlines():
        for token in line.split()[1:]:
            keys.add('priority' if token.startswith('priority:') else 'other')
    print('APT-MIRROR shape=' + json.dumps({'mirror_records': len([line for line in mirrors.splitlines() if line.strip() and not line.startswith('#')]),
                                           'metadata_keys': sorted(keys), 'source_format': 'deb822'}), flush=True)
    for path in [etc / 'sources.list', *sorted((etc / 'sources.list.d').iterdir())]:
        if not path.exists() or path.name == 'ubuntu.sources' or (path.suffix not in ('.list', '.sources') and path.name != 'sources.list'):
            continue
        text = read_public(path, 16384)
        if any(uri in text for uri in ('archive.ubuntu.com', 'security.ubuntu.com', 'mirror+file:')):
            raise ValueError('duplicate-or-unknown-ubuntu-source')
        for uri in re.findall(r'https?://[^\s\]]+', text):
            value = urlsplit(uri)
            if value.username or value.password or value.query or value.fragment:
                raise ValueError('nonpublic-source')
    nonce = 'a' * 32  # Validation placeholder only; real temporary path below is separate.
    plan = fallback_plan(sources, mirrors, 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/pool/probe',
                         100, 595000, nonce, 'transport-error')
    return sources, mirrors, plan


def effective_sources_supported():
    # Query ONLY public path/boolean settings, not full apt-config output,
    # proxies, authentication or environment contents.
    if os.environ.get('APT_CONFIG'):
        return False
    keys = {'ROOT':'Dir', 'ETC':'Dir::Etc', 'MAIN':'Dir::Etc::sourcelist',
            'PARTS':'Dir::Etc::sourceparts', 'TRUST':'Dir::Etc::trusted',
            'TRUST_PARTS':'Dir::Etc::trustedparts', 'ROOTDIR':'RootDir',
            'CHECK_DATE':'Acquire::Check-Date', 'VALID_UNTIL':'Acquire::Check-Valid-Until',
            'UNAUTH':'APT::Get::AllowUnauthenticated', 'INSECURE':'Acquire::AllowInsecureRepositories',
            'WEAK':'Acquire::AllowWeakRepositories', 'DOWNGRADE':'Acquire::AllowDowngradeToInsecureRepositories'}
    args = ['apt-config', 'shell']
    for tag, key in keys.items():
        args.extend([tag, key])
    output = subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True, timeout=3)
    if len(output) > 8192:
        return False
    values = {}
    for token in shlex.split(output):
        tag, sep, value = token.partition('=')
        if not sep or tag not in keys or tag in values:
            return False
        values[tag] = value
    for tag in ('CHECK_DATE', 'VALID_UNTIL'):
        if tag in values and values[tag].lower() not in ('true', 'yes', '1'):
            raise ValueError('unsafe-effective-apt-security')
    for tag in ('UNAUTH', 'INSECURE', 'WEAK', 'DOWNGRADE'):
        if tag in values and values[tag].lower() not in ('false', 'no', '0'):
            raise ValueError('unsafe-effective-apt-security')
    paths = {'ROOT':{'/'}, 'ETC':{'etc/apt','/etc/apt'},
             'MAIN':{'sources.list','/etc/apt/sources.list'},
             'PARTS':{'sources.list.d','/etc/apt/sources.list.d'},
             'TRUST':{'trusted.gpg','/etc/apt/trusted.gpg'},
             'TRUST_PARTS':{'trusted.gpg.d','/etc/apt/trusted.gpg.d'}}
    return values.get('ROOTDIR','') in ('','/') and all(
        tag in values and values[tag].rstrip('/') in {value.rstrip('/') for value in allowed}
        for tag, allowed in paths.items())


def required(browser):
    text = (ROOT / 'scripts/common-functions.sh').read_text()
    packages = set()
    for label in ('CANVAS_NATIVE_DEPS', 'playwright_deps', 'original_deps'):
        matches = re.findall(r'(?m)^\s*(?:local )?' + label + r'=\(\s*\n([^)]*)\)', text)
        if len(matches) != 1:
            raise ValueError('repository-package-contract')
        names = shlex.split(matches[0], comments=True)
        if not names or any(not re.fullmatch('[a-z0-9][a-z0-9+.-]*', name) for name in names):
            raise ValueError('repository-package-contract')
        packages.update(names)
    output = subprocess.check_output(['node', str(ROOT / 'scripts/ci/mirror-browser-packages.cjs'), str(ROOT), browser], timeout=10)
    declaration = json.loads(output)
    packages.update(declaration['packages'])
    return sorted(packages)


def apt_options():
    return ['-o', 'APT::Update::Error-Mode=any', '-o', 'Acquire::Retries=1',
            '-o', 'Acquire::http::Timeout=15', '-o', 'Acquire::https::Timeout=15',
            '-o', 'Acquire::ForceIPv4=true', '-o', 'APT::Get::AllowUnauthenticated=false',
            '-o', 'Acquire::AllowInsecureRepositories=false', '-o', 'Acquire::AllowWeakRepositories=false',
            '-o', 'Acquire::AllowDowngradeToInsecureRepositories=false',
            '-o', 'Acquire::Check-Date=true', '-o', 'Acquire::Check-Valid-Until=true']


def copy_sources(etc, destination, sources, mirrors):
    parts = destination / 'sources.list.d'
    parts.mkdir(mode=0o755)
    for path in sorted((etc / 'sources.list.d').iterdir()):
        if path.suffix not in ('.list', '.sources'):
            continue
        text = read_public(path, 16384)
        for uri in re.findall(r'https?://[^\s\]]+', text):
            value = urlsplit(uri)
            if value.username or value.password or value.query or value.fragment:
                raise ValueError('nonpublic-source')
        target = parts / path.name
        target.write_text(sources if path.name == 'ubuntu.sources' else text)
        target.chmod(0o644)
    (destination / 'mirrors.txt').write_text(mirrors)
    (destination / 'mirrors.txt').chmod(0o644)
    (destination / 'lists').mkdir(mode=0o755)
    return ['-o', 'Dir::Etc::sourceparts=' + str(parts), '-o', 'Dir::State::lists=' + str(destination / 'lists')]


def transaction(options, packages):
    output = subprocess.check_output(['apt-get', *options, '--simulate', '--no-install-recommends', 'install', *packages],
                                     env={**os.environ, 'LC_ALL': 'C'}, text=True, timeout=10)
    return [line for line in output.splitlines() if line.startswith(('Inst ', 'Conf ', 'Remv '))]


def retry_evidence(code, text):
    """Attempt-local evidence for a narrowly scoped budget policy.
    Get proves a package transfer began, NOT the current outstanding origin.
    Call only after signed update and resolver success and owned-child cleanup.
    """
    if code not in (100, 124):
        return False, 'unsupported-native-exit'
    if re.search(r'(?i)(NO_PUBKEY|not signed|invalid signature|signatures could not be verified|hash sum mismatch|unexpected size|malformed entry|unmet dependencies|release file.*expired|not valid yet|does not have a release file)', text):
        return False, 'signature-or-contract-failure'
    if re.search(r'(?i)(waiting for .*lock|could not get lock|unable to acquire .*lock|dpkg was interrupted)', text):
        return False, 'lock-or-dpkg-owner'
    failures = re.findall(r'Failed to fetch (\S+)', text)
    for uri in failures:
        value = urlsplit(uri)
        if (value.scheme != 'http' or value.hostname != 'us-east-2.ec2.archive.ubuntu.com'
                or value.port is not None or value.username or value.password or value.query or value.fragment
                or not value.path.startswith('/ubuntu/pool/') or '..' in value.path.split('/')):
            return False, 'other-or-unknown-failed-origin'
    package_started = False
    for kind, uri, detail in re.findall(r'(?m)^(Get|Ign|Err|Hit):\d+\s+(\S+)\s+([^\n]+)', text):
        if uri == 'file:/etc/apt/apt-mirrors.txt' and re.fullmatch(r'Mirrorlist \[\d+ B\]', detail):
            continue
        value = urlsplit(uri)
        if (value.scheme != 'http' or value.hostname != 'us-east-2.ec2.archive.ubuntu.com'
                or value.path != '/ubuntu' or value.port is not None or value.username
                or value.password or value.query or value.fragment):
            return False, 'mixed-or-unidentified-acquisition-origin'
        if kind == 'Get' and re.fullmatch(
                r'resolute(?:-updates|-backports)?/(?:main|restricted|universe|multiverse) '
                r'(?:amd64|amd64v3|all) [a-z0-9][a-z0-9+.-]*(?::(?:amd64|amd64v3|all))? '
                r'(?:amd64|amd64v3|all) [^\s]+ \[\d+(?:[.,]\d+)? (?:B|kB|MB|GB)\]', detail):
            package_started = True
    if code == 124:
        if re.search(r'(?m)^E:', text):
            return False, 'explicit-apt-error-before-timeout'
        if not package_started:
            return False, 'package-download-start-unobserved'
        return True, 'first-download-budget-policy-not-current-owner'
    if not failures:
        return False, 'target-fetch-failure-unobserved'
    return True, 'target-pool-native-fetch-failure'


def pipeline(run, resolve, options, packages, remaining, make_retry):
    # run is the bounded root supervisor. No phase-specific short deadline for dpkg.
    status = run('update', ['apt-get', *options, 'update'], remaining())
    if status:
        return status
    expected = resolve(options, packages)
    first = min(FIRST_SECONDS, (remaining() - RESERVE_SECONDS) / 2)
    if first <= 0:
        return 124
    status = run('download-first', ['apt-get', *options, '--download-only', '--yes', '--no-install-recommends', 'install', *packages], first)
    if status:
        if status not in (100, 124):
            return status
        retry = make_retry(status)
        if retry is None:
            return status
        retry_time = min(RETRY_SECONDS, remaining() - RESERVE_SECONDS)
        if retry_time <= 0:
            return 124
        start_retry = time.monotonic()
        status = run('retry-update', ['apt-get', *retry, 'update'], retry_time)
        if status:
            return status
        if resolve(retry, packages) != expected:
            return 64
        retry_time = min(retry_time - (time.monotonic() - start_retry), remaining() - RESERVE_SECONDS)
        if retry_time <= 0:
            return 124
        status = run('download-retry', ['apt-get', *retry, '--download-only', '--yes', '--no-install-recommends', 'install', *packages], retry_time)
        if status:
            return status
        options = retry
    if resolve(options, packages) != expected:
        return 64
    return run('install-no-download', ['apt-get', *options, '--no-download', '--yes', '--no-install-recommends', 'install', *packages], remaining())


def main(browser, deadline_ms, etc=Path('/etc/apt')):
    try:
        sources, mirrors, plan = profile(etc)
    except (OSError, ValueError) as error:
        supported_reasons = {'unsupported-ranked-mirror-metadata', 'not-observed-ec2-pool-with-existing-next-candidate', 'unsupported-deb822-or-folding', 'unsupported-ubuntu-source-contract', 'unsupported-suite-source-layout', 'incomplete-source-layout', 'weakened-source-trust', 'weakened-source-validity', 'duplicate-or-unknown-ubuntu-source'}
        if isinstance(error, ValueError) and str(error) in {'weakened-source-trust', 'weakened-source-validity', 'nonpublic-source'}:
            print('APT-MIRROR unsafe source; refusing acquisition', flush=True)
            return 64
        reason = str(error) if isinstance(error, ValueError) and str(error) in supported_reasons else 'unsupported-or-unreadable'
        print('APT-MIRROR profile=unsupported reason=' + reason + '; preserving existing setup', flush=True)
        return UNSUPPORTED
    if os.geteuid() != 0:
        print('APT-MIRROR guard=refused reason=requires-root', flush=True)
        return 64
    guard_remaining = deadline_ms - (time.monotonic_ns() // 1000000)
    if not (0 < guard_remaining <= 595000):
        reason = 'deadline-expired' if guard_remaining <= 0 else 'deadline-out-of-range'
        print('APT-MIRROR guard=refused reason=' + reason, flush=True)
        return 64
    if not effective_sources_supported():
        print('APT-MIRROR effective source layout unsupported; preserving existing setup', flush=True)
        return UNSUPPORTED
    print('APT-MIRROR profile=ec2-resolute-priority1 first-max=150s retry-max=270s reserve=120s aggregate=600s', flush=True)
    packages = required(browser)
    def remaining():
        return max(0, (deadline_ms - time.monotonic_ns() / 1000000) / 1000 - 1.7)
    temp = tempfile.mkdtemp(prefix='outliner-apt-')
    result = 125
    try:
        directory = Path(temp)
        directory.chmod(0o755)
        stage_logs = {}
        before_dpkg = hashlib.sha256(Path('/var/lib/dpkg/status').read_bytes()).hexdigest()
        print('APT-MIRROR dpkg-before=' + before_dpkg, flush=True)
        def run(stage, argv, seconds):
            print('APT-MIRROR stage=' + stage + ' started=' + str(time.time()) + ' budget=' + str(round(seconds, 2)), flush=True)
            log = directory / (stage + '.log')
            if log.exists():
                raise ValueError('stage-evidence-reuse')
            code = supervise(argv, seconds, log)
            after_dpkg = hashlib.sha256(Path('/var/lib/dpkg/status').read_bytes()).hexdigest()
            print('APT-MIRROR dpkg-after-stage=' + stage + ' hash=' + after_dpkg, flush=True)
            if code != 125 and stage != 'install-no-download' and after_dpkg != before_dpkg:
                code = 64
            # APT already logs public acquisition evidence in the legacy path.
            # Keep bounded output for diagnosis; no environment/config dump.
            data = b''
            complete = False
            if log.is_file():
                with log.open('rb') as stream:
                    data = stream.read(262144)
                complete = log.stat().st_size <= 262144
            stage_logs[stage] = {'path': log, 'code': code, 'complete': complete}
            sys.stdout.buffer.write(data);sys.stdout.flush()
            print('APT-MIRROR stage=' + stage + ' exit=' + str(code) + ' ended=' + str(time.time()), flush=True)
            return code
        def retry(code):
            evidence = stage_logs.get('download-first')
            if not evidence or evidence['code'] != code or not evidence['complete']:
                print('APT-MIRROR fallback-refused reason=incomplete-download-first-evidence', flush=True)
                return None
            text = evidence['path'].read_text(errors='replace')
            eligible, reason = retry_evidence(code, text)
            print('APT-MIRROR retry-evidence=' + reason, flush=True)
            if not eligible:
                return None
            # Use a fresh private copy. Never overwrite the image mirror/source files.
            actual = plan['ubuntu_sources'].replace('/tmp/outliner-apt-' + 'a' * 32 + '/mirrors.txt', str(directory / 'mirrors.txt'))
            return [*apt_options(), *copy_sources(etc, directory, actual, plan['private_mirrorlist'])]
        result = pipeline(run, transaction, apt_options(), packages, remaining, retry)
        return result
    finally:
        if result != 125:
            shutil.rmtree(temp)
        else:
            print('APT-MIRROR cleanup=uncertain; own temporary evidence retained', flush=True)


if __name__ == '__main__':
    import sys
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=('chromium', 'firefox'), required=True)
    parser.add_argument('--deadline-ms', type=int, required=True, help='Linux CLOCK_MONOTONIC deadline in milliseconds')
    args = parser.parse_args()
    try:
        raise SystemExit(main(args.browser, args.deadline_ms))
    except (OSError, ValueError, subprocess.SubprocessError, KeyError):
        print('APT-MIRROR contract/setup failure; no retry', flush=True)
        raise SystemExit(64)
