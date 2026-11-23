"""Disposable native-metadata HTTP scans with slow optional/required reads."""

import copy
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
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
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                route = self.path.removeprefix('/repos/' + REPOSITORY).lstrip('/')
                fixture.received.append((self.command, urlsplit(route).path))
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                result = fixture.github.request(self.command, route, json.loads(body) if body else None)
                fixture.after_request(self.command, urlsplit(route).path)
                encoded = json.dumps(result.data).encode()
                slow = route.startswith(fixture.slow_route)
                try:
                    if slow and not fixture.trickle:
                        time.sleep(fixture.delay)
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

    def run_scan(self, *, required=3, optional=0.05):
        return monitor.run_monitor(self.client, (self.workflow,), REPOSITORY, 'ignored',
                                   now=NOW, lookback_hours=48, publish=True,
                                   diagnostics_output=self.output,
                                   required_read_seconds=required, optional_read_seconds=optional)

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
