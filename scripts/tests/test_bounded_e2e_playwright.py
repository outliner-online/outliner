"""Exercise the real Playwright CLI, reporter and attachments without an app mock."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'scripts/ci/run-bounded-e2e.py'
CLI = ROOT / 'client/node_modules/@playwright/test/cli.js'
MODULE = (CLI.parent / 'index.mjs').as_uri()


class PlaywrightBoundaryTest(unittest.TestCase):
    def run_probe(self, mode):
        with tempfile.TemporaryDirectory(prefix='bounded-playwright-') as directory:
            root = Path(directory)
            (root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))
            (root / 'playwright.config.mjs').write_text("export default {testDir:'.',retries:0,workers:1,"
                                                       "reporter:[['json',{outputFile:'report.json'}]]};")
            action = "await new Promise(() => {})" if mode == 'timeout' else (
                "expect(1).toBe(2)" if mode == 'failure' else "expect(1).toBe(1)")
            (root / 'probe.spec.mjs').write_text(f"""
                import {{test,expect}} from {json.dumps(MODULE)};
                import {{writeFileSync}} from 'node:fs';
                test('diagnostic boundary', async ({{}}, info) => {{
                    const path=info.outputPath('probe.json');
                    writeFileSync(path, '{{"observed":"before termination"}}');
                    await info.attach('probe', {{path,contentType:'application/json'}});
                    console.log('DIAGNOSTIC_READY');
                    {action};
                }});
            """)
            result = subprocess.run([
                sys.executable, str(RUNNER), '--context', str(root / 'context.json'),
                '--status', str(root / 'status.json'), '--log', str(root / 'command.log'),
                '--report', str(root / 'report.json'), '--timeout-seconds', '8',
                '--job-budget-seconds', '60', '--grace-seconds', '0.2',
                '--', 'node', str(CLI), 'test', '--config', str(root / 'playwright.config.mjs'),
                '--output', str(root / 'results'),
            ], cwd=root, capture_output=True, text=True, timeout=20)
            status = json.loads((root / 'status.json').read_text())
            self.assertEqual(result.returncode, {'pass': 0, 'failure': 1, 'timeout': 124}[mode], result.stderr)
            self.assertEqual(status['status'], {'pass': 'passed', 'failure': 'failed', 'timeout': 'timed_out'}[mode])
            self.assertEqual(status['remaining_processes'], [])
            self.assertIn('DIAGNOSTIC_READY', (root / 'command.log').read_text())
            attachments = list((root / 'results').rglob('*.json'))
            self.assertTrue(any(json.loads(path.read_text()) == {'observed': 'before termination'}
                                for path in attachments))
            if mode != 'timeout':
                report = json.loads((root / 'report.json').read_text())
                attempt = report['suites'][0]['specs'][0]['tests'][0]['results'][0]
                self.assertEqual(attempt['status'], 'passed' if mode == 'pass' else 'failed')
                self.assertTrue(Path(attempt['attachments'][0]['path']).is_file())

    def test_real_playwright_pass(self):
        self.run_probe('pass')

    def test_real_playwright_assertion_failure_is_not_converted(self):
        self.run_probe('failure')

    def test_real_playwright_timeout_retains_attachment_and_cleans_up(self):
        self.run_probe('timeout')


if __name__ == '__main__':
    unittest.main()
