"""Read-only collector and real supervisor exit-contract regressions.

These do not claim real Ubuntu package acquisition/browser ENV success.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("provenance", ROOT / "scripts/collect-apt-provenance.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def test_private_source_uri_and_auth_files_are_not_exported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            apt = root / "etc/apt"
            (apt / "sources.list.d").mkdir(parents=True)
            (apt / "sources.list").write_text("deb [signed-by=/key] https://user:secret@example.test/private-token?token=secret suite main\n")
            (apt / "sources.list.d/private.sources").write_text("Types: deb\nURIs: https://user:secret@example.test/private-token?token=secret\nSuites: suite\nComponents: main\nSigned-By: inline-secret\n continuation-secret\nUnknown: unknown-secret\n")
            (apt / "auth.conf").write_text("authentication-secret")
            (apt / "preferences").write_text("Package: fixture-lib\nPin: origin example.test\nPin-Priority: 500\n")
            requests = []
            def probe(args):
                requests.append(args)
                if args[0] == "apt-config":
                    return {"exit": 0, "stdout": "ETC='etc/apt';\nLIST='sources.list';\n", "stderr": ""}
                if args[:2] == ["apt-cache", "depends"]:
                    return {"exit": 0, "stdout": "fixture-lib\nchild-lib\n", "stderr": ""}
                return {"exit": 0, "stdout": "candidate observation", "stderr": ""}
            result = collector.collect(root, ["fixture-lib"], probe)
            text = json.dumps(result)
            for value in ["secret", "private-token", "authentication-secret", "inline-secret", "continuation-secret", "unknown-secret", "user:"]:
                self.assertNotIn(value, text)
            self.assertIn("https://example.test", text)
            self.assertIn("Pin-Priority", text)
            self.assertIn("child-lib", requests[-1])
            self.assertFalse(any("apt-get" in request for request in requests))
            self.assertIn("stale/incomplete", result["purpose"])

    def test_failed_candidate_and_dependency_queries_remain_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            result = collector.collect(Path(directory), ["missing-lib"],
                                       lambda args: {"exit": 100, "stdout": "", "stderr": "unavailable"})
            self.assertEqual(result["candidate_policy"]["exit"], 100)
            self.assertEqual(result["dependency_observation"]["exit"], 100)
            self.assertFalse(result["paths_observed"])

    def test_existing_index_is_only_timestamped_reference_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lists = root / "var/lib/apt/lists"
            lists.mkdir(parents=True)
            index = lists / "private-token-Packages"
            index.write_text("stale index")
            os.utime(index, ns=(1, 1))
            result = collector.collect(root, [], lambda args: {"status": "unavailable"})
            self.assertEqual(result["index_inventory"][0]["mtime_ns"], 1)
            self.assertNotIn("private-token", json.dumps(result))
            self.assertNotIn("ready", result)

    def test_uri_variants_never_export_userinfo_query_or_path(self):
        for uri in ["https://name:password@example.test/path?token=value#secret", "file:///private-token", "https://host:invalid/private-token"]:
            result = collector.uri_identity(uri)
            for word in ["password", "token", "secret", "private", "value"]:
                self.assertNotIn(word, result)


class SupervisorTests(unittest.TestCase):
    def run_case(self, acquisition_exit, diagnostic_body, budget="20", acquisition_delay="0"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            shutil.copy2(ROOT / "scripts/setup-direct-runner-os.sh", scripts)
            common = (ROOT / "scripts/common-functions.sh").read_text()
            # Acquisition substitutes exist only in this private contract fixture.
            common += '''
playwright_pinned_version() { echo 1.64.1; }
install_os_utilities() {
  DIRECT_RUNNER_REQUIRED_PACKAGES=(fixture-lib)
  direct_runner_provenance before fixture-lib
  sleep "$FIXTURE_ACQUISITION_DELAY"
  return "$FIXTURE_ACQUISITION_EXIT"
}
apt_is_available() { return 0; }
direct_runner_root() { return 0; }
ensure_playwright_browsers() { return 0; }
'''
            (scripts / "common-functions.sh").write_text(common)
            tools = root / "bin"
            tools.mkdir()
            for name, body in [("node", "echo 1.64.1"), ("python3", diagnostic_body)]:
                file = tools / name
                file.write_text("#!/bin/bash\n" + body + "\n")
                file.chmod(0o700)
            env = {**os.environ, "PATH": f"{tools}:{os.environ['PATH']}",
                   "FIXTURE_ACQUISITION_EXIT": str(acquisition_exit), "FIXTURE_ACQUISITION_DELAY": acquisition_delay,
                   "E2E_OS_BUDGET_SECONDS": budget}
            started = time.monotonic()
            result = subprocess.run(["bash", str(scripts / "setup-direct-runner-os.sh")],
                                    env=env, capture_output=True, text=True, timeout=25)
            return result, time.monotonic() - started

    def test_diagnostic_failure_cannot_hide_acquisition_failure(self):
        result, _ = self.run_case(42, "exit 17")
        self.assertEqual(result.returncode, 42)
        self.assertIn("diagnostic-exit=17", result.stdout)
        self.assertIn("exit=42", result.stdout)
        self.assertNotIn("stage=ready", result.stdout)

    def test_diagnostic_failure_does_not_change_successful_acquisition(self):
        result, _ = self.run_case(0, "exit 17")
        self.assertEqual(result.returncode, 0)
        self.assertIn("stage=ready exit=0", result.stdout)

    def test_hung_diagnostic_shares_the_existing_aggregate_deadline(self):
        result, elapsed = self.run_case(42, "sleep 60", "10")
        self.assertEqual(result.returncode, 42)
        self.assertLess(elapsed, 10)
        self.assertIn("not collected (acquisition deadline)", result.stdout)

    def test_original_outer_timeout_remains_explicit_nonzero(self):
        result, elapsed = self.run_case(0, "exit 0", "6", acquisition_delay="60")
        self.assertEqual(result.returncode, 124)
        self.assertLess(elapsed, 8)
        self.assertNotIn("stage=ready exit=0", result.stdout)


if __name__ == "__main__":
    unittest.main()
