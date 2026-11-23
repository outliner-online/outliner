"""Fixed-category diagnostics only; no live APT or privileged acquisition."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from test_ubuntu_mirror_candidate import SOURCES

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/ci'))
spec = importlib.util.spec_from_file_location('diagnostics', ROOT / 'scripts/ci/ubuntu_mirror_download.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class SourceSummary(unittest.TestCase):
    def test_known_old_and_new_suite_shapes_are_diagnostic_only(self):
        summary = m.source_shape_summary(SOURCES)
        self.assertEqual(summary, {'paragraphs': [
            {'components': 'ubuntu-four', 'enabled': 'default', 'signed_by': 'ubuntu-archive-keyring', 'suites': 'archive-three', 'types': 'deb', 'uri': 'image-mirrorlist'},
            {'components': 'ubuntu-four', 'enabled': 'default', 'signed_by': 'ubuntu-archive-keyring', 'suites': 'security-only', 'types': 'deb', 'uri': 'security-http'}], 'unknown_count': 0})
        combined = SOURCES.split('\n\n')[0].replace('resolute-backports', 'resolute-backports resolute-security')
        self.assertEqual(m.source_shape_summary(combined)['paragraphs'], [
            {'suites': 'archive-and-security', 'uri': 'image-mirrorlist'}])
        from test_ubuntu_mirror_candidate import MIRRORS, FAILED
        with self.assertRaisesRegex(ValueError, '^unsupported-suite-source-layout$'):
            m.fallback_plan(combined, MIRRORS, FAILED, 100, 200000, 'a' * 32, 'transport-error')
    def test_fixed_public_uri_enums_and_unknown_shapes(self):
        for uri, expected in (
            ('https://security.ubuntu.com/ubuntu', 'security-https'),
            ('http://us-east-2.ec2.archive.ubuntu.com/ubuntu/', 'ec2-http'),
            ('https://archive.ubuntu.com/ubuntu/', 'archive-https'),
            ('http://security.ubuntu.com:80/ubuntu', 'other'),
            ('http://secret@security.ubuntu.com/ubuntu', 'other')):
            with self.subTest(uri=uri):
                row = m.source_shape_summary('Suites: resolute-security\nURIs: ' + uri)['paragraphs'][0]
                self.assertEqual(row['uri'], expected)
    def test_unknown_data_and_credentials_never_reach_output(self):
        secret = 'DO-NOT-LEAK-123'
        raw = 'Suites: ' + secret + '\nURIs: https://user:' + secret + '@unknown.invalid/private?token=' + secret
        result = m.source_shape_summary(raw)
        self.assertEqual(result, {'paragraphs': [{'components': 'other', 'enabled': 'default', 'signed_by': 'other', 'suites': 'other', 'types': 'other', 'uri': 'other'}], 'unknown_count': 1})
        serialized = json.dumps(result)
        for forbidden in (secret, 'unknown.invalid', 'https:', 'token', 'user:', '/private'):
            self.assertNotIn(forbidden, serialized)
    def test_malformed_fields_are_other_and_output_is_capped(self):
        raw = '\n\n'.join(['Suites: resolute-security\nURIs: http://security.ubuntu.com/ubuntu'] * 5)
        result = m.source_shape_summary(raw)
        self.assertEqual(len(result['paragraphs']), 5)
        self.assertEqual(result['unknown_count'], 0)
        self.assertEqual(m.source_shape_summary(' Suites: injected-secret')['paragraphs'], [{'components': 'other', 'enabled': 'default', 'signed_by': 'other', 'suites': 'other', 'types': 'other', 'uri': 'other'}])

    def test_actual_profile_output_does_not_expose_unknown_uri(self):
        from test_ubuntu_mirror_candidate import MIRRORS
        secret = 'DO-NOT-LEAK-123'
        with tempfile.TemporaryDirectory() as directory:
            etc = Path(directory)
            (etc / 'sources.list.d').mkdir()
            (etc / 'sources.list.d/ubuntu.sources').write_text(SOURCES.replace('http://security.ubuntu.com/ubuntu/', 'https://user:' + secret + '@unknown.invalid/private?token=' + secret))
            (etc / 'apt-mirrors.txt').write_text(MIRRORS)
            output = io.StringIO()
            with contextlib.redirect_stdout(output), patch.object(m, 'required', side_effect=AssertionError('must not acquire')):
                result = m.main('chromium', 0, etc)
            self.assertEqual(result, 78)
            self.assertIn('source-shape=', output.getvalue())
            self.assertIn('unsupported-suite-source-layout', output.getvalue())
            for forbidden in (secret, 'unknown.invalid', 'user:', '/private', directory):
                self.assertNotIn(forbidden, output.getvalue())

class Guards(unittest.TestCase):
    def exercise(self, uid, remaining):
        output = io.StringIO()
        # Replace only the preceding filesystem/profile and following effective
        # probe: tests exercise the actual main guard and prohibit acquisition.
        with contextlib.redirect_stdout(output), patch.object(m, 'profile', return_value=('', '', {})), patch.object(m.os, 'geteuid', return_value=uid), patch.object(m.time, 'monotonic_ns', return_value=1000000000000), patch.object(m, 'effective_sources_supported', return_value=False) as effective, patch.object(m, 'required', side_effect=AssertionError('must not acquire')):
            result = m.main('chromium', 1000000 + remaining)
        return result, output.getvalue(), effective.call_count
    def test_root_reason_and_original_short_circuit(self):
        for remaining in (-1, 0, 595001, 1):
            self.assertEqual(self.exercise(1000, remaining), (64, 'APT-MIRROR guard=refused reason=requires-root\n', 0))
    def test_deadline_failure_reasons_preserve_original_bounds(self):
        for remaining in (-1, 0):
            self.assertEqual(self.exercise(0, remaining), (64, 'APT-MIRROR guard=refused reason=deadline-expired\n', 0))
        self.assertEqual(self.exercise(0, 595001), (64, 'APT-MIRROR guard=refused reason=deadline-out-of-range\n', 0))
    def test_exact_valid_edges_continue_to_existing_probe(self):
        for remaining in (1, 595000):
            result, output, count = self.exercise(0, remaining)
            self.assertEqual(result, 78)
            self.assertEqual(count, 1)
            self.assertNotIn('guard=refused', output)
