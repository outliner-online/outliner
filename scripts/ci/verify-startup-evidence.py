#!/usr/bin/env python3
"""Verify current-shard structured evidence; availability is not startup success."""
import argparse
from datetime import datetime
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile

TERMINAL = {'passed', 'failed', 'timed_out', 'interrupted', 'cleanup_failed',
            'supervisor_failed', 'not_started', 'orphaned_children'}
FIELDS = {'status', 'command_started', 'child_exit_code', 'console_dropped_bytes',
          'shard', 'execution_id', 'nonce', 'phase', 'attempt', 'elapsed_seconds',
          'updated_at', 'exit_code', 'reason', 'pid', 'budget_seconds',
          'startup_completed', 'retained_service_processes', 'remaining_processes',
          'process_snapshot', 'cleanup_error', 'error'}


def valid_record(value):
    if not isinstance(value, dict) or set(value) - FIELDS:
        return False
    if (value.get('status') not in TERMINAL or type(value.get('exit_code')) is not int
            or type(value.get('command_started')) is not bool
            or value.get('phase') not in {'pre_readiness', 'readiness', 'post_readiness', 'completion'}
            or type(value.get('attempt')) is not int or value['attempt'] not in (0, 1, 2)):
        return False
    for field in ('elapsed_seconds', 'budget_seconds'):
        if field not in value and field == 'budget_seconds':
            continue
        number = value.get(field)
        if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
            return False
    for field in ('pid', 'console_dropped_bytes', 'child_exit_code'):
        if value.get(field) is not None and type(value[field]) is not int:
            return False
    for field in ('shard', 'execution_id', 'nonce'):
        if not isinstance(value.get(field), str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,160}', value[field]):
            return False
    for field in ('process_snapshot', 'remaining_processes', 'retained_service_processes'):
        if field in value:
            if not isinstance(value[field], list):
                return False
            for row in value[field]:
                if (not isinstance(row, dict) or set(row) != {'pid', 'ppid', 'state'}
                        or type(row['pid']) is not int or type(row['ppid']) is not int
                        or row['state'] not in set('RSDZTWtXxKWPIN')):
                    return False
    if 'reason' in value and value['reason'] not in TERMINAL | {'job_budget_exhausted'}:
        return False
    if 'error' in value and value['error'] != 'startup_supervision_error':
        return False
    if 'cleanup_error' in value and value['cleanup_error'] != 'owned_process_signal_failed':
        return False
    if 'startup_completed' in value and value['startup_completed'] is not True:
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-success', action='store_true')
    parser.add_argument('--stage-upload', action='store_true',
                        help='Snapshot verified structured startup diagnostics outside raw log paths')
    args = parser.parse_args()
    root = Path('job_logs')
    root.mkdir(exist_ok=True)
    shard = os.environ.get('E2E_PROJECT', '')
    execution = os.environ.get('E2E_EXECUTION_ID', '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,160}', shard):
        return 1
    prefix = shard + '-startup'
    errors = []
    status = {}
    try:
        context = json.loads((root / 'execution-context.json').read_text())
        start = datetime.fromisoformat(context['startedAt'].replace('Z', '+00:00')).timestamp()
        for name in (prefix + '-status.json', 'setup-services-' + shard + '.log'):
            path = root / name
            value = json.loads(path.read_text())
            if (not valid_record(value) or path.stat().st_mtime < start
                    or value['shard'] != shard or value['execution_id'] != execution
                    or datetime.fromisoformat(value['updated_at']).timestamp() < start):
                raise ValueError('Invalid or stale evidence')
            if status and value != status:
                raise ValueError('Inconsistent diagnostics')
            status = value
        if context['executionId'] != execution or context['project'] != shard:
            raise ValueError('Wrong execution context')
        if status['status'] == 'passed':
            marker = root / (prefix + '-completed.json')
            expected = {key: status[key] for key in ('shard', 'execution_id', 'nonce')}
            expected['status'] = 'completed'
            if (status['exit_code'] != 0 or status['command_started'] is not True
                    or status.get('startup_completed') is not True or status['phase'] != 'completion'
                    or marker.stat().st_mtime < start or json.loads(marker.read_text()) != expected
                    or 'cleanup_error' in status):
                raise ValueError('Completion not proven')
        elif status['exit_code'] == 0 or args.require_success:
            raise ValueError('Startup not successful')
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        # Never echo values from corrupt/untrusted evidence into retained output.
        errors.append('Startup evidence is missing, invalid, stale or unsuccessful')
    result = {'status': 'missing_or_invalid' if errors else 'available', 'errors': errors}
    (root / (prefix + '-evidence.json')).write_text(json.dumps(result, indent=2) + '\n')
    if args.stage_upload:
        # Service processes can write raw files directly, independently of the
        # supervisor's stdout capture. Before E2E entry, upload only this fresh
        # snapshot, never the source log directories. Invalid evidence yields
        # only the fixed diagnostic error above and still exits nonzero.
        upload = Path(tempfile.mkdtemp(prefix='startup-artifacts-'))
        (upload / (prefix + '-evidence.json')).write_text(json.dumps(result, indent=2) + '\n')
        if not errors:
            for name in (prefix + '-status.json', 'setup-services-' + shard + '.log'):
                (upload / name).write_text(json.dumps(status, indent=2) + '\n')
            if status['status'] == 'passed':
                (upload / (prefix + '-completed.json')).write_text(json.dumps(expected) + '\n')
        # Publish a path only after all selected files have been safely written.
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write('upload_path=' + str(upload) + '\n')
    print(json.dumps(result))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
