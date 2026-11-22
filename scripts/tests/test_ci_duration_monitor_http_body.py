"""Real truncated HTTP bodies at the monitor's existing REST/CLI boundary."""

import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from scripts import ci_duration_monitor as monitor
from scripts.ci_duration_github import GitHubClient
from test_ci_duration_monitor import GitHub, NOW, REPOSITORY, job


class IncompleteBodyTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / 'monitor.json'
        self.config.write_text(json.dumps({'workflows': [{
            'path': '.github/workflows/ci.yml',
            'families': [{
                'key': 'tests', 'name': 'Tests', 'job_pattern': r'Tests \(\d+/\d+\)',
                'test_step_pattern': '^Run tests$', 'measurement': 'test-step',
                'source_paths': ['.github/workflows/ci.yml', 'scripts/test.sh'],
                'guidance': 'Preserve complete selection and native failure propagation.',
            }],
        }]}))
        self.github = GitHub()
        self.drop_method = 'GET'
        self.drop_route = 'actions/runs/10/attempts/1/jobs'
        self.drops_remaining = 1
        self.truncated = 0
        self.empty_body = False
        self.received = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                prefix = '/repos/' + REPOSITORY
                if self.path != prefix and not self.path.startswith(prefix + '/'):
                    self.send_error(404)
                    return
                path = self.path[len(prefix):].lstrip('/')
                route = urlsplit(path).path
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                fixture.received.append((self.command, route))
                # The isolated API commits POSTs before a response can be lost.
                result = fixture.github.request(self.command, path, json.loads(body) if body else None)
                encoded = json.dumps(result.data).encode()
                drop = self.command == fixture.drop_method and route == fixture.drop_route and fixture.drops_remaining != 0
                if drop:
                    if fixture.drops_remaining > 0:
                        fixture.drops_remaining -= 1
                    fixture.truncated += 1
                self.send_response(result.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.send_header('Connection', 'close')
                self.end_headers()
                # Closing a genuine short body raises http.client.IncompleteRead
                # inside GitHubClient.response.read(), before JSON decoding.
                short_body = b'' if fixture.empty_body else encoded[:max(1, len(encoded) // 2)]
                self.wfile.write(short_body if drop else encoded)
                self.wfile.flush()
                self.close_connection = True

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.client = GitHubClient('isolated-fixture-token', REPOSITORY, f'http://127.0.0.1:{self.server.server_port}')

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_cli(self):
        args = ['--repository', REPOSITORY, '--config', str(self.config),
                '--output-dir', str(self.root / 'output'), '--publish']
        with patch.dict('os.environ', {'GITHUB_TOKEN': 'isolated-fixture-token',
                                     'GITHUB_STEP_SUMMARY': str(self.root / 'summary.md')}), \
                patch.object(monitor.time, 'sleep') as sleep, patch.object(monitor, 'logger'):
            code = monitor.main(args, client_factory=lambda _token, _repo: self.client, now=NOW)
        return code, sleep.call_args_list

    def test_transient_incomplete_get_body_recovers_then_reconciles_once(self):
        self.empty_body = True  # Match the natural schedule's zero-byte response.
        code, delays = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(self.received.count(('GET', self.drop_route)), 2)
        self.assertEqual(self.truncated, 1)
        self.assertEqual([args.args for args in delays], [(1,)])
        self.assertEqual([path for _, path, _ in self.github.mutations],
                         ['issues', 'issues/1/comments', 'issues/1/labels'])
        report = json.loads((self.root / 'output/report.json').read_text())
        self.assertEqual(report['admission_summary']['qualifying_candidates'], 1)
        self.assertEqual(len(self.github.issues), 1)

    def test_exhausted_get_body_reads_fail_closed_after_prior_eligible_data(self):
        # A complete eligible first run must not be reconciled if the next
        # attempt's collection is unavailable. No partial aggregate is emitted.
        run = copy.deepcopy(self.github.runs[0])
        run['id'] = 11
        self.github.runs.append(run)
        self.github.jobs[(11, 1)] = [job(2, 700)]
        self.drop_route = 'actions/runs/11/attempts/1/jobs'
        self.drops_remaining = -1
        code, delays = self.run_cli()
        self.assertEqual(code, 1)
        self.assertEqual(self.received.count(('GET', 'actions/runs/10/attempts/1/jobs')), 1)
        self.assertEqual(self.received.count(('GET', self.drop_route)), 3)
        self.assertEqual(self.truncated, 3)
        self.assertEqual([args.args for args in delays], [(1,), (2,)])
        self.assertEqual(self.github.mutations, [])
        self.assertNotIn(('GET', 'issues'), self.received)
        self.assertFalse((self.root / 'output/report.json').exists())
        self.assertFalse((self.root / 'output/summary.md').exists())
        self.assertFalse((self.root / 'summary.md').exists())

    def test_incomplete_post_response_is_not_retried_after_acceptance(self):
        self.drop_method, self.drop_route, self.drops_remaining = 'POST', 'issues', -1
        code, delays = self.run_cli()
        self.assertEqual(code, 1)
        self.assertEqual(self.received.count(('POST', 'issues')), 1)
        self.assertEqual(self.truncated, 1)
        self.assertEqual(delays, [])
        self.assertEqual([path for _, path, _ in self.github.mutations], ['issues'])
        self.assertEqual(len(self.github.issues), 1)
        self.assertEqual(self.github.comments, {})
        self.assertFalse((self.root / 'output/report.json').exists())


if __name__ == '__main__':
    unittest.main()
