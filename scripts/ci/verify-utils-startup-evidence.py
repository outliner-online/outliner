#!/usr/bin/env python3
"""Check utils diagnostic inputs; availability is not startup success."""
import json
from pathlib import Path
import sys


def main():
    root = Path('job_logs')
    root.mkdir(exist_ok=True)
    errors = []

    def read_record(name):
        try:
            value = json.loads((root / name).read_text())
            if not isinstance(value, dict):
                raise ValueError('Not an object')
            return value
        except (OSError, ValueError):
            errors.append(name + ' is missing or invalid')
            return {}

    status = read_record('utils-startup-status.json')
    started = status.get('command_started')
    exit_code = status.get('exit_code')
    if not isinstance(started, bool) or type(exit_code) is not int:
        errors.append('utils-startup-status.json lacks a recorded execution outcome')
    if status.get('status') not in ('passed', 'failed', 'timed_out', 'interrupted',
                                  'cleanup_failed', 'supervisor_failed', 'not_started',
                                  'orphaned_children'):
        errors.append('utils-startup-status.json lacks a terminal startup state')
    output = 'not_produced_command_not_started'
    if started is True:
        output = 'setup-services-utils.log'
        if not (root / output).is_file():
            errors.append(output + ' is missing')
    if status.get('status') == 'passed':
        if started is not True or exit_code != 0 or status.get('startup_completed') is not True:
            errors.append('utils-startup-status.json does not record successful completion')
        if read_record('utils-startup-completed.json') != {'status': 'completed'}:
            errors.append('utils-startup-completed.json does not record completion')
    elif exit_code == 0:
        errors.append('utils-startup-status.json has a zero exit without startup success')
    result = {'status': 'missing_or_invalid' if errors else 'available',
              'startup_status': status.get('status'), 'startup_exit_code': exit_code,
              'output': output, 'errors': errors}
    (root / 'utils-startup-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
    for error in errors:
        print('::error::Utils startup evidence: ' + error, file=sys.stderr)
    print(json.dumps(result))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
