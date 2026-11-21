"""Repository mappings and real HTTP transport regressions for the CI monitor."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import re
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("outliner_ci_duration_github", ROOT / "scripts/ci_duration_github.py")
transport = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = transport
spec.loader.exec_module(transport)


class RepositoryConfigTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflows = json.loads((ROOT / ".github/ci-duration-monitor.json").read_text())["workflows"]

    def family_keys(self, workflow, name):
        families = next(item["families"] for item in self.workflows if item["path"] == workflow)
        return [family["key"] for family in families if re.fullmatch(family["job_pattern"], name)]

    def test_reusable_ci_jobs_and_browser_families_remain_distinct(self):
        workflow = ".github/workflows/ci.yml"
        for job, expected in [
            ("unit-test / unit-test", ["unit-tests"]),
            ("server-test / server-test", ["server-tests"]),
            ("server-test / project-directory-test", ["project-directory-tests"]),
            ("e2e-test / e2e-test (new-2-1)", ["e2e-chromium"]),
            ("e2e-test / e2e-test (new-2-2)", ["e2e-chromium"]),
            ("e2e-test / e2e-test (new-3b)", ["e2e-chromium"]),
            ("e2e-test / e2e-test (tables-2)", ["e2e-chromium"]),
            ("e2e-test / e2e-test (firefox-selection-new)", ["e2e-firefox"]),
            ("e2e-test / e2e-test (new-2)", []),
            ("e2e-test / e2e-test (new-3)", []),
        ]:
            with self.subTest(job=job):
                self.assertEqual(self.family_keys(workflow, job), expected)
        self.assertEqual(self.family_keys(".github/workflows/ci-test-e2e.yml", "e2e-test (basic)"), ["e2e-chromium"])

    def test_build_named_test_image_is_not_a_test_command(self):
        workflow = next(item for item in self.workflows if item["path"].endswith("/ci-test-container-build.yml"))
        pattern = workflow["families"][0]["test_step_pattern"]
        self.assertIsNone(re.search(pattern, "Build test image without publishing"))
        self.assertIsNotNone(re.search(pattern, "Check installed tools and absence of Tinylicious"))

    def test_config_uses_real_sources_and_excludes_monitor_and_deployment(self):
        paths = [workflow["path"] for workflow in self.workflows]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertNotIn(".github/workflows/ci-duration-monitor.yml", paths)
        self.assertNotIn(".github/workflows/deploy.yml", paths)
        for workflow in self.workflows:
            self.assertTrue((ROOT / workflow["path"]).is_file(), workflow["path"])
            keys = [family["key"] for family in workflow["families"]]
            self.assertEqual(len(keys), len(set(keys)))
            for family in workflow["families"]:
                re.compile(family["job_pattern"])
                re.compile(family["test_step_pattern"])
                for source in family["source_paths"]:
                    self.assertTrue((ROOT / source).is_file(), source)


class GitHubTransportTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                requests.append((self.command, self.path, json.loads(body) if body else None, dict(self.headers)))
                if self.path.endswith("/actions/jobs/123/logs"):
                    self.send_response(302)
                    self.send_header("Location", f"http://localhost:{self.server.server_port}/native-logs")
                    self.end_headers()
                    return
                if self.path == "/native-logs":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"native test logs")
                    return
                if self.path.endswith(("/unavailable", "/malformed")):
                    self.send_response(503 if self.path.endswith("/unavailable") else 200)
                    self.end_headers()
                    self.wfile.write(b"<html>Gateway response</html>")
                    return
                denied = self.path.endswith("/denied")
                self.send_response(403 if denied else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"message": "forbidden"} if denied else {"ok": True}).encode())

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = transport.GitHubClient("fixture-token", "example/repo", f"http://127.0.0.1:{self.server.server_port}")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_repository_endpoint_and_json_mutation_use_actual_http(self):
        response = self.client.request("GET", "actions/runs?per_page=100&page=2")
        self.assertEqual((response.status, response.data), (200, {"ok": True}))
        self.client.request("POST", "issues/42/labels", {"labels": ["review-ready"]})
        self.assertEqual(self.requests[0][:3], ("GET", "/repos/example/repo/actions/runs?per_page=100&page=2", None))
        self.assertEqual(self.requests[1][:3], ("POST", "/repos/example/repo/issues/42/labels", {"labels": ["review-ready"]}))
        self.assertEqual(self.requests[1][3]["Authorization"], "Bearer fixture-token")

    def test_native_log_redirect_strips_cross_origin_credentials(self):
        result = self.client.request("GET", "actions/jobs/123/logs")
        self.assertEqual((result.status, result.data), (200, "native test logs"))
        self.assertEqual(self.requests[0][3]["Authorization"], "Bearer fixture-token")
        self.assertNotIn("Authorization", self.requests[1][3])

    def test_http_error_preserves_status_but_success_requires_json(self):
        response = self.client.request("GET", "unavailable")
        self.assertEqual((response.status, response.data), (503, None))
        with self.assertRaisesRegex(RuntimeError, "non-JSON"):
            self.client.request("GET", "malformed")
        self.assertEqual(len(self.requests), 2)

    def test_failed_mutations_return_status_without_retries(self):
        response = self.client.request("POST", "denied", {"labels": ["review-ready"]})
        self.assertEqual((response.status, response.data), (403, {"message": "forbidden"}))
        self.assertEqual(len(self.requests), 1)


if __name__ == "__main__":
    unittest.main()
