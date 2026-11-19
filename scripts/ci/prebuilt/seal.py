"""Records input/cache hashes ONLY after producer commands have exited zero."""
import hashlib
import json
import re
from pathlib import Path
import prepared_profile as profile


def cache_inventory(cache):
    paths = sorted(cache.rglob('*'))
    if any(p.is_symlink() for p in paths):
        raise ValueError('Untrusted emulator cache')
    files = [p for p in paths if p.is_file()]
    if not files:
        raise ValueError('Incomplete emulator cache')
    result = {}
    for p in files:
        with p.open('rb') as stream:
            digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
            result[str(p.relative_to(cache))] = digest.hexdigest()
    return result


def main():
    source = Path('/prepared/source')
    plan = profile.plan(source)
    plan['emulator_cache'] = cache_inventory(Path('/opt/emulator-cache'))
    plan['source_revision'] = Path('/prepared/source-revision').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', plan['source_revision']):
        raise ValueError('Invalid source revision')
    plan['scope'] = 'prototype-build-inputs-not-E2E-ready'
    Path('/prepared/producer.json').write_text(json.dumps(plan, indent=2) + '\n')


if __name__ == '__main__':
    main()
