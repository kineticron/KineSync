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
HOST_ACTIVITY_MODULE = 'KineSyncLiveActivity'
WIDGET_ACTIVITY_MODULE = TARGET


def require(condition, message):
    if not condition:
        raise ValueError(message)


def has_arm64(data, filetypes=(2,)):
    """True for an arm64 iOS binary of one of the given Mach-O file types.

    The default accepts only MH_EXECUTE (2). The Swift descriptor reader
    also accepts MH_DYLIB (6) so Debug split layouts (stub executable plus
    `<exe>.debug.dylib`) validate.
    """
    if len(data) < 32:
        return False
    if data[:4] == b'\xcf\xfa\xed\xfe':
        if struct.unpack_from('<I', data, 4)[0] != ARM64 or struct.unpack_from('<I', data, 12)[0] not in filetypes:
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


def bundle_executables(archive, base, executable):
    """Primary executable plus split siblings.

    Debug development clients link app code into `<exe>.debug.dylib` and
    leave a stub executable behind, while Release links everything into the
    executable itself. Search both so the marker/descriptor checks work for
    either layout.
    """
    names = archive.namelist()
    candidates = []
    primary = f'{base}/{executable}'
    if primary in names:
        candidates.append(primary)
    dylib = f'{primary}.debug.dylib'
    if dylib in names and dylib not in candidates:
        candidates.append(dylib)
    return candidates


def find_module(candidates, archive):
    """Return (name, module) for the first candidate with a Swift descriptor."""
    for name in candidates:
        try:
            return name, activity_attributes_module(archive.read(name))
        except ValueError:
            continue
    raise ValueError('Missing compiled LyricsActivityAttributes descriptor')


def activity_attributes_module(data):
    """Read the compiled Swift type descriptor, not a coincidental string.

    Swift's __swift5_types section points to nominal context descriptors. The
    attributes descriptor's parent identifies its actual defining module.
    """
    require(has_arm64(data, filetypes=(2, 6)), 'Expected an arm64 iOS executable or library')
    if data[:4] != b'\xcf\xfa\xed\xfe':
        formats = {b'\xca\xfe\xba\xbe': ('>', 20), b'\xca\xfe\xba\xbf': ('>', 32),
                   b'\xbe\xba\xfe\xca': ('<', 20), b'\xbf\xba\xfe\xca': ('<', 32)}
        endian, stride = formats[data[:4]]
        for i in range(struct.unpack_from(endian + 'I', data, 4)[0]):
            entry = 8 + i * stride
            if struct.unpack_from(endian + 'I', data, entry)[0] == ARM64:
                start, size = struct.unpack_from(endian + ('QQ' if stride == 32 else 'II'), data, entry + 8)
                return activity_attributes_module(data[start:start + size])
    segments, types = [], []
    offset = 32
    for _ in range(struct.unpack_from('<I', data, 16)[0]):
        command, length = struct.unpack_from('<II', data, offset)
        require(length >= 8 and offset + length <= len(data), 'Invalid Mach-O load command')
        if command == 0x19:  # LC_SEGMENT_64
            vm, _, file_offset, file_size = struct.unpack_from('<4Q', data, offset + 24)
            segments.append((vm, file_offset, file_size))
            for i in range(struct.unpack_from('<I', data, offset + 64)[0]):
                section = offset + 72 + i * 80
                require(section + 80 <= offset + length, 'Invalid Mach-O section')
                if data[section:section + 16].rstrip(b'\0') == b'__swift5_types':
                    address, size = struct.unpack_from('<QQ', data, section + 32)
                    types.append((address, size))
        offset += length

    def location(address, size=4):
        for vm, start, length in segments:
            if vm <= address and address + size <= vm + length:
                result = start + address - vm
                require(result + size <= len(data), 'Swift descriptor outside executable')
                return result
        raise ValueError('Swift descriptor outside mapped segments')

    def uint(address):
        return struct.unpack_from('<I', data, location(address))[0]

    def relative(address):
        return address + struct.unpack_from('<i', data, location(address))[0]

    def string(address):
        start = location(address, 1)
        end = data.find(b'\0', start, start + 1024)
        require(end >= start, 'Unterminated Swift descriptor name')
        return data[start:end].decode('utf-8')

    for address, size in types:
        require(size % 4 == 0, 'Invalid Swift type table')
        for entry in range(address, address + size, 4):
            descriptor = relative(entry)
            if uint(descriptor) & 31 != 17:  # struct
                continue
            if string(relative(descriptor + 8)) != 'LyricsActivityAttributes':
                continue
            parent_offset = struct.unpack_from('<i', data, location(descriptor + 4))[0]
            parent = descriptor + 4 + (parent_offset & ~1)
            if parent_offset & 1:
                parent = struct.unpack_from('<Q', data, location(parent, 8))[0]
            require(uint(parent) & 31 == 0, 'ActivityAttributes must have a module context')
            return string(relative(parent + 8))
    raise ValueError('Missing compiled LyricsActivityAttributes descriptor')


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
        modules = []
        for base, info, marker in [(host_path, host, b'KineSyncLiveActivity'), (widget_path, widget, b'LyricsActivityAttributes')]:
            executable = info.get('CFBundleExecutable', '')
            require(executable and '/' not in executable, 'Invalid bundle executable')
            candidates = bundle_executables(archive, base, executable)
            require(candidates, f'Missing compiled executable: {base}/{executable}')
            primary = archive.read(candidates[0])
            require(has_arm64(primary), f'Not an arm64 device executable: {candidates[0]}')
            binaries = [archive.read(name) for name in candidates]
            require(any(marker in binary for binary in binaries),
                    f'Native lyrics code is missing: {candidates[0]}')
            modules.append(find_module(candidates, archive)[1])
        require(modules[0] == HOST_ACTIVITY_MODULE,
                f'Unexpected host ActivityAttributes module: {modules[0]}')
        require(modules[1] == WIDGET_ACTIVITY_MODULE,
                f'Unexpected widget ActivityAttributes module: {modules[1]}')
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
        print(f'Verified native host + arm64 WidgetKit extension + shared LyricsActivityAttributes source in {Path(ipa).name}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    parser.add_argument('--expected-app')
    args = parser.parse_args()
    verify(args.ipa, args.expected_app)
