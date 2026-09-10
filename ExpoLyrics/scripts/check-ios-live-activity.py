"""Regression tests for IPA integrity checks; fixtures are synthetic, not builds."""
import contextlib
import importlib.util
import io
import plistlib
import struct
import shutil
import sys
import unittest
import uuid
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('ipa_check', Path(__file__).with_name('verify-ios-live-activity.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class IpaChecks(unittest.TestCase):
    def setUp(self):
        self.host_path = 'Payload/KineSync.app'
        self.widget_path = self.host_path + '/PlugIns/KineSyncLyricsWidget.appex'
        self.host = {'CFBundleIdentifier': 'dev.kineticron.KineSync', 'CFBundleExecutable': 'KineSync',
                     'CFBundleShortVersionString': '1.0.7', 'CFBundleVersion': '123', 'NSSupportsLiveActivities': True}
        self.widget = {**self.host, 'CFBundleIdentifier': 'dev.kineticron.KineSync.KineSyncLyricsWidget',
                       'CFBundleExecutable': 'KineSyncLyricsWidget', 'CFBundlePackageType': 'XPC!',
                       'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.widgetkit-extension'}}
        self.binary = struct.pack('<8I', 0xFEEDFACF, check.ARM64, 0, 2, 1, 24, 0, 0) + struct.pack('<6I', 0x32, 24, 2, 0, 0, 0)

    def archive(self, *, missing_widget=False, cpu=None):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr(self.host_path + '/Info.plist', plistlib.dumps(self.host, fmt=plistlib.FMT_BINARY))
            archive.writestr(self.host_path + '/KineSync', self.binary + b'KineSyncLiveActivity')
            if not missing_widget:
                archive.writestr(self.widget_path + '/Info.plist', plistlib.dumps(self.widget))
                binary = self.binary if cpu is None else struct.pack('<8I', 0xFEEDFACF, cpu, 0, 2, 0, 0, 0, 0)
                archive.writestr(self.widget_path + '/KineSyncLyricsWidget', binary + b'LyricsActivityAttributes')
        return data.getvalue()

    def verify(self, **options):
        root = Path(__file__).resolve().parents[1] / '.expo'
        directory = root / ('ipa-check-' + uuid.uuid4().hex)
        directory.mkdir(parents=True)
        try:
            ipa = directory / 'test.ipa'
            ipa.write_bytes(self.archive(**options))
            with contextlib.redirect_stdout(io.StringIO()):
                check.verify(ipa)
        finally:
            assert directory.resolve().parent == root.resolve() and directory.name.startswith('ipa-check-')
            shutil.rmtree(directory)

    def test_intact_archive_with_binary_and_xml_plists(self):
        self.verify()

    def test_signer_removed_plugins(self):
        with self.assertRaisesRegex(ValueError, 'missing from PlugIns'):
            self.verify(missing_widget=True)

    def test_missing_host_flag(self):
        self.host.pop('NSSupportsLiveActivities')
        with self.assertRaisesRegex(ValueError, 'does not enable'):
            self.verify()

    def test_mismatched_extension_version(self):
        self.widget['CFBundleVersion'] = '1'
        with self.assertRaisesRegex(ValueError, 'CFBundleVersion mismatch'):
            self.verify()

    def test_signer_changed_only_host_bundle_id(self):
        self.host['CFBundleIdentifier'] = 'resigned.KineSync'
        with self.assertRaisesRegex(ValueError, 'bundle ID relationship'):
            self.verify()

    def test_simulator_binary_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'arm64 device executable'):
            self.verify(cpu=0x01000007)

    def test_arm64_simulator_is_rejected(self):
        self.binary = self.binary[:40] + struct.pack('<I', 7) + self.binary[44:]
        with self.assertRaisesRegex(ValueError, 'arm64 device executable'):
            self.verify()

    def test_native_code_was_stripped(self):
        self.binary = b'\x00' * 32
        with self.assertRaisesRegex(ValueError, 'arm64 device executable'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
