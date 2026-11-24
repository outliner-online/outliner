"""Disposable native-metadata HTTP scans with slow optional/required reads."""

import copy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

from scripts import ci_duration_monitor as monitor
from scripts.ci_duration_github import GitHubClient
from scripts.ci_duration_github import ReadBudgetExceeded, ScanClient
from scripts.ci_cancellation_diagnostics import CancellationDiagnostics
from test_ci_duration_monitor import NOW, REPOSITORY, Result, job
from test_ci_duration_monitor_cancellation import CancellationGitHub, cancelled, annotation, TIMEOUT


class ScanBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)
        self.github = CancellationGitHub()
        self.github.jobs[(10, 1)] = [job(1, 700)] + [cancelled(i) for i in range(2, 22)]
        self.slow_route = 'check-runs/'
        self.delay = 0.15
        self.trickle = False
        self.received = []
        self.after_request = lambda method, route: None
        self.request_clock_started = lambda: None
        self.request_clock_finished = lambda _started: None
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                route = self.path.removeprefix('/repos/' + REPOSITORY).lstrip('/')
                clock_started = fixture.request_clock_started()
                fixture.received.append((self.command, urlsplit(route).path))
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                result = fixture.github.request(self.command, route, json.loads(body) if body else None)
                fixture.after_request(self.command, urlsplit(route).path)
                encoded = json.dumps(result.data).encode()
                slow = route.startswith(fixture.slow_route)
                try:
                    if slow and not fixture.trickle:
                        time.sleep(fixture.delay)
                    fixture.request_clock_finished(clock_started)
                    self.send_response(result.status)
                    self.send_header('Content-Length', str(len(encoded)))
                    self.end_headers()
                    if slow and fixture.trickle:
                        for byte in encoded:
                            self.wfile.write(bytes([byte]))
                            self.wfile.flush()
                            time.sleep(0.01)  # Each read succeeds, but total exceeds budget.
                    else:
                        self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.client = GitHubClient('', REPOSITORY, f'http://127.0.0.1:{self.server.server_port}')
        self.workflow = monitor.Workflow('.github/workflows/ci.yml', (
            monitor.Family('tests', 'Tests', r'Tests \(\d+/\d+\)', '^Run tests$',
                           ('.github/workflows/ci.yml', 'scripts/test.sh'), 'Keep selection.', 'test-step'),))

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_scan(self, *, required=3, optional=0.05, workers=8):
        return monitor.run_monitor(self.client, (self.workflow,), REPOSITORY, 'ignored',
                                   now=NOW, lookback_hours=48, publish=True,
                                   diagnostics_output=self.output,
                                   required_read_seconds=required, optional_read_seconds=optional,
                                   required_read_workers=workers)

    def test_representative_required_history_overlaps_reads_and_recovers_within_budget(self):
        # Native diagnostics at reproduced main SHA 35c53f7 recorded 447
        # required attempts: 430 HTTP 200s, 16 HTTP 502s, and the final
        # attempt-jobs transport failure. Preserve its dominant 430-history
        # scale and run both exact revisions through the scheduled CLI.
        template = copy.deepcopy(self.github.runs[0])
        self.github.runs = []
        self.github.jobs = {}
        live_now = datetime.now(timezone.utc)
        for run_id in range(10, 440):
            run = copy.deepcopy(template)
            run['id'] = run_id
            self.github.runs.append(run)
            fixture_job = job(run_id, 700)
            fixture_job.update(
                created_at=(live_now - timedelta(seconds=710)).isoformat(),
                started_at=(live_now - timedelta(seconds=700)).isoformat(),
                completed_at=live_now.isoformat())
            fixture_job['steps'][0].update(
                started_at=(live_now - timedelta(seconds=700)).isoformat(),
                completed_at=live_now.isoformat())
            self.github.jobs[(run_id, 1)] = [fixture_job]
        self.slow_route, self.delay = 'actions/runs/', 0.01
        original = self.github.request
        fault = {'remaining': 1}
        fault_route = 'actions/runs/357/attempts/1/jobs'
        fixture = self.output / 'cli-fixture'
        fixture.mkdir()
        clock_path = fixture / 'clock'
        clock = {'milliseconds': 0}
        clock_lock = threading.Lock()

        def write_clock():
            temporary_clock = clock_path.with_suffix('.tmp')
            temporary_clock.write_text(str(clock['milliseconds']), encoding='ascii')
            temporary_clock.replace(clock_path)

        def clock_started():
            with clock_lock:
                return clock['milliseconds']

        def clock_finished(started):
            with clock_lock:
                # Every request has the same 1.998-second synthetic latency.
                # Overlapping requests that start in one wave therefore share
                # its elapsed time instead of receiving a per-revision discount.
                clock['milliseconds'] = max(clock['milliseconds'], started + 1998)
                write_clock()

        self.request_clock_started = clock_started
        self.request_clock_finished = clock_finished

        def recoverable(method, path, payload=None):
            route = urlsplit(path).path
            if route == fault_route and fault['remaining']:
                fault['remaining'] -= 1
                return Result(502, None)
            return original(method, path, payload)

        self.github.request = recoverable
        clock_path.write_text('0', encoding='ascii')
        # Drive monotonic budget accounting from the identical loopback request
        # latency. Both exact revisions retain the production 720-second budget.
        (fixture / 'sitecustomize.py').write_text(
            f'import time\nfrom pathlib import Path\n_clock = Path({str(clock_path)!r})\n'
            'time.monotonic = lambda: int(_clock.read_text()) / 1000\n'
            'time.sleep = lambda _seconds: None\n', encoding='utf-8')
        # The Actions checkout is intentionally shallow, so keep the four
        # production modules from the reproduced SHA as a hermetic fixture
        # instead of requiring that historical Git object at test time.
        baseline = Path(__file__).parent / 'fixtures/ci-duration/reproduced-main-35c53f7'

        env = {**os.environ, 'GITHUB_API_URL': f'http://127.0.0.1:{self.server.server_port}',
               'GITHUB_REPOSITORY': REPOSITORY,
               'PYTHONPATH': str(fixture)}
        common = ['--repository', REPOSITORY, '--config', str(self.output / 'config.json'),
                  '--source-ref', 'b' * 40]
        (self.output / 'config.json').write_text(json.dumps({'workflows': [{
            'path': self.workflow.path, 'families': [{
                'key': 'tests', 'name': 'Tests', 'job_pattern': r'Tests \(\d+/\d+\)',
                'test_step_pattern': '^Run tests$', 'source_paths': list(self.workflow.families[0].source_paths),
                'guidance': 'Keep selection.', 'measurement': 'test-step'}]}]}), encoding='utf-8')

        baseline_output = self.output / 'baseline-output'
        baseline_harness_started = time.monotonic()
        baseline_run = subprocess.run(
            [sys.executable, str(baseline / 'ci_duration_monitor.py'), *common,
             '--output-dir', str(baseline_output)], env=env, capture_output=True, text=True, timeout=15)
        baseline_harness_seconds = time.monotonic() - baseline_harness_started
        baseline_job_reads = sum(path.endswith('/jobs') for _, path in self.received)
        self.assertEqual(baseline_run.returncode, 1, baseline_run.stdout + baseline_run.stderr)
        baseline_progress = json.loads((baseline_output / 'scan-progress.json').read_text())
        self.assertEqual(baseline_progress['error_type'], 'ReadBudgetExceeded')
        self.assertEqual(baseline_progress['last_request']['path'], fault_route)
        self.assertIn('cannot accommodate another retry', baseline_run.stdout)
        self.assertFalse((baseline_output / 'report.json').exists())
        self.assertEqual(baseline_job_reads, 348)

        self.received.clear()
        fault['remaining'] = 1
        clock['milliseconds'] = 0
        clock_path.write_text('0', encoding='ascii')
        candidate_output = self.output / 'candidate-output'
        candidate_harness_started = time.monotonic()
        candidate_run = subprocess.run(
            [sys.executable, str(Path(monitor.__file__)), *common,
             '--output-dir', str(candidate_output)], env=env, capture_output=True, text=True, timeout=15)
        candidate_harness_seconds = time.monotonic() - candidate_harness_started
        self.assertEqual(candidate_run.returncode, 0, candidate_run.stdout + candidate_run.stderr)
        report = json.loads((candidate_output / 'report.json').read_text())
        candidate_progress = json.loads((candidate_output / 'scan-progress.json').read_text())
        expected_jobs = list(range(10, 440))
        self.assertEqual(report['admission'], [{
            'workflow': '.github/workflows/ci.yml', 'family': 'tests',
            'qualifying_job_ids': expected_jobs, 'existing_open_issues': [],
            'classification': 'qualifies-new', 'diagnostic_samples': 0}])
        self.assertEqual([(row['run_id'], row['job_id']) for row in report['observations'][0]['samples']],
                         [(identifier, identifier) for identifier in expected_jobs])
        self.assertEqual(report['actions'], [{
            'workflow': '.github/workflows/ci.yml', 'family': 'tests', 'run_id': 439,
            'attempt': 1, 'issue': None, 'action': 'create'}])
        summary = (candidate_output / 'summary.md').read_text()
        self.assertIn('Admission before existing issue handling: 430 qualifying jobs; 0 qualifying families with existing issues; 1 new qualifying families; 0 families with insufficient evidence.', summary)
        self.assertEqual(sum(path.endswith('/jobs') for _, path in self.received), 431)
        candidate_progress = json.loads((candidate_output / 'scan-progress.json').read_text())
        self.assertLess(candidate_progress['elapsed_seconds'], baseline_progress['elapsed_seconds'])
        print('Synthetic budget: baseline '
              f"{baseline_progress['elapsed_seconds']}s/{baseline_job_reads} job reads; candidate "
              f"{candidate_progress['elapsed_seconds']}s/431 job reads. Harness wall time: "
              f'{baseline_harness_seconds:.3f}s baseline, {candidate_harness_seconds:.3f}s candidate.')

    def test_slow_annotations_are_after_required_inventory_and_bounded(self):
        source = monitor.CurrentSource(self.client, monitor._call, REPOSITORY, request=monitor._request)
        diagnostics = CancellationDiagnostics(REPOSITORY, NOW, NOW - timedelta(hours=48),
                                             lambda path: monitor._pages(self.client, path))
        baseline_start = time.monotonic()
        monitor.collect(self.client, (self.workflow,), NOW - timedelta(hours=48), source, diagnostics)
        baseline = time.monotonic() - baseline_start
        self.assertEqual(sum(path.startswith('check-runs/') for _, path in self.received), 20)
        self.assertGreater(baseline, 2.7)
        self.assertEqual(self.github.mutations, [])
        self.received.clear()
        started = time.monotonic()
        report = self.run_scan()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2)
        routes = [path for _, path in self.received]
        self.assertLess(routes.index('issues'), routes.index('check-runs/2/annotations'))
        self.assertEqual(sum(path.startswith('check-runs/') for path in routes), 1)
        self.assertEqual(report['admission_summary']['qualifying_candidates'], 1)
        self.assertEqual(len(self.github.issues), 1)
        rows = report['cancellation_diagnostics']['observations']
        self.assertEqual(len(rows), 20)
        self.assertEqual(rows[-1]['annotations']['reason'], 'optional_budget_exhausted')
        self.assertTrue(all(row['termination']['category'] == 'unknown' for row in rows))
        progress = json.loads((self.output / 'scan-progress.json').read_text())
        self.assertEqual(progress['state'], 'complete')
        self.assertEqual(progress['requests_by_stage']['optional-annotations']['attempts'], 1)
        print(f'Loopback: eager collection {baseline:.3f}s (20 annotations); bounded scan {elapsed:.3f}s, one annotation request, one eligible issue.')

    def test_required_trickle_aborts_with_prior_snapshot_and_zero_mutations(self):
        second = copy.deepcopy(self.github.runs[0])
        second['id'] = 11
        self.github.runs.append(second)
        self.github.jobs[(11, 1)] = [job(22, 700)]
        self.slow_route, self.trickle = 'actions/runs/11/attempts/1/jobs', True
        started = time.monotonic()
        with self.assertRaises(ReadBudgetExceeded):
            self.run_scan(required=0.4)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2)
        self.assertEqual(self.github.mutations, [])
        self.assertNotIn(('GET', 'issues'), self.received)
        self.assertEqual(self.received.count(('GET', self.slow_route)), 1)
        diagnostics = json.loads((self.output / 'cancellation-diagnostics.json').read_text())
        self.assertFalse(diagnostics['collection_complete'])
        self.assertEqual(len(diagnostics['observations']), 20)
        progress = json.loads((self.output / 'scan-progress.json').read_text())
        self.assertEqual((progress['stage'], progress['state'], progress['error_type']),
                         ('required-collection', 'failed', 'ReadBudgetExceeded'))
        self.assertEqual(progress['last_request']['path'], self.slow_route)
        self.assertFalse((self.output / 'report.json').exists())
        print(f'Loopback: successful-byte trickle aborted in {elapsed:.3f}s; incomplete snapshot retained, zero mutations.')

    def test_progress_omits_query_and_exception_message(self):
        class FailedClient:
            def request(self, *_):
                raise RuntimeError('https://storage.invalid/log?signature=do-not-retain')

        scan = ScanClient(FailedClient(), self.output, 3, 1)
        with self.assertRaises(RuntimeError):
            scan.request('GET', 'actions/runs?signature=do-not-retain')
        text = (self.output / 'scan-progress.json').read_text()
        self.assertNotIn('signature', text)
        self.assertNotIn('storage.invalid', text)
        self.assertIn('RuntimeError', text)

    def test_expired_at_publication_boundary_sends_zero_posts(self):
        self.github.jobs[(10, 1)] = [job(1, 700)]
        clock = [0.0]
        original_save = ScanClient.save

        def save(scan):
            original_save(scan)
            if scan.last_request and scan.last_request['method'] == 'POST':
                clock[0] = 10.0

        with patch('scripts.ci_duration_github.time', SimpleNamespace(monotonic=lambda: clock[0])), \
                patch.object(ScanClient, 'save', save):
            with self.assertRaisesRegex(ReadBudgetExceeded, 'mutation admission cutoff'):
                self.run_scan(required=10, optional=0)
        self.assertEqual(self.github.mutations, [])
        self.assertFalse(any(method == 'POST' for method, _ in self.received))
        self.assertFalse((self.output / 'report.json').exists())

    def test_expiry_after_one_confirmed_mutation_sends_no_further_post(self):
        self.github.jobs[(10, 1)] = [job(1, 700)]
        clock = [0.0]

        def expire(method, route):
            if method == 'POST' and route == 'issues':
                clock[0] = 10.0

        self.after_request = expire
        with patch('scripts.ci_duration_github.time', SimpleNamespace(monotonic=lambda: clock[0])):
            with self.assertRaisesRegex(ReadBudgetExceeded, 'mutation admission cutoff'):
                self.run_scan(required=10, optional=0)
        self.assertEqual([path for method, path in self.received if method == 'POST'], ['issues'])
        self.assertEqual([path for _, path, _ in self.github.mutations], ['issues'])
        self.assertEqual(len(self.github.issues), 1)
        self.assertEqual(self.github.comments, {})
        self.assertFalse((self.output / 'report.json').exists())

    def test_optional_timeout_cannot_admit_mutations_after_overall_cutoff(self):
        clock = [0.0]

        def expire(method, route):
            if route.startswith('check-runs/'):
                clock[0] = 10.0

        self.after_request = expire
        fake_time = SimpleNamespace(monotonic=lambda: clock[0], sleep=time.sleep)
        with patch('scripts.ci_duration_github.time', fake_time), patch.object(monitor, 'time', fake_time):
            with self.assertRaises(ReadBudgetExceeded):
                self.run_scan(required=10, optional=5)
        self.assertEqual(self.github.mutations, [])
        self.assertFalse(any(method == 'POST' for method, _ in self.received))
        diagnostic = json.loads((self.output / 'cancellation-diagnostics.json').read_text())
        self.assertTrue(diagnostic['collection_complete'])  # Required metadata finished.
        self.assertEqual(diagnostic['observations'][0]['annotations']['state'], 'unavailable')
        self.assertEqual(diagnostic['observations'][-1]['annotations']['reason'], 'optional_budget_exhausted')

    def test_optional_disk_and_render_failures_do_not_abort_valid_report(self):
        with patch('scripts.ci_duration_github.write_json', side_effect=OSError('disk failed')), \
                patch.object(CancellationDiagnostics, 'markdown', side_effect=ValueError('render failed')):
            report = self.run_scan(optional=0)
        self.assertEqual(report['admission_summary']['qualifying_candidates'], 1)
        self.assertTrue(report['cancellation_diagnostics']['collection_complete'])
        self.assertEqual(len(self.github.issues), 1)

    def test_diagnostic_disk_and_render_failures_preserve_primary_http_failure(self):
        original_request = self.github.request

        def unavailable(method, path, payload=None):
            if urlsplit(path).path == 'actions/runs/10/attempts/1/jobs':
                return Result(403, {})
            return original_request(method, path, payload)

        self.github.request = unavailable
        for target, error in [('pathlib.Path.write_text', OSError('disk unavailable')),
                              ('scripts.ci_cancellation_diagnostics.CancellationDiagnostics.markdown', ValueError('render failed'))]:
            with self.subTest(target=target), patch(target, side_effect=error):
                with self.assertRaisesRegex(RuntimeError, 'returned 403; expected 200'):
                    self.run_scan()
            self.assertEqual(self.github.mutations, [])

    def test_optional_collector_and_report_failures_leave_admission_intact(self):
        for target in ['_observe', '_report', 'enrich']:
            with self.subTest(target=target):
                with patch.object(CancellationDiagnostics, target, side_effect=ValueError('optional failure')):
                    report = self.run_scan(optional=0)
                self.assertEqual(report['admission_summary']['qualifying_candidates'], 1)
                self.assertFalse(report['cancellation_diagnostics']['collection_complete'])
        self.assertEqual(len(self.github.issues), 1)  # Existing duplicate handling retained.

    def test_many_attempts_write_full_snapshots_only_at_phase_boundaries(self):
        self.delay = 0
        self.github.runs[0]['run_attempt'] = 40
        for attempt in range(1, 41):
            self.github.jobs[(10, attempt)] = [cancelled(attempt, attempt=attempt)]
        original_write = CancellationDiagnostics.write
        sizes = []

        def write(diagnostics, directory):
            sizes.append(len(diagnostics.rows) + len(diagnostics.carried_rows))
            return original_write(diagnostics, directory)

        with patch.object(CancellationDiagnostics, 'write', write):
            report = self.run_scan(required=10, optional=0)
        self.assertEqual(sum('/jobs' in route for _, route in self.received), 40)
        self.assertEqual(sizes, [0, 40, 40])
        self.assertEqual(len(report['cancellation_diagnostics']['observations']) +
                         len(report['cancellation_diagnostics']['carried_forward_observations']), 40)
        self.assertEqual(self.github.mutations, [])

    def test_fast_optional_annotations_still_establish_native_cause(self):
        self.delay = 0
        self.github.annotations[2] = [annotation(TIMEOUT)]
        report = self.run_scan(optional=2)
        rows = report['cancellation_diagnostics']['observations']
        self.assertEqual(rows[0]['termination']['category'], 'job_timeout')
        self.assertEqual(rows[0]['termination']['confidence'], 'confirmed')
        self.assertEqual(rows[1]['termination']['category'], 'unknown')


if __name__ == '__main__':
    unittest.main()
