"""Exercise the real Playwright CLI, reporter and attachments without an app mock."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'scripts/ci/run-bounded-e2e.py'
CLI = ROOT / 'client/node_modules/@playwright/test/cli.js'
MODULE = (CLI.parent / 'index.mjs').as_uri()


class PlaywrightBoundaryTest(unittest.TestCase):
    def run_probe(self, mode, tables_shard=False, new3_half=None, new2_shard=None):
        with tempfile.TemporaryDirectory(prefix='bounded-playwright-') as directory:
            root = Path(directory)
            (root / 'context.json').write_text(json.dumps({'startedAt': datetime.now(timezone.utc).isoformat()}))
            projects = "projects:[{name:'tables'}]," if tables_shard else ''
            if new3_half:
                projects = "projects:[{name:'new-3a'},{name:'new-3b'}],"
            if new2_shard:
                projects = "projects:[{name:'new-2'}],"
            (root / 'playwright.config.mjs').write_text("export default {testDir:'.',retries:0,workers:1,"
                                                       + projects + "reporter:[['json',{outputFile:'report.json'}]]};")
            action = "process.exit(0)" if mode == 'incomplete' else "await new Promise(() => {})" if mode == 'timeout' else (
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
            cli_arguments = []
            if tables_shard:
                # Extract the shipped tables-1 branch, preserving its real CLI
                # selection. Only redirect paths/budgets into this fixture and
                # replace the npm entry with the installed real Playwright CLI.
                workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
                branch = workflow.split('elif [ "$project" = "tables-1" ]; then')[1].split('elif [[')[0]
                tokens = shlex.split(branch.replace('\\\n', ' '))
                self.assertEqual(tokens[:2], ['python3', '../scripts/ci/run-bounded-e2e.py'])
                prefix, command = tokens[2:tokens.index('--')], tokens[tokens.index('--') + 1:]
                self.assertEqual(command[:4], ['npm', 'run', 'github:test:e2e', '--'])
                cli_arguments = command[4:]
                self.assertEqual(cli_arguments, ['--project=tables', '--shard=1/2'])
                self.assertIn('--timeout-seconds=1200', prefix)
                self.assertIn('--job-budget-seconds=1320', prefix)
                (root / 'zzz-other.spec.mjs').write_text(f"""
                    import {{test}} from {json.dumps(MODULE)};
                    test('must remain on shard two', () => {{throw new Error('wrong shard executed')}});
                """)
            if new3_half:
                workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
                branch = workflow.split('elif [[ "$project" =~ ^new-3[ab]$ ]]; then')[1].split('elif ')[0]
                command = branch.split('-- npm run github:test:e2e -- ', 1)[1].strip()
                cli_arguments = shlex.split(command.replace('"$project"', new3_half))
            if new2_shard:
                workflow = (ROOT / '.github/workflows/ci-test-e2e.yml').read_text()
                branch = workflow.split('if [[ "$project" =~ ^new-2-([12])$ ]]; then')[1].split('elif ')[0]
                command = branch.split('-- npm run github:test:e2e -- ', 1)[1].strip()
                cli_arguments = shlex.split(command.replace('"$shard"', new2_shard))
                self.assertEqual(cli_arguments, ['--project=new-2', '--shard=' + new2_shard,
                                                 '--reporter=line,list,json,html'])
                other = 'zzz-other.spec.mjs' if new2_shard == '1/2' else 'aaa-other.spec.mjs'
                (root / other).write_text(f"""
                    import {{test}} from {json.dumps(MODULE)};
                    test('must remain on the other native shard', () => {{throw new Error('wrong shard executed')}});
                """)
            result = subprocess.run([
                sys.executable, str(RUNNER), '--context', str(root / 'context.json'),
                '--status', str(root / 'status.json'), '--log', str(root / 'command.log'),
                '--report', str(root / 'report.json'), '--timeout-seconds', '8',
                '--job-budget-seconds', '60', '--grace-seconds', '0.2',
                '--', 'node', str(CLI), 'test', '--config', str(root / 'playwright.config.mjs'),
                '--output', str(root / 'results'), *cli_arguments,
            ], cwd=root, capture_output=True, text=True, timeout=20, env={
                **os.environ, 'PLAYWRIGHT_JSON_OUTPUT_NAME': str(root / 'report.json'),
                'PLAYWRIGHT_HTML_OPEN': 'never',
            })
            status = json.loads((root / 'status.json').read_text())
            self.assertEqual(result.returncode, {'pass': 0, 'failure': 1, 'incomplete': 1, 'timeout': 124}[mode], result.stderr)
            self.assertEqual(status['status'], {'pass': 'passed', 'failure': 'failed',
                                                'incomplete': 'failed', 'timeout': 'timed_out'}[mode])
            self.assertEqual(status['remaining_processes'], [])
            self.assertIn('DIAGNOSTIC_READY', (root / 'command.log').read_text())
            attachments = list((root / 'results').rglob('*.json'))
            self.assertTrue(any(json.loads(path.read_text()) == {'observed': 'before termination'}
                                for path in attachments))
            if mode != 'timeout':
                report = json.loads((root / 'report.json').read_text())
                self.assertEqual(len(report['suites']), 1)
                self.assertEqual(report['stats']['skipped'], 0)
                attempt = report['suites'][0]['specs'][0]['tests'][0]['results'][0]
                self.assertEqual(attempt['status'], 'passed' if mode == 'pass' else 'failed')
                self.assertTrue(Path(attempt['attachments'][0]['path']).is_file())

    def test_real_playwright_pass(self):
        self.run_probe('pass')

    def test_new3_shipped_half_commands_and_reporters(self):
        for half in ('new-3a', 'new-3b'):
            with self.subTest(half=half):
                self.run_probe('pass', new3_half=half)

    def test_new2_shipped_native_shards_and_reporters(self):
        for shard in ('1/2', '2/2'):
            with self.subTest(shard=shard):
                self.run_probe('pass', new2_shard=shard)

    def test_new2_shipped_command_failure_is_nonzero(self):
        self.run_probe('failure', new2_shard='2/2')

    def test_new2_shipped_command_timeout_retains_diagnostics(self):
        self.run_probe('timeout', new2_shard='1/2')

    def test_new2_shipped_command_incomplete_report_cannot_pass(self):
        self.run_probe('incomplete', new2_shard='2/2')

    def test_new3_shipped_command_failure_is_nonzero(self):
        self.run_probe('failure', new3_half='new-3b')

    def test_new3_shipped_command_timeout_retains_diagnostics(self):
        self.run_probe('timeout', new3_half='new-3a')

    def test_new3_shipped_command_incomplete_report_cannot_pass(self):
        self.run_probe('incomplete', new3_half='new-3b')

    def test_real_playwright_assertion_failure_is_not_converted(self):
        self.run_probe('failure')

    def test_real_playwright_timeout_retains_attachment_and_cleans_up(self):
        self.run_probe('timeout')

    def test_tables_shard_pass_retains_report_and_attachment(self):
        self.run_probe('pass', tables_shard=True)

    def test_tables_shard_failure_is_nonzero(self):
        self.run_probe('failure', tables_shard=True)

    def test_tables_shard_timeout_is_nonzero_and_retains_diagnostics(self):
        self.run_probe('timeout', tables_shard=True)

    def test_tables_shard_premature_worker_exit_cannot_pass(self):
        self.run_probe('incomplete', tables_shard=True)


if __name__ == '__main__':
    unittest.main()
