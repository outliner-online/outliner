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
    parser.add_argument('--cancel-grace-seconds', type=float, default=2)
    parser.add_argument('--heartbeat-seconds', type=float, default=30)
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
    interrupted = [None, None, False]
    pending_signals = []
    diagnostic_logger = None
    diagnostic_sinks = []
    cleanup_deadline = None
    last_output_at = supervisor_started
    output_bytes = 0
    phase = 'initializing'
    deadline = None
    exit_code = 125

    def handle_signal(signum, _frame):
        received = time.monotonic()
        if interrupted[0] is None:
            interrupted[0:2] = [signum, received]
        else:
            interrupted[2] = True
        pending_signals.append((signum, received))
        if not structured:
            record.update(received_signal=interrupted[0], last_received_signal=signum)

    # Install the handlers before launching the child. A command can signal
    # its supervisor immediately after fork, before the parent reaches the
    # supervision loop.
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, handle_signal)

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

    def diagnostic_event(event, rows=None, **details):
        if diagnostic_logger is None:
            return
        now = time.monotonic()
        snapshot = []
        states = {}
        cpu_seconds = 0
        rss_bytes = 0
        for row in rows or []:
            try:
                raw = Path(f"/proc/{row['pid']}/stat").read_text()
                fields = raw[raw.rindex(')') + 2:].split()
                cpu = (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
                rss = max(0, int(fields[21])) * os.sysconf('SC_PAGE_SIZE')
                states[fields[0]] = states.get(fields[0], 0) + 1
                cpu_seconds += cpu
                rss_bytes += rss
                if len(snapshot) < 64:
                    snapshot.append(dict(pid=row['pid'], ppid=int(fields[1]), state=fields[0],
                                         cpu_seconds=round(cpu, 3), rss_bytes=rss))
            except (OSError, ValueError, IndexError):
                continue
        record.update(heartbeat_at=datetime.now(timezone.utc).isoformat(),
                      elapsed_seconds=round(now - supervisor_started, 3), phase=phase,
                      output_bytes=output_bytes,
                      output_idle_seconds=round(max(0, now - last_output_at), 3),
                      command_remaining_seconds=round(max(0, deadline - now), 3) if deadline is not None else None)
        evidence = {key: record[key] for key in (
            'run_id', 'run_attempt', 'project', 'checkout_sha', 'status', 'phase',
            'elapsed_seconds', 'output_bytes', 'output_idle_seconds', 'command_remaining_seconds',
            'received_signal', 'last_received_signal', 'exit_code', 'child_exit_code',
        ) if key in record}
        evidence.update(event=event, at=record['heartbeat_at'], processes=snapshot,
                        process_count=sum(states.values()), process_states=states,
                        live_cpu_seconds=round(cpu_seconds, 3), summed_rss_bytes=rss_bytes,
                        **details)
        diagnostic_logger.info('{}', json.dumps(evidence, separators=(',', ':')))

    def emit_signals(rows):
        while pending_signals:
            signum, received = pending_signals.pop(0)
            diagnostic_event('signal_received', rows, signal=signum,
                             signal_elapsed_seconds=round(received - supervisor_started, 3))

    save()
    child = None
    startup_succeeded = False
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    try:
        budgets = (args.timeout_seconds, args.job_budget_seconds, args.grace_seconds,
                   args.cancel_grace_seconds, args.heartbeat_seconds)
        if (not command or not all(math.isfinite(value) and value > 0 for value in budgets)
                or args.cancel_grace_seconds > 2):
            raise ValueError('A command and positive time budgets are required')
        context = json.loads(Path(args.context).read_text())
        started = datetime.fromisoformat(context['startedAt'].replace('Z', '+00:00'))
        if not structured:
            save(run_id=context.get('runId'), run_attempt=context.get('runAttempt'),
                 project=context.get('ciShard'), checkout_sha=context.get('commit'))
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
        if args.report:
            # Startup and the APT supervisor import stay dependency-free. The
            # test supervisor emits only numeric/process-state diagnostics.
            from loguru import logger
            logger.remove()
            diagnostic_logger = logger
            diagnostic_sinks.append(logger.add(status_path.with_suffix('.supervisor.jsonl'),
                                                format='{message}', encoding='utf-8',
                                                backtrace=False, diagnose=False, catch=False))

            def diagnostic_console(message):
                data = ('[bounded-e2e] ' + str(message)).encode()
                try:
                    written = os.write(console, data)
                except (BlockingIOError, BrokenPipeError):
                    written = 0
                record['diagnostic_console_dropped_bytes'] = (
                    record.get('diagnostic_console_dropped_bytes', 0) + len(data) - written)

            diagnostic_sinks.append(logger.add(diagnostic_console, format='{message}',
                                                backtrace=False, diagnose=False, catch=False))
        with (tempfile.TemporaryFile() if structured else log_path.open('ab')) as output, \
                (nullcontext(output) if structured else log_path.open('rb')) as reader:
            reader.seek(0, os.SEEK_END)
            log_start = reader.tell()
            started_ns = time.time_ns()
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + budget
            phase = 'running'
            save(status='running', command_started=True, pid=child.pid, budget_seconds=budget)
            diagnostic_event('started', descendants(), budget_seconds=round(budget, 3))
            stopping = None
            kill_at = None
            last_cleanup_signal = None
            next_heartbeat = time.monotonic() + args.heartbeat_seconds

            def pump():
                nonlocal console_written, output_bytes, last_output_at
                if structured:
                    return
                # A bounded read prevents an excessively noisy child from
                # keeping the supervisor away from its deadline checks.
                size = os.fstat(output.fileno()).st_size - log_start
                if size != output_bytes:
                    output_bytes = size
                    last_output_at = time.monotonic()
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
                emit_signals(rows)
                if now >= next_heartbeat:
                    diagnostic_event('heartbeat', rows)
                    save()
                    next_heartbeat = now + args.heartbeat_seconds
                if stopping is None:
                    if interrupted[0]:
                        stopping = 'interrupted'
                    elif now >= deadline:
                        stopping = 'timed_out'
                    elif code == 0 and args.startup_completion:
                        startup_completion(args.startup_completion, started_ns, identity)
                        now = time.monotonic()
                        if interrupted[0] or now >= deadline:
                            # Validation can block. A cancellation or deadline
                            # accepted before handoff still owns these services.
                            stopping = 'interrupted' if interrupted[0] else 'timed_out'
                        else:
                            # Startup intentionally leaves PM2 and its services alive for E2E.
                            # Only a fresh successful marker permits this handoff.
                            save(status='passed', child_exit_code=0, exit_code=0, startup_completed=True,
                                 retained_service_processes=rows, remaining_processes=rows)
                            pump()
                            startup_succeeded = True
                            exit_code = 0
                            break
                    elif code is not None and rows:
                        stopping = 'orphaned_children'
                    elif code is not None:
                        exit_code = code if code >= 0 else 128 - code
                        save(child_exit_code=code)
                        if exit_code == 0:
                            phase = 'validating_report'
                            diagnostic_event('validating_report')
                            save()
                            save(test_counts=execution_counts(args.report, started_ns))
                        # Report validation is synchronous. A signal received
                        # while it runs must never be converted into success.
                        if interrupted[0] or time.monotonic() >= deadline:
                            stopping = 'interrupted' if interrupted[0] else 'timed_out'
                            exit_code = 128 + interrupted[0] if interrupted[0] else 124
                        else:
                            stopping = 'passed' if exit_code == 0 else 'failed'
                        record.update(status=stopping,
                                      child_exit_code=code, exit_code=exit_code, remaining_processes=[])
                        pump()
                        break
                    if stopping:
                        kill_at = now + args.grace_seconds
                        cleanup_deadline = kill_at + 2
                        phase = 'cleanup'
                        save(status=stopping, process_snapshot=rows)
                if stopping:
                    if interrupted[0]:
                        # The runner grants 7.5s after SIGINT. Share one absolute
                        # deadline with finally, including an earlier timeout.
                        cancel_kill_at = interrupted[1] + min(args.grace_seconds, args.cancel_grace_seconds)
                        if interrupted[2]:
                            cancel_kill_at = min(cancel_kill_at, now)
                        kill_at = min(kill_at, cancel_kill_at)
                        cleanup_deadline = min(cleanup_deadline, cancel_kill_at + 2)
                        if stopping != 'interrupted':
                            save(reason=stopping, status='interrupted')
                            stopping = 'interrupted'
                    sig = signal.SIGTERM if now < kill_at else signal.SIGKILL
                    if sig != last_cleanup_signal:
                        diagnostic_event('cleanup_signal', rows, signal=int(sig),
                                         cleanup_remaining_seconds=round(max(0, cleanup_deadline - now), 3))
                        last_cleanup_signal = sig
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
                        break
                    if now >= cleanup_deadline:
                        save(status='cleanup_failed', reason=stopping, child_exit_code=code,
                             exit_code=125, remaining_processes=descendants())
                        exit_code = 125
                        break
                time.sleep(0.05)
    except (OSError, ValueError, TypeError, KeyError, ImportError) as error:
        save(status='supervisor_failed', error=str(error), exit_code=125)
        exit_code = 125
    finally:
        startup_revoked = bool(startup_succeeded and interrupted[0])
        if startup_revoked:
            # A signal accepted while publishing the candidate handoff must
            # also revoke its cleanup exemption and success-only evidence.
            startup_succeeded = False
            record.pop('startup_completed', None)
            record.pop('retained_service_processes', None)
        if child is not None and not startup_succeeded:
            # Also bound exceptional exits (for example a broken CI console).
            # Only this supervisor's descendants are touched, never shared services.
            until = min(time.monotonic() + 2, cleanup_deadline or math.inf)
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
        if (structured or startup_revoked) and child is not None and not startup_succeeded:
            remaining = descendants()
            if remaining:
                save(status='cleanup_failed', exit_code=125, remaining_processes=remaining)
                exit_code = 125
            else:
                save(remaining_processes=[])
        # Descendants are now settled. A later cancellation during final file
        # or logger flushing must terminate natively instead of being swallowed
        # after Python has already computed a successful return value.
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, signal.SIG_DFL)
        if interrupted[0] and exit_code == 0:
            exit_code = 128 + interrupted[0]
            record.update(status='interrupted', exit_code=exit_code)
        try:
            phase = 'finished'
            emit_signals(descendants() if child is not None else [])
            diagnostic_event('finished', descendants() if child is not None else [])
            save()
        finally:
            if diagnostic_logger is not None:
                for sink in diagnostic_sinks:
                    diagnostic_logger.remove(sink)
            if console is not None and console_was_blocking is not None:
                os.set_blocking(console, console_was_blocking)
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
