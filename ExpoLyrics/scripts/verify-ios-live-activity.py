"""Fail closed if an IPA lost its native lyrics module or WidgetKit extension.

Works with XML/binary plists and thin/fat device binaries. Also usable on an IPA
exported by a signer to detect removal of PlugIns before device installation.
"""
import argparse
import hashlib
import plistlib
import struct
import zipfile
from pathlib import Path

TARGET = 'KineSyncLyricsWidget'
ARM64 = 0x0100000C


def require(condition, message):
    if not condition:
        raise ValueError(message)


def has_arm64(data):
    if len(data) < 32:
        return False
    if data[:4] == b'\xcf\xfa\xed\xfe':
        if struct.unpack_from('<I', data, 4)[0] != ARM64 or struct.unpack_from('<I', data, 12)[0] != 2:
            return False
        count, size = struct.unpack_from('<II', data, 16)
        if count > 4096 or size > len(data) - 32:
            return False
        offset = 32
        for _ in range(count):
            if offset + 8 > 32 + size:
                return False
            command, length = struct.unpack_from('<II', data, offset)
            if length < 8 or offset + length > 32 + size:
                return False
            # LC_BUILD_VERSION platform 2 = device iOS, 7 = iOS Simulator.
            if command == 0x32 and length >= 24:
                return struct.unpack_from('<I', data, offset + 8)[0] == 2
            if command == 0x25:  # LC_VERSION_MIN_IPHONEOS (older toolchains)
                return True
            offset += length
        return False
    formats = {b'\xca\xfe\xba\xbe': ('>', 20), b'\xca\xfe\xba\xbf': ('>', 32),
               b'\xbe\xba\xfe\xca': ('<', 20), b'\xbf\xba\xfe\xca': ('<', 32)}
    if data[:4] not in formats:
        return False
    endian, stride = formats[data[:4]]
    count = struct.unpack_from(endian + 'I', data, 4)[0]
    if count > 32 or 8 + count * stride > len(data):
        return False
    for i in range(count):
        entry = 8 + i * stride
        if struct.unpack_from(endian + 'I', data, entry)[0] == ARM64:
            offset, length = struct.unpack_from(endian + ('QQ' if stride == 32 else 'II'), data, entry + 8)
            if offset + length <= len(data) and has_arm64(data[offset:offset + length]):
                return True
    return False


def verify(ipa, expected_app=None):
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'IPA contains duplicate ZIP entries')
        hosts = [name for name in names if name.startswith('Payload/') and name.count('/') == 2 and name.endswith('.app/Info.plist')]
        require(len(hosts) == 1, 'Expected exactly one host app in Payload')
        host_path = hosts[0].rsplit('/', 1)[0]
        widget_path = f'{host_path}/PlugIns/{TARGET}.appex'
        require(f'{widget_path}/Info.plist' in names, 'Lyrics widget is missing from PlugIns; do not remove app extensions when signing')
        host = plistlib.loads(archive.read(hosts[0]))
        widget = plistlib.loads(archive.read(f'{widget_path}/Info.plist'))
        require(host.get('NSSupportsLiveActivities') is True, 'Host does not enable Live Activities')
        require(widget.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.widgetkit-extension', 'Wrong extension point')
        require(widget.get('CFBundlePackageType') == 'XPC!', 'Wrong extension bundle type')
        require(widget.get('CFBundleIdentifier', '').startswith(host['CFBundleIdentifier'] + '.'), 'Signer/build broke the host/extension bundle ID relationship')
        for key in ('CFBundleShortVersionString', 'CFBundleVersion'):
            require(widget.get(key) == host.get(key) and bool(host.get(key)), f'Host/widget {key} mismatch')
        for base, info, marker in [(host_path, host, b'KineSyncLiveActivity'), (widget_path, widget, b'LyricsActivityAttributes')]:
            executable = info.get('CFBundleExecutable', '')
            require(executable and '/' not in executable, 'Invalid bundle executable')
            name = f'{base}/{executable}'
            require(name in names, f'Missing compiled executable: {name}')
            binary = archive.read(name)
            require(has_arm64(binary), f'Not an arm64 device executable: {name}')
            require(marker in binary, f'Native lyrics code is missing: {name}')
        if expected_app:
            source = Path(expected_app)
            # Compare every embedded extension file against xcodebuild's output.
            extension = source / 'PlugIns' / f'{TARGET}.appex'
            require(extension.is_dir(), 'Build output lacks lyrics extension')
            for file in extension.rglob('*'):
                if file.is_file():
                    archived = f'{widget_path}/{file.relative_to(extension).as_posix()}'
                    require(archived in names, f'Packaging dropped {archived}')
                    require(hashlib.sha256(archive.read(archived)).digest() == hashlib.sha256(file.read_bytes()).digest(), f'Packaging changed {archived}')
        print(f'Verified native host + arm64 WidgetKit extension in {Path(ipa).name}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    parser.add_argument('--expected-app')
    args = parser.parse_args()
    verify(args.ipa, args.expected_app)
