"""Run only tiny real Mocha fixtures to verify prepared CI/local runner parity."""

from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ServerExecutionBoundaryTest(unittest.TestCase):
    def test_current_checkout_workflow_artifacts_and_native_failure(self):
        results_env = os.environ.get('SERVER_TEST_WORKFLOW_RESULTS')
        if not results_env:
            self.skipTest('calling workflow provides its downloaded same-checkout results')

        results = (ROOT / results_env).resolve()
        full_identities = None
        executed_identities = []
        for index in [1, 2]:
            shard = results / f'shard-{index}'
            full = json.loads((shard / 'full.json').read_text())
            executed = json.loads((shard / 'executed.json').read_text())
            identities = sorted((test['file'], test['title']) for test in full['tests'])
            if full_identities is None:
                full_identities = identities
            else:
                self.assertEqual(identities, full_identities)
            executed_identities.extend((test['file'], test['title']) for test in executed['tests'])
        self.assertEqual(sorted(executed_identities), full_identities)

        passing = subprocess.run(
            ['bash', 'scripts/ci/verify-server-test-job.sh', 'success', str(results), '2'],
            cwd=ROOT, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(passing.returncode, 0, passing.stdout + passing.stderr)

        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            failing_test = temporary / 'workflow-native-failure.test.cjs'
            failing_test.write_text('it("workflow native failure",()=>{throw new Error("expected native failure")});')
            native_report = temporary / 'native-failure.json'
            native = subprocess.run(
                ['bash', 'scripts/run-server-test-command.sh', '--reporter',
                 '../scripts/ci/server-test-reporter.mjs', str(failing_test)],
                cwd=ROOT, env=os.environ | {
                    'SERVER_TEST_FILES_ONLY': '1',
                    'SERVER_TEST_REPORT': str(native_report),
                }, text=True, capture_output=True, timeout=30,
            )
            self.assertNotEqual(native.returncode, 0)
            self.assertIn('workflow native failure', native_report.read_text())

            failing_results = temporary / 'server-test-results'
            shutil.copytree(results, failing_results)
            outcome_path = failing_results / 'shard-1/outcome.json'
            outcome = json.loads(outcome_path.read_text())
            outcome['status'] = native.returncode
            outcome_path.write_text(json.dumps(outcome))
            aggregate = subprocess.run(
                ['bash', 'scripts/ci/verify-server-test-job.sh', 'success',
                 str(failing_results), '2'], cwd=ROOT, text=True,
                capture_output=True, timeout=30,
            )
            self.assertNotEqual(aggregate.returncode, 0)
            self.assertIn(f'shard 1 native Mocha exit was {native.returncode}', aggregate.stderr)

    def test_workflow_preserves_project_directory_and_aggregate_boundaries(self):
        workflow = (ROOT / '.github/workflows/ci-test-server.yml').read_text()
        project_job = workflow.split('  project-directory-test:', 1)[1]

        selection = (
            'npx mocha tests/project-directory.test.ts '
            'tests/project-directory-provider.test.ts '
            'tests/project-directory-websocket.test.ts '
            'tests/cloud-production-entrypoint.test.ts --timeout 10000'
        )
        self.assertIn(selection, project_job)
        self.assertIn('uses: ./.github/actions/setup-test-env', project_job)
        self.assertIn('FIRESTORE_EMULATOR_HOST: 127.0.0.1:58080', project_job)
        self.assertIn('FIREBASE_AUTH_EMULATOR_HOST: 127.0.0.1:59099', project_job)
        self.assertIn('bash scripts/ci/run-server-test-shard.sh', workflow)
        self.assertIn('bash scripts/ci/verify-server-test-job.sh', workflow)
        self.assertIn('"${{ needs.server-test-shard.result }}"', workflow)

    def test_server_wrapper_preserves_exact_baseline_exclusions(self):
        exclude_pattern = re.compile(r'--exclude\s+"([^"]+)"')
        wrapper = (ROOT / 'scripts/run-server-test-command.sh').read_text()
        baseline = (ROOT / 'scripts/tests/fixtures/ci-duration/server-command-baseline.sh').read_text()

        wrapper_excludes = sorted(exclude_pattern.findall(wrapper))
        baseline_excludes = sorted(exclude_pattern.findall(baseline))

        self.assertEqual(len(baseline_excludes), 13)
        self.assertEqual(wrapper_excludes, baseline_excludes)

    def test_actual_mocha_selection_exit_and_local_setup_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'scripts').mkdir();(root/'server/tests').mkdir(parents=True)
            for name in ['run-server-tests.sh','run-server-test-command.sh']:(root/'scripts'/name).write_text((ROOT/'scripts'/name).read_text())
            (root/'scripts/setup.sh').write_text('echo "$SKIP_SERVER_START:$SKIP_PORT_WAIT" >> "$(dirname "$0")/prepared"\n')
            (root/'server/node_modules').symlink_to(ROOT/'server/node_modules',target_is_directory=True)
            (root/'server/package.json').write_text('{"type":"module","scripts":{"test":"bash ../scripts/run-server-tests.sh","test:prepared":"bash ../scripts/run-server-test-command.sh"}}')
            (root/'server/tests/loaders').mkdir();(root/'server/tests/loaders/pin-server-deps.mjs').write_text('export async function resolve(s,c,n){return n(s,c);}')
            # Real Mocha runs two tiny files; TS loader comes from this repo's lock.
            (root/'server/tests/a.test.js').write_text('it("first",()=>{});')
            (root/'server/tests/b.test.js').write_text('it("second",()=>{});')
            (root/'server/tests/metrics.test.ts').write_text('throw new Error("excluded suite ran")')
            result=subprocess.run(['npm','test'],cwd=root/'server',text=True,capture_output=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('2 passing',result.stdout)
            self.assertEqual((root/'scripts/prepared').read_text().splitlines(),['1:1'])
            (root/'server/tests/b.test.js').write_text('it("second",()=>{throw new Error("native failure")});')
            result=subprocess.run(['npm','run','test:prepared'],cwd=root/'server',text=True,capture_output=True,timeout=30)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('1 failing',result.stdout)
            self.assertEqual((root/'scripts/prepared').read_text().splitlines(),['1:1'])
            (root/'server/node_modules').unlink()
            result=subprocess.run(['npm','run','test:prepared'],cwd=root/'server',text=True,capture_output=True,timeout=30)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Server test runtime is not prepared',result.stderr)
            self.assertEqual((root/'scripts/prepared').read_text().splitlines(),['1:1'])

    def test_shards_cover_unsplit_native_inventory_and_propagate_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts/ci').mkdir(parents=True)
            (root / 'server/tests/loaders').mkdir(parents=True)
            for name in ['run-server-test-command.sh']:
                (root / 'scripts' / name).write_text((ROOT / 'scripts' / name).read_text())
            for name in ['run-server-test-shard.sh', 'server-test-reporter.mjs',
                         'verify-server-test-job.sh', 'verify-server-test-shards.mjs']:
                (root / 'scripts/ci' / name).write_text((ROOT / 'scripts/ci' / name).read_text())
            (root / 'server/node_modules').symlink_to(ROOT / 'server/node_modules', target_is_directory=True)
            (root / 'server/package.json').write_text('{"type":"module"}')
            (root / 'server/tests/loaders/pin-server-deps.mjs').write_text('export async function resolve(s,c,n){return n(s,c);}')
            (root / 'server/tests/a.test.js').write_text('it("first",()=>{});')
            (root / 'server/tests/b.test.js').write_text('it("second",()=>{});')
            env = os.environ | {'GITHUB_RUN_ID': '7', 'GITHUB_RUN_ATTEMPT': '2', 'GITHUB_SHA': 'abc'}
            for shard in ['1/2', '2/2']:
                index = shard.split('/')[0]
                result = subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                                        env=env | {'SERVER_TEST_SHARD': shard,
                                                   'SERVER_TEST_RESULT_DIR': f'server-test-results/shard-{index}'}, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            verify = subprocess.run(['bash', 'scripts/ci/verify-server-test-job.sh', 'success',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
            self.assertIn('Verified 2 native tests', verify.stdout)

            for job_result in ['failure', 'cancelled']:
                verify = subprocess.run(['bash', 'scripts/ci/verify-server-test-job.sh', job_result,
                                         'server-test-results', '2'], cwd=root, env=env,
                                        text=True, capture_output=True, timeout=30)
                self.assertNotEqual(verify.returncode, 0)
                self.assertIn(f'Server test shard job did not succeed: {job_result}', verify.stderr)

            outcome_path = root / 'server-test-results/shard-1/outcome.json'
            outcome_path.write_text('null')
            verify = subprocess.run(['bash', 'scripts/ci/verify-server-test-job.sh', 'success',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('shard 1 has invalid outcome evidence', verify.stderr)

            for shard in ['1/2', '2/2']:
                index = shard.split('/')[0]
                result = subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                                        env=env | {'SERVER_TEST_SHARD': shard,
                                                   'SERVER_TEST_RESULT_DIR': f'server-test-results/shard-{index}'}, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            full_path = root / 'server-test-results/shard-1/full.json'
            full_path.write_text('null')
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('shard 1 has invalid unsplit inventory evidence', verify.stderr)

            for shard in ['1/2', '2/2']:
                index = shard.split('/')[0]
                result = subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                                        env=env | {'SERVER_TEST_SHARD': shard,
                                                   'SERVER_TEST_RESULT_DIR': f'server-test-results/shard-{index}'}, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            executed_path = root / 'server-test-results/shard-1/executed.json'
            executed_path.write_text('null')
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('shard 1 has invalid executed test evidence', verify.stderr)

            for shard in ['1/2', '2/2']:
                index = shard.split('/')[0]
                result = subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                                        env=env | {'SERVER_TEST_SHARD': shard,
                                                   'SERVER_TEST_RESULT_DIR': f'server-test-results/shard-{index}'}, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            outcome_path.write_text('{"runId":"stale","runAttempt":"2","commit":"abc","shard":"1/2","status":0}')
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('shard 1 result is stale', verify.stderr)

            for shard in ['1/2', '2/2']:
                index = shard.split('/')[0]
                result = subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                                        env=env | {'SERVER_TEST_SHARD': shard,
                                                   'SERVER_TEST_RESULT_DIR': f'server-test-results/shard-{index}'}, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            for index in ['1', '2']:
                for name in ['full.json', 'executed.json']:
                    result_path = root / f'server-test-results/shard-{index}/{name}'
                    result_path.write_text('{"tests":[]}')
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('shard 1 has no native tests in the unsplit inventory', verify.stderr)
            self.assertIn('shard 2 has no executed native tests', verify.stderr)

            for shard in ['1/2', '2/2']:
                index = shard.split('/')[0]
                result = subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                                        env=env | {'SERVER_TEST_SHARD': shard,
                                                   'SERVER_TEST_RESULT_DIR': f'server-test-results/shard-{index}'}, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            (root / 'server/tests/b.test.js').write_text('it("second",()=>{throw new Error("native failure")});')
            subprocess.run(['bash', 'scripts/ci/run-server-test-shard.sh'], cwd=root,
                           env=env | {'SERVER_TEST_SHARD': '2/2'}, check=True,
                           text=True, capture_output=True, timeout=60)
            verify = subprocess.run(['bash', 'scripts/ci/verify-server-test-job.sh', 'success',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('native Mocha exit was', verify.stderr)

            (root / 'server-test-results/shard-2/outcome.json').unlink()
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertNotEqual(verify.returncode, 0)
            self.assertIn('missing or invalid outcome.json', verify.stderr)



if __name__ == '__main__':
    unittest.main()
