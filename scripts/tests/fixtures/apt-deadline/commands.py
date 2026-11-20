#!/usr/bin/python3
"""Offline command adapters. Every acquisition runs as a real child process."""
import json
import os
from pathlib import Path
import signal
import sys
import time

root = Path(os.environ['FIXTURE_DIR'])
command = Path(sys.argv[0]).name
args = sys.argv[1:]

def record(kind, **values):
    with (root / 'events').open('a') as stream:
        stream.write(json.dumps(dict(kind=kind, at=time.monotonic(), wall=time.time(), **values)) + '\n')

if command == 'date':
    print(int(time.time() * (1000 if args == ['+%s%3N'] else 1)))
elif command == 'sudo':
    if args[0] == '--non-interactive':
        args.pop(0)
    record('privilege', deadline=args[4])
    time.sleep(float(os.environ.get('PRIVILEGE_DELAY', '.12')))
    (root / 'crossed').touch()
    if os.environ.get('APT_DEADLINE_REAL_SUDO') == '1':
        # Used only inside the disposable nonroot Linux fixture. Explicitly
        # carry fixture inputs through actual sudo's environment reset.
        keys = ('PATH', 'PYTHONPATH', 'FIXTURE_DIR', 'WALL_SHIFT', 'FALLBACK', 'STALL', 'PYTHONDONTWRITEBYTECODE')
        values = [key + '=' + os.environ[key] for key in keys if key in os.environ]
        os.execv('/usr/bin/sudo', ['sudo', '-n', 'env', *values, *args])
    os.execvp(args[0], args)
elif command == 'timeout':
    record('watchdog', args=args)
    os.execv('/usr/bin/timeout', ['timeout', *args])
elif command == 'node':
    print('{"packages":["fixture-package"]}' if args[0] != '-p' else '1.0.0')
elif command == 'apt-get':
    if '--simulate' in args:
        print('Inst fixture-package (1 fixture [all])')
    else:
        record('acquisition', args=args)
        time.sleep(.12)
        (root / 'clock').write_text(str(-float(os.environ.get('WALL_SHIFT', '0')) if args[-1] == 'update' else float(os.environ.get('WALL_SHIFT', '0'))))
        if os.environ.get('STALL') == '1':
            record('stalled', pid=os.getpid())
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(60)
        if '--download-only' in args and not any('Dir::Etc::sourceparts=' in a for a in args) and os.environ.get('FALLBACK') == '1':
            print('E: Failed to fetch http://us-east-2.ec2.archive.ubuntu.com/ubuntu/pool/main/x/x_1_amd64.deb Connection timed out', flush=True)
            print('  Connection failed', flush=True)
            sys.exit(100)
        if '--no-download' in args:
            (root / 'installed').touch()
else:
    raise AssertionError(command)
