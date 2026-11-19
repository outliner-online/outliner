"""Small local contract/negative tests, not real image or ENV coverage."""
import hashlib
import ast
import io
import shlex
from unittest.mock import patch
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from seal import cache_inventory
import seal
from select_jobs import select

OVERLAY = HERE.parents[2]
# In a published checkout this resolves to the repository, in local overlay too.
RECIPE = OVERLAY / '.github/container/Dockerfile.prebuilt-prototype'
WORKFLOW = OVERLAY / '.github/workflows/ci-test-container-build.yml'


class Changes(unittest.TestCase):
    def test_prototype_only_no_legacy_build(self):
        self.assertEqual(select(['scripts/ci/prebuilt/validate.py']), {'legacy': False, 'prototype': True})

    def test_recipe_only_no_legacy_build(self):
        self.assertEqual(select(['.github/container/Dockerfile.prebuilt-prototype']), {'legacy': False, 'prototype': True})

    def test_shared_workflow_validates_both_distinct_recipes(self):
        self.assertEqual(select(['.github/workflows/ci-test-container-build.yml']), {'legacy': True, 'prototype': True})

    def test_legacy_only_unchanged(self):
        self.assertEqual(select(['scripts/setup-direct-runner-os.sh']), {'legacy': True, 'prototype': True})

    def test_docs_with_prototype_not_unnecessary_legacy(self):
        self.assertEqual(select(['docs/readme.md', 'scripts/ci/prebuilt/validate.py']), {'legacy': False, 'prototype': True})

    def test_mixed_legacy_change_is_not_skipped(self):
        self.assertEqual(select(['client/package-lock.json', 'scripts/ci/prebuilt/validate.py']), {'legacy': True, 'prototype': True})


class Cache(unittest.TestCase):
    def test_empty_cache_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(ValueError):
                cache_inventory(Path(t))

    def test_real_file_hash_tracks_mutation(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t);(p / 'fixture').write_bytes(b'fixture bytes, not executable')
            before = cache_inventory(p)
            self.assertEqual(before['fixture'], hashlib.sha256((p / 'fixture').read_bytes()).hexdigest())
            (p / 'fixture').write_bytes(b'changed')
            self.assertNotEqual(cache_inventory(p), before)

    def test_symlink_cache_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t);(p / 'link').symlink_to('/etc/hostname')
            with self.assertRaises(ValueError):
                cache_inventory(p)


class RecipeContract(unittest.TestCase):
    def test_node_supply_and_recipe_match(self):
        supply = json.loads((HERE / 'node-supply.json').read_text())
        recipe = RECIPE.read_text()
        self.assertTrue(supply['artifact_url'].startswith('https://nodejs.org/dist/v22.'))
        self.assertIn(supply['artifact_url'], recipe)
        self.assertIn(supply['sha256'], recipe)
        self.assertIn('sha256sum --check --strict', recipe)
        self.assertIn('node --version', recipe)

    def test_os_one_deadline_both_browsers(self):
        producer = (HERE / 'produce-os.sh').read_text()
        self.assertIn('595000', producer)
        self.assertIn('--kill-after=5 595', producer)
        self.assertIn('for browser in chromium firefox', producer)
        self.assertIn('apt_is_available', producer)
        self.assertIn('DIRECT_RUNNER_OS_STRICT=1', producer)
        self.assertNotIn('SKIP_APT_INSTALL=1', producer)

    def test_no_publish_or_dispatch_and_existing_permissions(self):
        workflow = WORKFLOW.read_text()
        self.assertIn('contents: read', workflow)
        for forbidden in ['workflow_dispatch', 'packages: write', 'docker push', '--push', 'secrets.']:
            self.assertNotIn(forbidden, workflow)
        self.assertIn('timeout-minutes: 30', workflow)

    def test_offline_readonly_no_cache_success(self):
        workflow = WORKFLOW.read_text()
        self.assertIn('docker build --no-cache', workflow)
        self.assertIn('--network none --read-only', workflow)
        self.assertIn('--cap-drop ALL', workflow)
        self.assertIn('$(cat job_logs/prepared-image-id)', workflow)
        recipe = RECIPE.read_text()
        self.assertIn('USER pwuser', recipe)

    def test_runtime_negative_controls_do_not_accept_timeout_or_docker_error(self):
        workflow = WORKFLOW.read_text()
        self.assertIn('test "$status" -eq 1', workflow)
        self.assertIn('for missing in /opt/emulator-cache /prepared/source/client/node_modules', workflow)
        self.assertIn('EXPECTED_SOURCE_REVISION=0000000000000000000000000000000000000000', workflow)

    def test_portable_bootstrap_contract_and_ci_test_integration(self):
        recipe = RECIPE.read_text()
        self.assertNotIn('.tar.xz', recipe)
        self.assertNotIn('tar -xJf', recipe)
        self.assertIn('node-v22.23.5-linux-x64.tar.gz', recipe)
        self.assertIn('COPY scripts/ci/prebuilt/extract-node.cjs /tmp/extract-node.cjs', recipe)
        self.assertLess(recipe.index('sha256sum --check --strict'), recipe.index('&& node /tmp/extract-node.cjs'))
        self.assertIn('node --test scripts/ci/prebuilt/extract-node.test.cjs', WORKFLOW.read_text())

    def test_smoke_is_not_e2e_readiness(self):
        validator = (HERE / 'validate.py').read_text()
        self.assertIn("'readiness': False", validator)
        self.assertIn("'E2E_executed': False", validator)
        self.assertIn('profile.check(root, base_plan)', validator)
        self.assertIn('demo-prepared-runtime', validator)
        for forbidden in ['apt-get', 'npm install', 'setup:emulators']:
            self.assertNotIn(forbidden, validator)



class BaselineCompatibility(unittest.TestCase):
    def test_hashing_works_without_python311_file_digest(self):
        # Emulate absence of 3.11 API on current interpreter; no image execution.
        with tempfile.TemporaryDirectory() as t:
            p = Path(t); data = bytes(range(256)) * 5000 + b'tail'
            (p / 'fixture').write_bytes(data)
            with patch.object(hashlib, 'file_digest', None, create=True):
                self.assertEqual(cache_inventory(p)['fixture'], hashlib.sha256(data).hexdigest())

    def test_bounded_reads_and_same_bytes(self):
        data = b'a' * (2 * 1024 * 1024 + 7)
        class Bounded(io.BytesIO):
            def read(self, n=-1):
                self_size = 1024 * 1024
                if n != self_size:
                    raise AssertionError('unbounded or changed chunk read')
                return super().read(n)
        with tempfile.TemporaryDirectory() as t:
            p = Path(t); (p / 'fixture').touch()
            with patch.object(Path, 'open', return_value=Bounded(data)):
                self.assertEqual(cache_inventory(p)['fixture'], hashlib.sha256(data).hexdigest())

    def test_empty_file_digest_preserved(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t);(p / 'empty').touch()
            self.assertEqual(cache_inventory(p)['empty'], hashlib.sha256(b'').hexdigest())

    def test_python310_grammar_and_no_new_hash_api(self):
        for p in HERE.glob('*.py'):
            ast.parse(p.read_text(), feature_version=(3, 10))
        tree = ast.parse((HERE / 'seal.py').read_text())
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr == 'file_digest' for n in ast.walk(tree)))


class DependencyCoverage(unittest.TestCase):
    def test_every_recipe_copy_source_selects_candidate(self):
        # Derive coverage independently from actual COPY declarations, not selector constants.
        for line in RECIPE.read_text().splitlines():
            if not line.startswith('COPY '):
                continue
            for source in shlex.split(line)[1:-1]:
                path = source + 'coverage-fixture.py' if source.endswith('/') else source
                with self.subTest(path=path):
                    self.assertTrue(select([path])['prototype'])

    def test_actual_dependency_examples(self):
        for path in ['client/package-lock.json', 'scripts/common-functions.sh',
                     'scripts/locked-browser-os-packages.cjs', 'scripts/require-java-21.sh',
                     'scripts/verify-test-container-os-tools.sh', '.firebase-tools-version',
                     'shared/package-lock.json', 'patches/example.patch', 'client/patches/example.patch',
                     'firebase.json', 'firebase.emulator.json', '.dockerignore']:
            with self.subTest(path=path):
                self.assertTrue(select([path])['prototype'])

    def test_unrelated_product_and_docs_do_not_build_images(self):
        for path in ['README.md', 'client/src/example.ts', 'functions/index.js',
                     'server/src/example.ts', 'client/e2e/tables/example.spec.ts']:
            with self.subTest(path=path):
                self.assertEqual(select([path]), {'legacy': False, 'prototype': False})

    def test_candidate_only_inputs_do_not_rebuild_legacy(self):
        for path in ['shared/package-lock.json', 'patches/example.patch', 'client/patches/example.patch']:
            with self.subTest(path=path):
                self.assertEqual(select([path]), {'legacy': False, 'prototype': True})

    def test_workflow_trigger_covers_all_copy_inputs_and_context(self):
        # Keep this test stdlib-only so it also runs on bare hosted Python.
        import fnmatch
        workflow = WORKFLOW.read_text()
        paths_block = workflow.split('    paths:\n', 1)[1].split('\npermissions:', 1)[0]
        patterns = [line.strip()[3:-1] for line in paths_block.splitlines() if line.strip().startswith("- '")]
        probes = ['.dockerignore', '.github/container/Dockerfile.prebuilt-prototype']
        for line in RECIPE.read_text().splitlines():
            if line.startswith('COPY '):
                probes.extend(s + 'coverage-fixture.py' if s.endswith('/') else s for s in shlex.split(line)[1:-1])
        for path in probes:
            with self.subTest(path=path):
                self.assertTrue(any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns))


if __name__ == '__main__':
    unittest.main()
