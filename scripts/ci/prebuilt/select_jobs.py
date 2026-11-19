"""Match actual prototype COPY/runtime inputs without unrelated image builds."""
from pathlib import Path
import sys

SHARED_WORKFLOW = '.github/workflows/ci-test-container-build.yml'
PROTOTYPE_EXACT = {
    '.github/container/Dockerfile.prebuilt-prototype', '.github/container/Dockerfile',
    SHARED_WORKFLOW, '.dockerignore', '.firebase-tools-version', 'firebase.json',
    'firebase.emulator.json', 'package.json', 'package-lock.json',
    *{f'{directory}/{name}' for directory in ('client', 'server', 'functions', 'shared')
      for name in ('package.json', 'package-lock.json')},
}
PROTOTYPE_PREFIXES = ('scripts/', 'patches/', 'client/patches/')


def select(paths):
    def prototype_only(path):
        return path.startswith('scripts/ci/prebuilt/') or path == '.github/container/Dockerfile.prebuilt-prototype'
    def legacy(path):
        return (path in (SHARED_WORKFLOW, '.github/container/Dockerfile', '.firebase-tools-version',
                         '.dockerignore', 'firebase.json', 'firebase.emulator.json', 'shared/package.json')
                or (path.startswith('scripts/') and not prototype_only(path))
                or path in {f'{directory}/{name}' for directory in ('client', 'server', 'functions')
                            for name in ('package.json', 'package-lock.json')}
                or path in ('package.json', 'package-lock.json'))
    return {'legacy': any(legacy(p) for p in paths),
            'prototype': any(p in PROTOTYPE_EXACT or p.startswith(PROTOTYPE_PREFIXES) for p in paths)}


if __name__ == '__main__':
    paths = [p.decode('utf-8') for p in Path(sys.argv[1]).read_bytes().split(b'\0') if p]
    for name, value in select(paths).items():
        print(f'{name}={str(value).lower()}')
