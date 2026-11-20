"""Test-process-only OS adapters; leave the production CLI/deadline/pipeline intact.

The trace installs adapters after module definitions but before argparse invokes
main. No application test seam or host APT/root mutation is required.
"""
import json
import os
from pathlib import Path
import sys
import time

real_time = time.time
def wall_shift():
    root = Path(os.environ['FIXTURE_DIR'])
    if (root / 'clock').exists():
        return float((root / 'clock').read_text())
    return float(os.environ.get('WALL_SHIFT', '0')) if (root / 'crossed').exists() else 0


time.time = lambda: real_time() + wall_shift()


def configure(frame, event, arg):
    if frame.f_code.co_filename.endswith('/ubuntu_mirror_download.py') and event == 'line':
        scope = frame.f_globals
        if 'main' in scope and '__fixture_configured' not in scope:
            scope['__fixture_configured'] = True
            scope['main'].__defaults__ = (Path(os.environ['FIXTURE_DIR']) / 'apt',)
            # OS identity/config/SDK are adapters, not the deadline, profile,
            # stage planner, fallback policy, subprocesses or watchdog.
            with (Path(os.environ['FIXTURE_DIR']) / 'identity').open('a') as stream:
                stream.write(json.dumps({'uid': os.geteuid(), 'deadline': (sys.argv[sys.argv.index('--deadline-ms') + 1] if '--deadline-ms' in sys.argv else None)}) + '\n')
            scope['os'].geteuid = lambda: 0
            scope['effective_sources_supported'] = lambda: True
            scope['required'] = lambda browser: ['fixture-package']
            sys.settrace(None)
    return configure


sys.settrace(configure)
