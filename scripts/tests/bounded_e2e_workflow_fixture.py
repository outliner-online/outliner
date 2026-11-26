"""Isolated data for the shipped Bash/npm/Playwright execution boundary."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/ci-test-e2e.yml'


def workflow_job():
    return yaml.safe_load(WORKFLOW.read_text())['jobs']['e2e-test']


def prepare(root, interrupt):
    client = root / 'client'
    client.mkdir()
    logs = root / 'job_logs'
    logs.mkdir()
    (root / 'scripts').symlink_to(ROOT / 'scripts')
    (client / 'node_modules').symlink_to(ROOT / 'client/node_modules')
    # Copy the real npm entry, including dotenvx and the inner login shell.
    shutil.copyfile(ROOT / 'client/package.json', client / 'package.json')
    (client / '.env.test').write_text('')
    context = {'startedAt': datetime.now(timezone.utc).isoformat(), 'runId': 'fixture',
               'runAttempt': '1', 'commit': 'fixture-sha', 'ciShard': 'new-3b',
               'project': 'new-3b', 'executionId': 'fixture-1'}
    (logs / 'execution-context.json').write_text(json.dumps(context))
    startup = {'status': 'passed', 'command_started': True, 'child_exit_code': 0,
               'shard': 'new-3b', 'execution_id': 'fixture-1', 'nonce': 'fixture',
               'phase': 'completion', 'attempt': 1, 'elapsed_seconds': 0,
               'updated_at': datetime.now(timezone.utc).isoformat(), 'exit_code': 0,
               'startup_completed': True, 'remaining_processes': []}
    for name in ('new-3b-startup-status.json', 'setup-services-new-3b.log'):
        (logs / name).write_text(json.dumps(startup))
    (logs / 'new-3b-startup-completed.json').write_text(json.dumps({
        'status': 'completed', 'shard': 'new-3b', 'execution_id': 'fixture-1', 'nonce': 'fixture',
    }))
    (client / 'playwright.config.mjs').write_text(
        "export default {testDir:'.',retries:0,workers:1,timeout:30000,projects:[{name:'new-3b'}]};")
    module = (ROOT / 'client/node_modules/@playwright/test/index.mjs').as_uri()
    (client / 'probe.spec.mjs').write_text(f"""
import {{ test, expect }} from {json.dumps(module)};
import {{ writeFileSync }} from 'node:fs';
import {{ spawn }} from 'node:child_process';
test('workflow cancellation probe', async () => {{
    if (process.env.PROBE_INTERRUPT === '1') {{
        const child = spawn(process.execPath, ['-e',
            "process.on('SIGTERM',()=>{{}});process.on('SIGINT',()=>{{}});" +
            "process.send('ready');setInterval(()=>{{}},1000);"],
            {{ detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }});
        await new Promise(resolve => child.once('message', resolve));
        writeFileSync('owned.json', JSON.stringify([process.pid, child.pid]));
        console.log('NATIVE_TEST_READY');
        await new Promise(() => {{}});
    }}
    expect(1).toBe(1);
}});
""")
    tests = next(step for step in workflow_job()['steps'] if step.get('id') == 'tests')
    # Keep the complete production control flow and startup verifier unchanged.
    (root / 'step.sh').write_text(tests['run'].replace('${{ matrix.project }}', 'new-3b'))
    return {**os.environ, 'CI': 'true', 'PROBE_INTERRUPT': '1' if interrupt else '0',
            'E2E_BROWSER': 'chromium', 'E2E_PROJECT': 'new-3b', 'E2E_EXECUTION_ID': 'fixture-1',
            'GITHUB_OUTPUT': str(root / 'outputs'), 'PLAYWRIGHT_HTML_OPEN': 'never',
            'PLAYWRIGHT_JSON_OUTPUT_NAME': '../job_logs/report.json',
            'PLAYWRIGHT_HTML_OUTPUT_DIR': '../job_logs/html-report'}
