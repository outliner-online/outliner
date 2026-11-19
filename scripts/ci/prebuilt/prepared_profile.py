#!/usr/bin/env python3
"""Local prototype: draft producer plan and fail-closed check-only slice.

No install/refresh, workflow integration or complete runtime certification.
The caller must be an isolated prepared image, never a user's live environment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import shutil
import subprocess
import time

BASE = 'mcr.microsoft.com/playwright@sha256:a3966b653e8d48a30901889081b616307fca73e0d843a117fadf6609397dac38'
INPUTS = ('package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json',
          'server/package.json', 'server/package-lock.json', 'functions/package.json',
          'functions/package-lock.json', 'scripts/package.json', 'scripts/package-lock.json',
          'shared/package.json', 'shared/package-lock.json', '.firebase-tools-version', 'scripts/common-functions.sh',
          'scripts/setup-direct-runner-os.sh', 'scripts/locked-browser-os-packages.cjs',
          'scripts/require-java-21.sh', 'scripts/verify-test-container-os-tools.sh', 'scripts/ci-e2e-start.sh', 'firebase.json',
          'firebase.emulator.json', '.github/container/Dockerfile')
BLOCKERS = ['producer acquisition for BOTH browsers within ONE 600-second bound not executed',
            'Node22 supply and native ABI image build not verified',
            'private emulator startup/cache completeness not verified',
            'trusted same-run producer receipt and actual pulled image digest not integrated',
            'nonroot real E2E and artifact retention not validated',
            'all installed npm transitive bytes/native ABI not certified by this slice']


def inputs(root):
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in INPUTS}


def required(root):
    # Only support the current literal declarations; unknown syntax is a blocker.
    text = (root / 'scripts/common-functions.sh').read_text()
    names = set()
    for label in ('CANVAS_NATIVE_DEPS', 'playwright_deps', 'original_deps'):
        matches = re.findall(r'(?m)^\s*(?:local )?' + label + r'=\(\s*\n([^)]*)\)', text)
        if len(matches) != 1:
            raise ValueError('Unsupported repository dependency declarations')
        values = shlex.split(matches[0], comments=True)
        if not values or any(not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', v) for v in values):
            raise ValueError('Nonliteral dependency declaration')
        names.update(values)
    return sorted(names)


def plan(root):
    lock = json.loads((root / 'client/package-lock.json').read_text())['packages']
    sdk = {name: {k: lock['node_modules/' + name][k] for k in ('version', 'integrity')}
           for name in ('@playwright/test', 'playwright', 'playwright-core')}
    if {v['version'] for v in sdk.values()} != {'1.64.1'}:
        raise ValueError('Locked SDK versions disagree')
    return {'schema': 1, 'readiness': False, 'stage': 'unexecuted-producer-plan',
            'base': BASE, 'platform': 'linux/amd64', 'node_major': 22, 'java_major': 21,
            'firebase': (root / '.firebase-tools-version').read_text().strip(), 'sdk': sdk,
            'inputs': inputs(root), 'required_by_repository': required(root),
            'prototype_verifier_sha256': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                          for name in ('prepared_profile.py', 'check_browsers.cjs')},
            'blockers': BLOCKERS}


def verify_plan(root, draft):
    if draft != plan(root):
        raise ValueError('Plan differs from current locked source/profile')


def probe(argv, deadline):
    remaining = min(20, deadline - time.monotonic())
    if remaining <= 0:
        raise ValueError('Check-only slice deadline exceeded')
    # No arbitrary command injection and no stdout/stderr saved in evidence.
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, _ = child.communicate(timeout=remaining)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
        raise
    if child.returncode or len(stdout) > 1048576:
        raise ValueError('Check-only probe failed or output exceeded bound')
    return stdout.decode('utf-8')


def firebase_version():
    executable = shutil.which('firebase')
    if not executable:
        raise ValueError('Installed Firebase CLI required')
    # Inspect the installed CLI package, never auth configuration or an updater.
    for directory in Path(executable).resolve().parents:
        package = directory / 'package.json'
        if package.is_file():
            data = json.loads(package.read_text())
            if data.get('name') == 'firebase-tools':
                return data.get('version')
    raise ValueError('Installed Firebase CLI package not resolved')


def check(root, draft):
    verify_plan(root, draft)
    if os.getuid() == 0:
        raise ValueError('Nonroot consumer required')
    if firebase_version() != draft['firebase']:
        raise ValueError('Installed Firebase CLI differs from pin')
    deadline = time.monotonic() + 60
    node = probe(['node', '-p', 'process.versions.node'], deadline).strip()
    if not re.fullmatch(r'22\.\d+\.\d+', node):
        raise ValueError('Node22 required')
    # Java --version writes stdout; no installer/helper that acquires Java.
    java = probe(['java', '--version'], deadline)
    if not re.match(r'(?:openjdk|java) 21(?:[. +\n])', java):
        raise ValueError('Java21 required')
    declarations = []
    for browser in ('chromium', 'firefox'):
        d = json.loads(probe(['node', str(root / 'scripts/locked-browser-os-packages.cjs'),
                              str(root), browser], deadline))
        if d.get('browser') != browser or d.get('version') != draft['sdk']['playwright-core']['version']:
            raise ValueError('Invalid locked SDK declaration')
        if not d.get('packages') or any(not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', x) for x in d['packages']):
            raise ValueError('Incomplete SDK package set')
        declarations.extend(d['packages'])
    packages = sorted(set(required(root) + declarations))
    # Reuse authoritative installed-state/provider verifier; never install_os_utilities.
    probe(['bash', '-c', 'source "$1/scripts/common-functions.sh"; shift; verify_required_os_packages "$@"',
           'prepared-consumer', str(root), *packages], deadline)
    launch = json.loads(probe(['node', str(Path(__file__).with_name('check_browsers.cjs')), str(root)], deadline))
    if launch != {'chromium': 'launched-and-closed', 'firefox': 'launched-and-closed'}:
        raise ValueError('Both real browser launches required')
    # This slice deliberately cannot certify full runtime from partial evidence.
    return {'readiness': False, 'slice': 'identity-package-and-browser-checks-passed',
            'node': node, 'required_package_count': len(packages), 'blockers': BLOCKERS}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['plan', 'check'])
    p.add_argument('--root', required=True, type=Path)
    p.add_argument('--plan', type=Path)
    a = p.parse_args()
    try:
        if a.mode == 'plan':
            print(json.dumps(plan(a.root), indent=2))
            return 0
        if not a.plan:
            raise ValueError('An exact producer plan is required')
        print(json.dumps(check(a.root, json.loads(a.plan.read_text())), indent=2))
        return 78  # Incomplete runtime, even if this slice passed.
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({'readiness': False, 'slice': 'failed-or-unverified'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
