"""Traverse service-file emission and the actual production upload selectors."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest
import zipfile

import test_bounded_e2e_startup_workflow as startup_workflow

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / 'scripts/tests/helpers/startup-artifact-selection.mjs'
CLI = ROOT / 'client/node_modules/@playwright/test/cli.js'


class StartupArtifactTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.production = json.loads(subprocess.check_output(['node', str(SELECTOR)], text=True))

    def check_artifacts(self, root, env, sentinel, expected):
        # Prove the service file really contains the sentinel at the PM2 route.
        service_log = root / self.production['serviceLog']
        self.assertEqual(service_log.read_text(), sentinel)
        self.assertEqual((root / 'firebase-debug.log').read_text(), sentinel)
        follower_output = root / 'follower-output'
        follower_env = {**env, 'GITHUB_OUTPUT': str(follower_output)}
        follower = subprocess.run(['bash', '-euo', 'pipefail', '-c', self.production['follower']],
                                  cwd=root, env=follower_env, capture_output=True, text=True, timeout=5)
        self.assertEqual(follower.returncode, 1 if expected else 0, follower.stderr)
        entered = follower_output.exists() and 'startup_verified=true' in follower_output.read_text()
        self.assertEqual(entered, expected == 0)
        if entered:
            # Genuine Playwright assertion failure + attachment. No browser or
            # application is mocked; the probe does not request a browser fixture.
            module = (CLI.parent / 'index.mjs').as_uri()
            (root / 'playwright.config.mjs').write_text("export default {testDir:'.',workers:1,retries:0,"
                "outputDir:'client/test-results',reporter:[['json',{outputFile:'client/playwright-report/report.json'}]]};")
            (root / 'probe.spec.mjs').write_text(f"""import {{test,expect}} from {json.dumps(module)};
import {{writeFileSync}} from 'node:fs';
test('ordinary E2E diagnostics', async ({{}}, info) => {{
 const attachment = info.outputPath('ordinary.txt');
 writeFileSync(attachment, 'ORDINARY_ATTACHMENT');
 await info.attach('failure-evidence', {{path:attachment, contentType:'text/plain'}});
 expect(1).toBe(2);
}});""")
            playwright = subprocess.run(['node', str(CLI), 'test'], cwd=root, env=env,
                                        capture_output=True, text=True, timeout=15)
            self.assertEqual(playwright.returncode, 1, playwright.stdout + playwright.stderr)
            report = json.loads((root / 'client/playwright-report/report.json').read_text())
            self.assertEqual(report['stats']['unexpected'], 1)
            self.assertEqual(report['stats']['skipped'], 0)
            attachment = Path(report['suites'][0]['specs'][0]['tests'][0]['results'][0]['attachments'][0]['path'])
            self.assertEqual(attachment.read_text(), 'ORDINARY_ATTACHMENT')
            for name in ('client/logs/ordinary.log', 'server/logs/ordinary.log', 'job_logs/ordinary.log'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('ORDINARY_DIAGNOSTIC')
        verify_output = root / 'verify-output'
        verify = subprocess.run(['bash', '-euo', 'pipefail', '-c', self.production['verify']], cwd=root,
                                env={**env, 'GITHUB_OUTPUT': str(verify_output)},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        snapshot = Path(verify_output.read_text().strip().removeprefix('upload_path='))
        self.addCleanup(shutil.rmtree, snapshot)
        state = dict(failure=True, project=env['E2E_PROJECT'], steps={
            'tests': {'outputs': {'startup_verified': 'true' if entered else ''}},
            'startup_evidence': {'outputs': {'upload_path': str(snapshot)}},
        })
        state_file = root / 'selection.json'
        state_file.write_text(json.dumps(state))
        selected = json.loads(subprocess.check_output(['node', str(SELECTOR), str(state_file)], text=True))
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]['name'], 'Upload Logs & Artifacts' if entered else 'Upload safe startup diagnostics')
        # These production selectors contain literal files/directories, no glob
        # patterns. Recursively package exactly the selected inputs for inspection.
        files = []
        for entry in selected[0]['paths']:
            self.assertNotIn('*', entry)
            path = Path(entry) if Path(entry).is_absolute() else root / entry
            files.extend(path.rglob('*') if path.is_dir() else [path])
        files = [path for path in files if path.is_file()]
        self.assertTrue(files)
        with zipfile.ZipFile(root / 'selected.zip', 'w') as archive:
            for index, path in enumerate(files):
                archive.write(path, str(index) + '/' + path.name)
        with zipfile.ZipFile(root / 'selected.zip') as archive:
            retained = b'\n'.join(archive.read(name) for name in archive.namelist())
        if not entered:
            self.assertNotIn(sentinel.encode(), retained)
            self.assertNotIn(service_log, files)
            self.assertNotIn(root / 'firebase-debug.log', files)
            status = json.loads(next(path for path in files if path.name.endswith('-status.json')).read_text())
            self.assertEqual(status['status'], 'timed_out')
            self.assertEqual(status['phase'], 'pre_readiness')
            self.assertEqual(status['attempt'], 1)
            self.assertGreaterEqual(status['elapsed_seconds'], 2)
            self.assertEqual(status['remaining_processes'], [])
            self.assertEqual(len(files), 3)
        else:
            # Full ordinary inputs and original service logs remain available
            # after verified E2E entry, including genuine failure attachments.
            self.assertEqual(set(selected[0]['paths']), {'job_logs/', 'client/test-results/',
                'client/playwright-report/', 'client/logs/', 'server/logs/', 'logs/', 'firebase-debug.log'})
            self.assertIn(service_log, files)
            self.assertIn(root / 'firebase-debug.log', files)
            self.assertIn(b'ORDINARY_DIAGNOSTIC', retained)
            self.assertIn(b'ORDINARY_ATTACHMENT', retained)
            self.assertIn(attachment, files)
            self.assertTrue(any('test-results' in path.parts for path in files))

    def test_failed_startup_service_file_secret_is_excluded_from_real_selection(self):
        startup_workflow.StartupWorkflowTest().run_case('pre', artifact_check=self.check_artifacts)

    def test_real_e2e_failure_keeps_ordinary_service_logs_reports_and_attachments(self):
        startup_workflow.StartupWorkflowTest().run_case('success', artifact_check=self.check_artifacts)


if __name__ == '__main__':
    unittest.main()
