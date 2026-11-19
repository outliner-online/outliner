"""Transport privacy/checkpoint and real diagnostic-supervisor regressions.

Uses the production collector. Private probe fixtures are control-flow oracles,
not signed package acquisition or browser readiness evidence.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("transport_collector", ROOT / "scripts/collect-apt-provenance.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TransportObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "etc/apt/apt-mirrors.txt"
        self.path.parent.mkdir(parents=True)
        self.commands = []

    def observe(self, output=None):
        def runner(argv):
            self.commands.append(argv)
            return output if output is not None else {"exit": 0, "stdout": "", "truncated": False}
        return module.collect_transport_observation(self.root, runner)

    def test_public_mirrors_keep_order_and_hash_path(self):
        self.path.write_text("http://us-east-2.ec2.archive.ubuntu.com/ubuntu priority:1\nhttps://archive.ubuntu.com/ubuntu\n")
        result = self.observe()
        self.assertEqual(len(result["mirrorlist"]["entries"]), 2)
        self.assertTrue(result["mirrorlist"]["entries"][0].startswith("http://us-east-2.ec2.archive.ubuntu.com/[path-sha256:"))
        self.assertEqual(result["mirrorlist"]["omitted_entries"], 0)
        self.assertFalse(result["readiness_evidence"])
        self.assertFalse(result["source_exclusion_proof"])

    def test_credentials_queries_unknown_hosts_and_settings_are_not_exported(self):
        self.path.write_text("https://user:synthetic-secret@archive.ubuntu.com/private-path?key=synthetic-secret\nhttps://private.invalid/secret\n")
        result = self.observe({"exit": 0, "stdout": "RETRIES='1'; HTTP_TIMEOUT='15'; HTTP_DL_LIMIT='0'; QUEUE='host'; UNKNOWN='synthetic-secret'; IPV4='true';", "truncated": False})
        encoded = json.dumps(result)
        for denied in ("synthetic-secret", "private.invalid", "private-path", "UNKNOWN", "user:"):
            self.assertNotIn(denied, encoded)
        self.assertEqual(result["mirrorlist"]["omitted_entries"], 1)
        self.assertEqual(result["settings"]["Acquire::http::Dl-Limit"], "0")
        self.assertEqual(result["settings"]["Acquire::ForceIPv4"], "true")

    def test_only_one_readonly_allowlisted_command(self):
        self.observe()
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0][:2], ["apt-config", "shell"])
        self.assertFalse(any("proxy" in x.lower() or "auth" in x.lower() for x in self.commands[0]))

    def test_unset_is_unknown_not_default(self):
        result = self.observe()
        self.assertEqual(result["settings"], {})
        self.assertEqual(result["mirrorlist"]["status"], "absent")

    def test_bad_typed_values_and_stderr_do_not_escape(self):
        result = self.observe({"exit": 0, "stdout": "HTTP_TIMEOUT='synthetic-secret'; QUEUE='synthetic-secret';", "stderr": "synthetic-secret", "truncated": False})
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertEqual(result["settings"]["Acquire::http::Timeout"], "[unsupported value omitted]")

    def test_failure_does_not_parse_stdout(self):
        result = self.observe({"exit": 4, "stdout": "RETRIES='42';", "stderr": "synthetic-secret"})
        self.assertEqual(result["config_exit"], 4)
        self.assertEqual(result["settings"], {})
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_timeout_does_not_claim_success(self):
        result = self.observe({"status": "timeout"})
        self.assertEqual(result["config_status"], "timeout")
        self.assertIsNone(result["config_exit"])

    def test_truncated_and_malformed_config_are_explicit(self):
        for response, status in [
            ({"exit": 0, "stdout": "RETRIES='1';", "truncated": True}, "truncated"),
            ({"exit": 0, "stdout": "RETRIES='", "truncated": False}, "unparseable"),
        ]:
            result = self.observe(response)
            self.assertEqual(result["config_status"], status)
            self.assertEqual(result["settings"], {})

    def test_symlink_not_followed(self):
        secret = self.root / "synthetic-credentials"
        secret.write_text("synthetic-secret")
        self.path.symlink_to(secret)
        result = self.observe()
        self.assertEqual(result["mirrorlist"]["status"], "unreadable")
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_oversized_not_read_as_evidence(self):
        self.path.write_bytes(b"x" * 4097)
        self.assertEqual(self.observe()["mirrorlist"]["status"], "nonregular or oversized omitted")

    def test_fifo_does_not_block(self):
        os.mkfifo(self.path)
        self.assertEqual(self.observe()["mirrorlist"]["status"], "nonregular or oversized omitted")

    def test_invalid_utf8_is_explicit(self):
        self.path.write_bytes(b"\xff")
        self.assertEqual(self.observe()["mirrorlist"]["status"], "unreadable")


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.apt = self.root / "etc/apt"
        self.apt.mkdir(parents=True)
        (self.apt / "apt-mirrors.txt").write_text("http://archive.ubuntu.com/ubuntu\n")

    def collect(self, transport):
        records = []
        def runner(argv):
            if argv[:3] == ["apt-config", "shell", "RETRIES"]:
                return transport
            return {"exit": 0, "stdout": "", "stderr": "", "truncated": False}
        def checkpoint(result):
            # Serialize every real collector checkpoint, not a retained alias.
            (self.root / "checkpoint.json").write_text(json.dumps(result))
            records.append(copy.deepcopy(result))
        result = module.collect(self.root, ["libc6"], runner, checkpoint=checkpoint)
        return result, records

    def test_success_is_checkpointed_before_candidate_collection(self):
        result, records = self.collect({"exit": 0, "stdout": "RETRIES='1';", "truncated": False})
        self.assertNotIn("transport_observation", records[0])
        self.assertEqual(records[1]["transport_observation"]["status"], "pending")
        self.assertEqual(records[2]["transport_observation"]["collection_status"], "collected-observations")
        self.assertNotIn("candidate_policy", records[2])
        self.assertEqual(result["collection_status"], "collected-observations")
        self.assertFalse(result["readiness_evidence"])

    def test_nonzero_and_timeout_remain_partial_in_final_checkpoint(self):
        for response in ({"exit": 7, "stdout": "secret-not-retained"}, {"status": "timeout"}):
            result, records = self.collect(response)
            self.assertEqual(result["collection_status"], "partial")
            self.assertEqual(result["transport_observation"]["collection_status"], "partial")
            self.assertIn("candidate_policy", result)
            self.assertEqual(records[-1], json.loads((self.root / "checkpoint.json").read_text()))
            self.assertNotIn("secret-not-retained", json.dumps(records))

    def test_absent_or_rejected_mirror_marks_whole_collection_partial(self):
        path = self.apt / "apt-mirrors.txt"
        path.unlink()
        result, _ = self.collect({"exit": 0, "stdout": ""})
        self.assertEqual(result["collection_status"], "partial")
        path.write_text("https://private.invalid/secret\n")
        result, _ = self.collect({"exit": 0, "stdout": ""})
        self.assertEqual(result["collection_status"], "partial")

    def test_unexpected_probe_error_leaves_pending_partial_checkpoint(self):
        records = []
        def runner(argv):
            if argv[:3] == ["apt-config", "shell", "RETRIES"]:
                raise OSError("synthetic private error")
            return {"exit": 0, "stdout": "", "truncated": False}
        with self.assertRaises(OSError):
            module.collect(self.root, ["libc6"], runner, checkpoint=lambda r: records.append(copy.deepcopy(r)))
        self.assertEqual(records[-1]["collection_status"], "partial")
        self.assertEqual(records[-1]["transport_observation"]["status"], "pending")
        self.assertNotIn("synthetic private error", json.dumps(records))

    def test_parent_symlink_swap_cannot_redirect_open(self):
        target = self.root / "outside"
        target.mkdir()
        (target / "apt-mirrors.txt").write_text("https://private.invalid/secret\n")
        original = os.open
        swapped = []
        def racing_open(path, flags, *args, **kwargs):
            if path == "apt" and not swapped:
                self.apt.rename(self.root / "etc/old-apt")
                self.apt.symlink_to(target, target_is_directory=True)
                swapped.append(True)
            return original(path, flags, *args, **kwargs)
        with patch.object(module.os, "open", racing_open):
            result = module.collect_transport_observation(self.root, lambda argv: {"exit": 0, "stdout": ""})
        self.assertTrue(swapped)
        self.assertEqual(result["mirrorlist"]["status"], "unreadable")
        self.assertEqual(result["collection_status"], "partial")
        self.assertNotIn("private.invalid", json.dumps(result))

    def test_parent_rename_after_open_remains_anchored(self):
        original = os.open
        swapped = []
        def racing_open(path, flags, *args, **kwargs):
            if path == "apt-mirrors.txt" and not swapped:
                self.apt.rename(self.root / "etc/old-apt")
                self.apt.symlink_to(self.root / "nonexistent", target_is_directory=True)
                swapped.append(True)
            return original(path, flags, *args, **kwargs)
        with patch.object(module.os, "open", racing_open):
            result = module.collect_transport_observation(self.root, lambda argv: {"exit": 0, "stdout": ""})
        self.assertTrue(swapped)
        self.assertEqual(result["mirrorlist"]["status"], "observed-public-origins")
        self.assertEqual(result["collection_status"], "collected-observations")

    def test_real_readonly_apt_config_output(self):
        # Actual local apt-config; fixed mirror fixture, no refresh or host edit.
        result = module.collect_transport_observation(self.root)
        self.assertEqual(result["config_exit"], 0)
        self.assertEqual(result["config_status"], "observed")
        self.assertEqual(result["collection_status"], "collected-observations")


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        common = (ROOT / "scripts/common-functions.sh").read_text()
        start = common.index("direct_runner_provenance() {")
        end = common.index("\n}\n", start) + 3
        self.function = common[start:end]

    def run_wrapper(self, body, original_exit=0, deadline_ms=4000):
        collector = self.root / "scripts/collect-apt-provenance.py"
        collector.write_text(body)
        script = self.function + '\nROOT_DIR="$1"\nexport E2E_OS_WORK_DEADLINE=$(($(date +%s%3N) + $2))\n'
        # Same EXIT-trap structure as the actual acquisition worker.
        script += 'DIRECT_RUNNER_REQUIRED_PACKAGES=()\ntrap \'acquisition_status=$?; direct_runner_provenance after "${DIRECT_RUNNER_REQUIRED_PACKAGES[@]}"; exit "$acquisition_status"\' EXIT\nexit "$3"\n'
        started = time.monotonic()
        run = subprocess.run(["bash", "-c", script, "fixture", str(self.root), str(deadline_ms), str(original_exit)],
                             capture_output=True, text=True, timeout=8)
        return run, time.monotonic() - started

    def test_diagnostic_nonzero_preserves_acquisition_success_and_failure(self):
        for original in (0, 37):
            run, elapsed = self.run_wrapper("raise SystemExit(19)\n", original)
            self.assertEqual(run.returncode, original)
            self.assertIn("diagnostic-exit=19", run.stdout)
            self.assertLess(elapsed, 3)

    def test_actual_diagnostic_timeout_preserves_exit_and_deadline(self):
        run, elapsed = self.run_wrapper("import time\ntime.sleep(30)\n", 37)
        self.assertEqual(run.returncode, 37)
        self.assertIn("diagnostic-exit=124", run.stdout)
        self.assertLess(elapsed, 4)

    def test_expired_deadline_does_not_start_collector(self):
        marker = self.root / "started"
        run, elapsed = self.run_wrapper("from pathlib import Path\nPath(" + repr(str(marker)) + ").touch()\n", 37, 0)
        self.assertEqual(run.returncode, 37)
        self.assertIn("not collected (acquisition deadline)", run.stdout)
        self.assertFalse(marker.exists())
        self.assertLess(elapsed, 2)


if __name__ == "__main__":
    unittest.main()
