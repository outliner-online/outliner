"""Offline smoke, not a direct-E2E replacement or complete readiness certificate."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import prepared_profile as profile
from seal import cache_inventory


def main():
    root = Path('/prepared/source')
    sealed = json.loads(Path('/prepared/producer.json').read_text())
    expected_source = Path('/prepared/source-revision').read_text().strip()
    if sealed['source_revision'] != expected_source or os.environ.get('EXPECTED_SOURCE_REVISION') != expected_source:
        raise ValueError('Source revision mismatch')
    base_plan = {k: sealed[k] for k in profile.plan(root)}
    profile.verify_plan(root, base_plan)
    expected = sealed['emulator_cache']
    cache = Path('/opt/emulator-cache')
    actual = cache_inventory(cache)
    if not expected or actual != expected:
        raise ValueError('Incomplete or mismatched emulator cache')
    supply = json.loads(Path(__file__).with_name('node-supply.json').read_text())
    if subprocess.check_output(['node', '--version'], text=True, timeout=5).strip() != 'v' + supply['version']:
        raise ValueError('Exact Node supply mismatch')
    check = profile.check(root, base_plan)  # Actual package/providers and BOTH launches.
    if check.get('slice') != 'identity-package-and-browser-checks-passed' or check['readiness']:
        raise ValueError('Invalid slice result')
    subprocess.run(['bash', str(root / 'scripts/verify-test-container-os-tools.sh')],
                   check=True, timeout=15)
    fixture = Path('/tmp/private-fixture')
    shutil.copytree('/prepared/fixture', fixture, symlinks=True)
    # No updater/install step; network-none prevents download fallback. Baked cache
    # must suffice. GNU timeout bounds only this newly started emulator group.
    cmd = ['timeout', '--signal=TERM', '--kill-after=5', '120', 'firebase',
           'emulators:exec', '--project', 'demo-prepared-runtime', '--only',
           'auth,firestore,functions,hosting', '--config', str(fixture / 'firebase.json'),
           'node /prepared/source/scripts/ci/prebuilt/emulator-smoke.cjs']
    subprocess.run(cmd, cwd=fixture, check=True, timeout=130)
    print(json.dumps({'scope': 'isolated-prepared-image-smoke', 'image_smoke_passed': True,
                      'readiness': False, 'E2E_executed': False, 'source_revision': expected_source}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        print(json.dumps({'scope': 'isolated-prepared-image-smoke', 'image_smoke_passed': False, 'readiness': False}))
        raise SystemExit(1)
