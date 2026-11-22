"""Run only tiny real Mocha fixtures to verify prepared CI/local runner parity."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ServerExecutionBoundaryTest(unittest.TestCase):
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
            for name in ['run-server-test-shard.sh', 'server-test-reporter.mjs', 'verify-server-test-shards.mjs']:
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
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
                                     'server-test-results', '2'], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
            self.assertIn('Verified 2 native tests', verify.stdout)

            outcome_path = root / 'server-test-results/shard-1/outcome.json'
            outcome_path.write_text('null')
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
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
            verify = subprocess.run(['node', 'scripts/ci/verify-server-test-shards.mjs',
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
