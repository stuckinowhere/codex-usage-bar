"""Regression checks for the approved local-signing scope."""
from pathlib import Path
import sys
import plistlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from signing import local_entitlements,assert_local_entitlements,RESTRICTED_VENDOR_KEYS,LIBRARY_LOADING_KEY
import signing

class SigningPolicyTests(unittest.TestCase):
    def test_vendor_claims_removed_runtime_and_supported_caps_preserved(self):
        value={key:'synthetic-vendor-claim' for key in RESTRICTED_VENDOR_KEYS}
        value.update({'com.apple.security.cs.allow-jit':True,'com.apple.security.cs.allow-unsigned-executable-memory':True,'com.apple.security.network.client':True})
        result=local_entitlements(value)
        self.assertFalse(set(result)&RESTRICTED_VENDOR_KEYS)
        self.assertTrue(all(result[key] is True for key in result))
        self.assertIn('com.apple.application-identifier',value)
    def test_loading_exception_requires_explicit_verified_host(self):
        with self.assertRaises(ValueError):local_entitlements({},allow_library_loading=True)
        self.assertEqual(local_entitlements({}),{})
        self.assertEqual(local_entitlements({},allow_library_loading=True,verified_executable_host=True),{LIBRARY_LOADING_KEY:True})
    def test_unknown_vendor_claim_fails_closed(self):
        with self.assertRaises(ValueError):assert_local_entitlements({'com.apple.developer.unexpected':True})
    def test_boolean_scope_cannot_be_accidentally_enabled(self):
        with self.assertRaises(ValueError):local_entitlements({},allow_library_loading='false')
    def test_metadata_decodes_der_entitlements_as_xml(self):
        capabilities={'com.apple.security.cs.allow-jit':True}
        responses=[SimpleNamespace(stdout=plistlib.dumps(capabilities),stderr=b''),
                   SimpleNamespace(stderr='flags=0x10000(runtime)\nTeamIdentifier=synthetic\n')]
        with patch.object(signing.subprocess,'run',side_effect=responses) as run:
            self.assertEqual(signing.metadata(Path('fixture.app'))['entitlements'],capabilities)
            self.assertEqual(run.call_args_list[0].args[0][2:5],['--entitlements','-','--xml'])
    def test_invalid_entitlements_are_rejected_instead_of_treated_as_empty(self):
        with patch.object(signing.subprocess,'run',return_value=SimpleNamespace(
                stdout=b'',stderr=b'warning: binary contains an invalid entitlements blob.')) as run:
            with self.assertRaisesRegex(ValueError,'Cannot decode'):
                signing.metadata(Path('fixture.app'))
            self.assertEqual(run.call_count,1)
    def test_signing_refuses_metadata_cleanup_outside_staged_candidate(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(signing.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'restricted to the staged candidate'):
                signing.sign(Path(directory))
            run.assert_not_called()
    def test_copy_cleanup_is_scoped_and_preserves_other_attributes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);app=root/'copy.app';app.mkdir()
            with patch.object(signing,'ROOT',root), patch.object(signing.subprocess,'run') as run:
                signing.clean_copy_metadata(app)
                self.assertEqual([call.args[0][4] for call in run.call_args_list],
                                 ['com.apple.FinderInfo','com.apple.ResourceFork'])
                self.assertTrue(all('-s' in call.args[0] for call in run.call_args_list))
            with patch.object(signing.subprocess,'run') as run:
                with self.assertRaisesRegex(ValueError,'restricted to local app copies'):
                    signing.clean_copy_metadata(app)
                run.assert_not_called()
    def test_signing_preserves_process_caps_on_apps_and_omits_library_claims(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();app=root/'New Build/ChatGPT.app'
            framework=app/signing.FRAMEWORK
            binary=framework/'Versions/Current/Codex Framework'
            binary.parent.mkdir(parents=True);binary.touch()
            capabilities={'com.apple.security.cs.allow-jit':True}
            with patch.object(signing,'ROOT',root), \
                 patch.object(signing,'targets',return_value=[framework,app]), \
                 patch.object(signing,'metadata',return_value={'entitlements':capabilities}), \
                 patch.object(signing,'executable',return_value=app/'ChatGPT'), \
                 patch.object(signing,'verified_loader',side_effect=ValueError('fixture non-loader')), \
                 patch.object(signing.subprocess,'run'), \
                 patch.object(signing,'verify',side_effect=lambda app,expected:expected):
                expected=signing.sign(app)
                self.assertEqual(expected[str(signing.FRAMEWORK)],{})
                self.assertEqual(expected['.'],capabilities)

unittest.main(verbosity=2)
