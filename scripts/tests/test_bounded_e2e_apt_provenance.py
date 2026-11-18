"""Read-only collector and real supervisor exit-contract regressions.

These do not claim real Ubuntu package acquisition/browser ENV success.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("provenance", ROOT / "scripts/collect-apt-provenance.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
catalog_spec = importlib.util.spec_from_file_location("catalog", ROOT / "scripts/apt_catalog_evidence.py")
catalog = importlib.util.module_from_spec(catalog_spec)
catalog_spec.loader.exec_module(catalog)


class CollectorTests(unittest.TestCase):
    def test_sdk_declarations_and_provider_observations_reach_candidate_queries(self):
        with tempfile.TemporaryDirectory() as directory:
            requests = []
            def run(args):
                requests.append(args)
                text = "provider-library\n" if args[:2] == ["apt-cache", "depends"] else ""
                return {"exit": 0, "stdout": text, "stderr": "", "truncated": False}
            native = {"exit": 0, "truncated": False, "stdout": json.dumps({
                "packages": ["sdk-library", "virtual-browser"],
                "groups": {"tools": ["sdk-library"], "chromium": ["virtual-browser"]}})}
            with patch.object(collector, "probe", return_value=native):
                result = collector.collect(Path(directory), ["repository-library"], run, phase="after")
            providers = next(args for args in requests if args[:2] == ["apt-cache", "showpkg"])
            for package in ["repository-library", "sdk-library", "virtual-browser"]:
                self.assertIn(package, providers)
                self.assertIn(package, requests[-1])
            self.assertIn("provider-library", requests[-1])
            self.assertEqual(result["refresh_boundary"], "not asserted")
            self.assertFalse(result["source_exclusion_proof"])

    def test_partial_checkpoints_never_become_fresh_or_complete_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoints = []
            def run(args):
                if args[:2] == ["apt-cache", "depends"]:
                    return {"status": "timeout", "output": "not retained"}
                return {"exit": 0, "stdout": "", "stderr": "", "truncated": False}
            result = collector.collect(Path(directory), ["fixture-lib"], run,
                                       checkpoint=lambda value: checkpoints.append(json.loads(json.dumps(value))))
            self.assertGreater(len(checkpoints), 3)
            self.assertEqual(result["collection_status"], "partial")
            self.assertTrue(all(not value["readiness_evidence"] and not value["source_exclusion_proof"] for value in checkpoints))
            self.assertEqual(checkpoints[0]["refresh_boundary"], "not asserted")

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

    def test_non_http_source_references_do_not_expose_private_paths_or_queries(self):
        for source in ["URIs: mirror+file:/private-token?token=synthetic-secret", "file:/private-token"]:
            result = collector.sanitize(source)
            self.assertNotIn("private-token", result)
            self.assertNotIn("synthetic-secret", result)


class SupervisorTests(unittest.TestCase):
    def run_case(self, acquisition_exit, diagnostic_body, budget="20", acquisition_delay="0", refresh_exit="0"):
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
apt_is_available() { return "$FIXTURE_REFRESH_EXIT"; }
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
                   "E2E_OS_BUDGET_SECONDS": budget, "FIXTURE_REFRESH_EXIT": refresh_exit}
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

    def test_success_boundary_is_recorded_before_sdk_work(self):
        result, _ = self.run_case(0, 'printf "%s\\n" "$*"')
        # Actual worker contains this invocation after strict refresh, before
        # the SDK stage; the private fixture cannot execute an OS transaction.
        self.assertEqual(result.returncode, 0)
        self.assertIn("phase=after-refresh diagnostic-exit=0", result.stdout)
        self.assertLess(result.stdout.index("phase=after-refresh"), result.stdout.index("playwright-install-deps"))

    def test_failed_acquisition_never_claims_the_success_boundary(self):
        result, _ = self.run_case(100, "exit 0")
        self.assertEqual(result.returncode, 100)
        self.assertNotIn("phase=after-refresh", result.stdout)

    def test_failed_refresh_with_otherwise_ready_packages_never_claims_success_boundary(self):
        result, _ = self.run_case(0, "exit 0", refresh_exit="100")
        self.assertEqual(result.returncode, 100)
        self.assertNotIn("phase=after-refresh", result.stdout)
        self.assertNotIn("stage=ready", result.stdout)


class NativeDeclarationTests(unittest.TestCase):
    def node(self, code):
        return subprocess.run(["node", "-e", code], cwd=ROOT, capture_output=True, text=True, timeout=20)

    def test_literal_declarations_and_refused_ambiguous_or_executable_shapes(self):
        result = self.node('''
const assert = require('node:assert/strict');
const {declarations} = require('./scripts/locked-browser-os-packages.cjs');
const ts = require('./client/node_modules/typescript');
const good = 'deps = {"ubuntu26.04-x64":{tools:["xvfb"],chromium:["font-one"],firefox:["lib-two"]}};';
assert.deepEqual(declarations(ts,good,'ubuntu26.04-x64','chromium'),{tools:['xvfb'],chromium:['font-one']});
assert.deepEqual(declarations(ts,good,'ubuntu26.04-x64','firefox'),{tools:['xvfb'],firefox:['lib-two']});
for(const bad of [good+good,good.replace('["font-one"]','[...compute()]'),good.replace('["font-one"]','["font-"+"one"]'),good.replace('tools:["xvfb"],',''),good.replace('deps = {','deps = { ...other,')]) {
 assert.throws(()=>declarations(ts,bad,'ubuntu26.04-x64','chromium'));
}
assert.throws(()=>declarations(ts,good,'unknown-platform','chromium'));
''')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_actual_frozen_sdk_produces_both_browser_and_tools_groups(self):
        result = self.node('''
const assert=require('node:assert/strict');
const {inspect}=require('./scripts/locked-browser-os-packages.cjs');
const lock=require('./client/package-lock.json');
const {declarations}=require('./scripts/locked-browser-os-packages.cjs');
const ts=require('./client/node_modules/typescript');
const fs=require('node:fs');
const source=fs.readFileSync('./client/node_modules/playwright-core/lib/coreBundle.js','utf8');
for(const browser of ['chromium','firefox']) {
 const value=inspect(process.cwd(),browser);
 assert.equal(value.version,lock.packages['node_modules/playwright-core'].version);
 assert.ok(value.groups.tools.includes('xvfb'));
 assert.ok(value.groups[browser].length>0);
 assert.deepEqual(value.packages,[...new Set([...value.groups.tools,...value.groups[browser]])].sort());
 assert.match(value.bundleSha256,/^[a-f0-9]{64}$/);
 const ubuntu=declarations(ts,source,'ubuntu26.04-x64',browser);
 assert.ok(ubuntu.tools.includes('xvfb'));
 assert.ok(ubuntu[browser].includes(browser==='firefox'?'libavcodec62':'libasound2t64'));
}
''')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mismatched_installed_sdk_is_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = root / "client"
            (client / "node_modules/@playwright/test").mkdir(parents=True)
            (client / "package-lock.json").write_text(json.dumps({"packages": {"node_modules/playwright-core": {"version": "1.64.1"}}}))
            (client / "node_modules/@playwright/test/package.json").write_text('{"version":"1.64.0"}')
            result = subprocess.run(["node", str(ROOT / "scripts/locked-browser-os-packages.cjs"), str(root), "chromium"],
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")


class CatalogTests(unittest.TestCase):
    def test_unavailable_index_targets_are_explicitly_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = catalog.collect_catalogs(root, root / "lists", root / "evidence",
                                              lambda args: {"status": "timeout"})
            self.assertEqual(result["status"], "incomplete")
            self.assertEqual(result["index_targets_status"]["status"], "timeout")
            self.assertFalse((root / "evidence").exists())

    def fixture(self, directory, *, trusted=True, private=False, bad_hash=False):
        root = Path(directory)
        lists = root / "var/lib/apt/lists"
        lists.mkdir(parents=True)
        data = b"Package: public-library\nVersion: 1\nProvides: virtual-library\n\n"
        if private:
            data += b"Homepage: https://user:synthetic-password@example.test/path?token=synthetic-token\n"
        index = lists / (catalog.PREFIX + "main_binary-amd64_Packages")
        index.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest() if not bad_hash else "0" * 64
        release = ("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nOrigin: test-public-catalog\nSHA256:\n "
                   + digest + " " + str(len(data)) + " main/binary-amd64/Packages\n"
                   + "\n-----BEGIN PGP SIGNATURE-----\nsynthetic-public-signature-not-verified\n-----END PGP SIGNATURE-----\n").encode()
        (lists / (catalog.PREFIX + "InRelease")).write_bytes(release)
        metadata = ("Identifier: Packages\nURI: https://packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/main/binary-amd64/Packages\n"
                    "Filename: /var/lib/apt/lists/" + index.name + "\nMetaKey: main/binary-amd64/Packages\nTrusted: "
                    + ("yes" if trusted else "no") + "\n").encode()
        commands = []
        def run(args):
            commands.append(args)
            if args == ["apt-get", "indextargets"]:
                return {"exit": 0, "status": "observed", "bytes": metadata}
            self.assertEqual(args, [str(root / "usr/lib/apt/apt-helper"), "cat-file", str(index)])
            return {"exit": 0, "status": "observed", "bytes": data}
        result = catalog.collect_catalogs(root, lists, root / "evidence", run)
        return result, commands

    def test_local_catalog_is_retained_but_not_claimed_verified_fresh_or_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            result, commands = self.fixture(directory)
            self.assertEqual(result["status"], "retained-observations")
            self.assertEqual(result["catalogs"][0]["status"], "retained-hash-linked")
            self.assertFalse(result["freshness_proof"])
            self.assertFalse(result["independent_signature_validation"])
            self.assertFalse(result["source_exclusion_proof"])
            self.assertEqual(commands[0], ["apt-get", "indextargets"])
            self.assertFalse(any("update" in command or "install" in command for command in commands))
            self.assertTrue(list((Path(directory) / "evidence").glob("Packages-*.txt")))

    def test_untrusted_hash_mismatch_and_private_uris_are_never_exported(self):
        for options, status in [({"trusted": False}, "untrusted-index-observation"),
                                ({"bad_hash": True}, "manifest-hash-mismatch"),
                                ({"private": True}, "private-uri-omitted")]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                result, _ = self.fixture(directory, **options)
                self.assertEqual(result["status"], "incomplete")
                self.assertEqual(result["catalogs"][0]["status"], status)
                self.assertFalse((Path(directory) / "evidence").exists())
                self.assertNotIn("synthetic-password", json.dumps(result))
                self.assertNotIn("synthetic-token", json.dumps(result))

    def test_other_sources_and_credential_bearing_targets_are_outside_scope(self):
        for uri in ["https://other.test/private/Packages", "https://user:secret@packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/main/binary-amd64/Packages",
                    "https://packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/main/binary-amd64/Packages?token=secret"]:
            self.assertFalse(catalog.public_target(uri))


if __name__ == "__main__":
    unittest.main()
