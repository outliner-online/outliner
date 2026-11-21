"""Run only tiny real Mocha fixtures to verify prepared CI/local runner parity."""

from pathlib import Path
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



if __name__ == '__main__':
    unittest.main()
