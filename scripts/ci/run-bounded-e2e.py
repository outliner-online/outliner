#!/usr/bin/env python3
"""Linux-only E2E supervisor: reserve the job's final minutes for evidence upload."""
import argparse
import ctypes
from contextlib import nullcontext
from datetime import datetime, timezone
import json
import math
import os
import re
from pathlib import Path
import signal
import subprocess
import tempfile
import sys
import time


def descendants():
    rows = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / 'stat').read_text()
            end = raw.rindex(')')
            fields = raw[end + 2:].split()
            rows[int(entry.name)] = {'pid': int(entry.name), 'ppid': int(fields[1]),
                                     'state': fields[0], 'name': raw[raw.index('(') + 1:end]}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    selected = {os.getpid()}
    while True:
        more = {pid for pid, row in rows.items() if row['ppid'] in selected} - selected
        if not more:
            break
        selected.update(more)
    return [row for pid, row in rows.items() if pid in selected and pid != os.getpid()]


def execution_counts(path, started_ns):
    if Path(path).stat().st_mtime_ns < started_ns:
        raise ValueError('Playwright report predates the command')
    report = json.loads(Path(path).read_text())
    tests = []

    def collect(suite):
        for spec in suite.get('specs', []):
            tests.extend(spec['tests'])
        for nested in suite.get('suites', []):
            collect(nested)

    collect(report)
    stats = report['stats']
    if (not tests or report.get('errors') or stats['skipped'] or stats['unexpected']
            or stats['expected'] + stats['flaky'] != len(tests)
            or any(test['status'] not in ('expected', 'flaky') or not test['results']
                   or test['results'][-1]['status'] != 'passed' for test in tests)):
        raise ValueError('Playwright report does not prove all collected cases executed and passed')
    for test in tests:
        for attempt in test['results']:
            for attachment in attempt.get('attachments', []):
                if attachment.get('path') and not Path(attachment['path']).is_file():
                    raise ValueError('A referenced Playwright attachment is missing: ' + attachment['path'])
    return stats


def startup_completion(path, started_ns, identity=None):
    """The workflow writes this only after its unchanged startup command succeeds."""
    marker = Path(path)
    if marker.stat().st_mtime_ns < started_ns:
        raise ValueError('Startup completion marker predates the command')
    if json.loads(marker.read_text()) != (identity or {'status': 'completed'}):
        raise ValueError('Startup completion marker does not prove command completion')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True)
    parser.add_argument('--status', required=True)
    parser.add_argument('--log', required=True)
    completion = parser.add_mutually_exclusive_group(required=True)
    completion.add_argument('--report', help='Fresh complete Playwright JSON report')
    completion.add_argument('--startup-completion', help='Fresh marker written after successful service startup')
    parser.add_argument('--startup-shard')
    parser.add_argument('--startup-execution-id')
    parser.add_argument('--startup-nonce')
    parser.add_argument('--startup-progress')
    parser.add_argument('--timeout-seconds', type=float, default=1200)
    parser.add_argument('--job-budget-seconds', type=float, default=1320)
    parser.add_argument('--grace-seconds', type=float, default=10)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    structured = args.startup_shard is not None
    identity = None
    if structured:
        values = (args.startup_shard, args.startup_execution_id, args.startup_nonce)
        if (not args.startup_completion or not args.startup_progress
                or any(not value or not re.fullmatch(r'[a-zA-Z0-9_-]{1,160}', value) for value in values)):
            parser.error('Structured startup requires safe shard, execution, nonce and progress fields')
        identity = dict(status='completed', shard=args.startup_shard,
                        execution_id=args.startup_execution_id, nonce=args.startup_nonce)
    supervisor_started = time.monotonic()
    status_path = Path(args.status)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    record = {'status': 'not_started', 'command_started': False, 'child_exit_code': None,
              'console_dropped_bytes': 0}
    if structured:
        record.update(shard=args.startup_shard, execution_id=args.startup_execution_id,
                      nonce=args.startup_nonce, phase='pre_readiness', attempt=0)
    log_path = None
    log_start = 0
    console_written = 0
    console = None
    console_was_blocking = None

    def save(**patch):
        record.update(patch)
        if record.get('exit_code') is not None and log_path is not None and log_path.exists():
            record['console_dropped_bytes'] = max(0, log_path.stat().st_size - log_start - console_written)
        if structured:
            # Startup stdout, process names and exception text are untrusted.
            # Retain only fields whose types and value domains we control.
            record['elapsed_seconds'] = round(time.monotonic() - supervisor_started, 3)
            try:
                progress = json.loads(Path(args.startup_progress).read_text())
                if (progress.get('phase') in ('pre_readiness', 'readiness', 'post_readiness', 'completion')
                        and type(progress.get('attempt')) is int and progress['attempt'] in (1, 2)):
                    record.update(phase=progress['phase'], attempt=progress['attempt'])
            except (OSError, ValueError, AttributeError):
                pass
            for field in ('process_snapshot', 'remaining_processes', 'retained_service_processes'):
                if field in record:
                    record[field] = [{key: row[key] for key in ('pid', 'ppid', 'state')} for row in record[field]]
            if 'error' in record:
                record['error'] = 'startup_supervision_error'
            if 'cleanup_error' in record:
                record['cleanup_error'] = 'owned_process_signal_failed'
            allowed = {
                'status', 'command_started', 'child_exit_code', 'console_dropped_bytes',
                'shard', 'execution_id', 'nonce', 'phase', 'attempt', 'elapsed_seconds',
                'updated_at', 'exit_code', 'reason', 'pid', 'budget_seconds',
                'startup_completed', 'retained_service_processes', 'remaining_processes',
                'process_snapshot', 'cleanup_error', 'error',
            }
            for key in record.keys() - allowed:
                del record[key]
        record['updated_at'] = datetime.now(timezone.utc).isoformat()
        temporary = status_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(record, indent=2) + '\n')
        temporary.replace(status_path)
        if structured:
            # This is the only startup log eligible for artifact upload.
            Path(args.log).write_text(json.dumps(record, indent=2) + '\n')

    save()
    child = None
    startup_succeeded = False
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    try:
        budgets = (args.timeout_seconds, args.job_budget_seconds, args.grace_seconds)
        if not command or not all(math.isfinite(value) and value > 0 for value in budgets):
            raise ValueError('A command and positive time budgets are required')
        started = datetime.fromisoformat(json.loads(Path(args.context).read_text())['startedAt'].replace('Z', '+00:00'))
        if started.tzinfo is None or started.timestamp() > time.time() + 1:
            raise ValueError('Execution context must contain a valid past timezone-aware startedAt')
        budget = min(args.timeout_seconds, started.timestamp() + args.job_budget_seconds - time.time())
        if budget <= 0:
            save(reason='job_budget_exhausted', exit_code=124)
            return 124
        # Playwright browsers use separate process groups. Adopt orphaned
        # descendants as well, so killing only npm/the original group is insufficient.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER (Linux)
            raise OSError(ctypes.get_errno(), 'Cannot enable child subreaper')
        log_path = None if structured else Path(args.log)
        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)
        console = sys.stdout.fileno()
        console_was_blocking = os.get_blocking(console)
        os.set_blocking(console, False)
        with (tempfile.TemporaryFile() if structured else log_path.open('ab')) as output, \
                (nullcontext(output) if structured else log_path.open('rb')) as reader:
            reader.seek(0, os.SEEK_END)
            log_start = reader.tell()
            started_ns = time.time_ns()
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            save(status='running', command_started=True, pid=child.pid, budget_seconds=budget)
            deadline = time.monotonic() + budget
            stopping = None
            stop_at = None
            interrupted = [None]
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda signum, _frame: interrupted.__setitem__(0, signum))

            def pump():
                nonlocal console_written
                if structured:
                    return
                # A bounded read prevents an excessively noisy child from
                # keeping the supervisor away from its deadline checks.
                data = reader.read(262144)
                if data:
                    try:
                        written = os.write(console, data)
                    except (BlockingIOError, BrokenPipeError):
                        written = 0
                    # The complete command log stays on disk even if the CI
                    # console stops reading. Console backpressure cannot stop
                    # deadline checks or child cleanup.
                    record['console_dropped_bytes'] += len(data) - written
                    console_written += written

            while True:
                pump()
                code = child.poll()
                rows = descendants()
                for row in rows:
                    if row['ppid'] == os.getpid() and row['pid'] != child.pid:
                        try:
                            os.waitpid(row['pid'], os.WNOHANG)
                        except ChildProcessError:
                            pass
                rows = descendants()
                now = time.monotonic()
                if stopping is None:
                    if interrupted[0]:
                        stopping = 'interrupted'
                    elif now >= deadline:
                        stopping = 'timed_out'
                    elif code == 0 and args.startup_completion:
                        startup_completion(args.startup_completion, started_ns, identity)
                        # Startup intentionally leaves PM2 and its services alive for E2E.
                        # Only a fresh successful marker permits this handoff.
                        save(status='passed', child_exit_code=0, exit_code=0, startup_completed=True,
                             retained_service_processes=rows, remaining_processes=rows)
                        pump()
                        startup_succeeded = True
                        return 0
                    elif code is not None and rows:
                        stopping = 'orphaned_children'
                    elif code is not None:
                        exit_code = code if code >= 0 else 128 - code
                        save(child_exit_code=code)
                        if exit_code == 0:
                            save(test_counts=execution_counts(args.report, started_ns))
                        save(status='passed' if exit_code == 0 else 'failed',
                             child_exit_code=code, exit_code=exit_code, remaining_processes=[])
                        pump()
                        return exit_code
                    if stopping:
                        stop_at = now
                        save(status=stopping, process_snapshot=rows)
                if stopping:
                    sig = signal.SIGTERM if now - stop_at < args.grace_seconds else signal.SIGKILL
                    for row in rows:
                        if row['state'] != 'Z':
                            try:
                                os.kill(row['pid'], sig)
                            except ProcessLookupError:
                                pass
                            except PermissionError as error:
                                save(cleanup_error=str(error))
                    if code is not None and not rows:
                        exit_code = (128 + interrupted[0]) if interrupted[0] else (
                            124 if stopping == 'timed_out' else (code if code > 0 else 128 - code if code < 0 else 1))
                        save(status=stopping, child_exit_code=code, exit_code=exit_code, remaining_processes=[])
                        pump()
                        return exit_code
                    if now - stop_at >= args.grace_seconds + 2:
                        save(status='cleanup_failed', reason=stopping, child_exit_code=code,
                             exit_code=125, remaining_processes=descendants())
                        return 125
                time.sleep(0.05)
    except (OSError, ValueError, TypeError, KeyError) as error:
        save(status='supervisor_failed', error=str(error), exit_code=125)
        return 125
    finally:
        if child is not None and not startup_succeeded:
            # Also bound exceptional exits (for example a broken CI console).
            # Only this supervisor's descendants are touched, never shared services.
            until = time.monotonic() + 2
            while time.monotonic() < until:
                child.poll()
                rows = descendants()
                if not rows:
                    break
                for row in rows:
                    try:
                        os.kill(row['pid'], signal.SIGKILL)
                        if row['ppid'] == os.getpid() and row['pid'] != child.pid:
                            os.waitpid(row['pid'], os.WNOHANG)
                    except (ProcessLookupError, ChildProcessError, PermissionError):
                        pass
                time.sleep(0.05)
        if structured and child is not None and not startup_succeeded:
            remaining = descendants()
            if remaining:
                save(status='cleanup_failed', exit_code=125, remaining_processes=remaining)
            else:
                save(remaining_processes=[])
        try:
            save()
        finally:
            if console is not None and console_was_blocking is not None:
                os.set_blocking(console, console_was_blocking)


if __name__ == '__main__':
    sys.exit(main())
