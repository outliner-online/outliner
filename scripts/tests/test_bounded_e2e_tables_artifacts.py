"""Evaluate the shipped artifact selectors for tables cancellation outcomes."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / 'scripts/tests/helpers/startup-artifact-selection.mjs'


class TablesArtifactTest(unittest.TestCase):
    def selection(self, project, verified, failure=False, cancelled=False):
        with tempfile.TemporaryDirectory(prefix='tables-artifact-') as directory:
            state_file = Path(directory) / 'selection.json'
            state_file.write_text(json.dumps({
                'project': project, 'failure': failure, 'cancelled': cancelled,
                'steps': {
                    'tests': {'outputs': {'startup_verified': 'true' if verified else ''}},
                    'startup_evidence': {'outputs': {'upload_path': '/safe-startup-snapshot'}},
                },
            }))
            return json.loads(subprocess.check_output(['node', str(SELECTOR), str(state_file)], text=True))

    def test_both_tables_shards_keep_post_entry_evidence_on_success_failure_and_cancellation(self):
        for project in ('tables-1', 'tables-2'):
            for failure, cancelled in ((False, False), (True, False), (False, True)):
                with self.subTest(project=project, failure=failure, cancelled=cancelled):
                    selected = self.selection(project, True, failure, cancelled)
                    self.assertEqual(selected, [{
                        'name': 'Upload Logs & Artifacts',
                        'paths': ['job_logs/', 'client/test-results/', 'client/playwright-report/'],
                    }])

    def test_cancellation_before_verified_entry_keeps_only_safe_startup_diagnostics(self):
        selected = self.selection('tables-2', False, cancelled=True)
        self.assertEqual(selected, [{
            'name': 'Upload safe startup diagnostics',
            'paths': ['/safe-startup-snapshot'],
        }])


if __name__ == '__main__':
    unittest.main()
