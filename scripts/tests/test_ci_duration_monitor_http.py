"""Exercise the real CLI and HTTP adapter against an isolated GitHub REST fixture."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from test_ci_duration_monitor import GitHub, job

ROOT = Path(__file__).resolve().parents[2]


class MonitorHTTPTest(unittest.TestCase):
    def test_cli_collects_read_only_then_submits_once_with_readiness_last(self):
        github = GitHub()
        now = datetime.now(timezone.utc)
        observation = job()
        for field, seconds in [("created_at", -610), ("started_at", -600), ("completed_at", 0)]:
            observation[field] = (now + timedelta(seconds=seconds)).isoformat()
        observation["steps"][0]["started_at"] = (now - timedelta(seconds=600)).isoformat()
        observation["steps"][0]["completed_at"] = now.isoformat()
        github.jobs[(10, 1)] = [observation]
        github.runs.append({**github.runs[0], "id": 9})
        github.jobs[(9, 1)] = [{**observation, "id": 2}]
        github.runs[0]["run_started_at"] = (now - timedelta(seconds=700)).isoformat()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                prefix = "/repos/example/project/"
                if self.path != prefix.rstrip("/") and not self.path.startswith(prefix):
                    self.send_error(404)
                    return
                result = github.request(self.command, self.path[len(prefix):] if self.path.startswith(prefix) else "", json.loads(body) if body else None)
                self.send_response(result.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result.data).encode())

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server, tempfile.TemporaryDirectory() as directory:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                temporary = Path(directory)
                config = temporary / "monitor.json"
                config.write_text(json.dumps({"workflows": [{
                    "path": ".github/workflows/ci.yml",
                    "families": [{
                        "key": "tests", "name": "Tests", "job_pattern": r"Tests \(\d+/\d+\)",
                        "test_step_pattern": "^Run tests$", "source_paths": [".github/workflows/ci.yml"],
                        "guidance": "Inspect actual durations and preserve complete test selection.", "measurement": "test-step",
                    }],
                }]}))
                command = [sys.executable, str(ROOT / "scripts/ci_duration_monitor.py"),
                           "--repository", "example/project", "--config", str(config),
                           "--output-dir", str(temporary / "output"), "--source-ref", "b" * 40]
                environment = {**os.environ, "GITHUB_TOKEN": "fixture-token",
                               "GITHUB_STEP_SUMMARY": str(temporary / "step-summary.md"),
                               "GITHUB_API_URL": f"http://127.0.0.1:{server.server_port}"}
                dry = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=15)
                self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
                self.assertEqual(github.mutations, [])
                published = subprocess.run([*command, "--publish"], env=environment,
                                           capture_output=True, text=True, timeout=15)
                self.assertEqual(published.returncode, 0, published.stdout + published.stderr)
                self.assertEqual([call[1] for call in github.mutations],
                                 ["issues", "issues/1/comments", "issues/1/labels"])
                self.assertEqual(github.mutations[0][2]["labels"], ["ci-duration-monitor"])
                self.assertEqual(github.mutations[-1][2], {"labels": ["review-ready"]})
                self.assertIn("Monitor completed", published.stdout)
                report = json.loads((temporary / "output/report.json").read_text())
                self.assertEqual(report["actions"][0]["issue"], 1)
                self.assertTrue(list((temporary / "output").glob("*.log")))
                replay = subprocess.run([*command, "--publish"], env=environment,
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(replay.returncode, 0, replay.stdout + replay.stderr)
                self.assertEqual(len(github.mutations), 3)
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
