#!/usr/bin/env python3
"""Fail closed on simulator-only app structure, Mach-O slices and JS bundle.

Every Mach-O inside the .app, including the embedded widget extension, must be
arm64 and report the IOSSIMULATOR platform. File existence alone is not enough.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys

MAGIC = {bytes.fromhex(value) for value in ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']}
# Expo native module name, ABI method, native view input and playback command.
MARKERS = ['KineSyncRustLyrics', 'abiVersion', 'trackJson', 'setAnchor']
EXTENSION = 'KineSyncLyricsWidget.appex'


def run(*args):
    executable = shutil.which(args[0]) or args[0]
    command = [executable, *args[1:]]
    shell = os.name == 'nt' and executable.lower().endswith(('.cmd', '.bat'))
    return subprocess.run(command, check=True, capture_output=True, text=True, shell=shell).stdout


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def macho_files(app):
    found = []
    for directory, _, files in os.walk(app):
        for name in files:
            file = Path(directory) / name
            if file.is_symlink() or not file.is_file():
                continue
            with file.open('rb') as stream:
                if stream.read(4) in MAGIC:
                    found.append(file)
    return sorted(found)


def check_plist(info, label, bundle_id, app, require_promotion=False):
    executable = info.get('CFBundleExecutable')
    if not isinstance(executable, str) or not executable or '/' in executable or executable in ('.', '..'):
        raise ValueError(f'{label}: invalid CFBundleExecutable')
    if info.get('CFBundleIdentifier') != bundle_id:
        raise ValueError(f'{label}: CFBundleIdentifier is {info.get("CFBundleIdentifier")!r}, expected {bundle_id!r}')
    if info.get('DTPlatformName') != 'iphonesimulator':
        raise ValueError(f'{label}: DTPlatformName is not iphonesimulator')
    if not str(info.get('DTSDKName', '')).startswith('iphonesimulator'):
        raise ValueError(f'{label}: DTSDKName is not an iphonesimulator SDK')
    if 'iPhoneSimulator' not in (info.get('CFBundleSupportedPlatforms') or []):
        raise ValueError(f'{label}: CFBundleSupportedPlatforms does not include iPhoneSimulator')
    if require_promotion and info.get('CADisableMinimumFrameDurationOnPhone') is not True:
        raise ValueError(f'{label}: CADisableMinimumFrameDurationOnPhone must be Boolean true')
    binary = app / executable
    if not binary.is_file():
        raise ValueError(f'{label}: CFBundleExecutable is missing')
    has_execute = stat.S_IMODE(binary.stat().st_mode) & 0o111 == 0o111
    if os.name != 'nt' and not has_execute:
        raise ValueError(f'{label}: CFBundleExecutable is not executable')
    return binary


def inspect_macho(file, app):
    archs = run('xcrun', 'lipo', '-archs', str(file)).split()
    if archs != ['arm64']:
        raise ValueError(f'Non-arm64 Mach-O slice in {file.relative_to(app)}: {archs}')
    for arch in archs:
        build = run('xcrun', 'vtool', '-show-build', '-arch', arch, str(file))
        if re.findall(r'^\s*platform\s+(\S+)\s*$', build, re.MULTILINE) != ['IOSSIMULATOR']:
            raise ValueError(f'{file.relative_to(app)} is not an IOSSIMULATOR slice')
    return {'path': str(file.relative_to(app)), 'architectures': archs, 'platform': 'IOSSIMULATOR'}


def js_bundles(app):
    found = []
    for directory, _, files in os.walk(app):
        for name in files:
            file = Path(directory) / name
            if file.is_symlink() or not file.is_file() or not name.endswith('.jsbundle'):
                continue
            data = file.read_bytes()
            if len(data) < 100_000:
                raise ValueError(f'Embedded JS bundle is unexpectedly small: {file.relative_to(app)}')
            missing = [marker for marker in MARKERS if marker.encode('utf-8') not in data and marker.encode('utf-16le') not in data]
            if missing:
                raise ValueError(f'Embedded JS bundle {file.relative_to(app)} lacks {missing}')
            found.append({'path': str(file.relative_to(app)), 'bytes': len(data), 'sha256': sha256(file), 'markers': MARKERS})
    if not found:
        raise ValueError('No embedded .jsbundle in app')
    return found


def verify(app, expected_bundle_id):
    app = Path(app).resolve()
    if not app.is_dir() or app.suffix != '.app':
        raise ValueError('Expected a .app directory')
    for directory, dirs, files in os.walk(app):
        for name in dirs + files:
            file = Path(directory) / name
            if file.is_symlink() and (not file.exists() or not file.resolve().is_relative_to(app)):
                raise ValueError(f'Unsafe bundle symlink: {file.relative_to(app)}')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    binary = check_plist(info, 'main app', expected_bundle_id, app, require_promotion=True)
    extension = app / 'PlugIns' / EXTENSION
    if not extension.is_dir():
        raise ValueError(f'Missing embedded {EXTENSION}')
    extension_info = plistlib.loads((extension / 'Info.plist').read_bytes())
    extension_binary = check_plist(extension_info, EXTENSION, f'{expected_bundle_id}.KineSyncLyricsWidget', extension)
    machos = [inspect_macho(file, app) for file in macho_files(app)]
    if not any(entry['path'] == info['CFBundleExecutable'] for entry in machos):
        raise ValueError('Main app executable was not inspected as a Mach-O')
    if not any(entry['path'] == str(extension_binary.relative_to(app)) for entry in machos):
        raise ValueError('Widget executable was not inspected as a Mach-O')
    return {
        'app': str(app),
        'bundle_identifier': info['CFBundleIdentifier'],
        'executable': info['CFBundleExecutable'],
        'platform': info['DTPlatformName'],
        'sdk': info['DTSDKName'],
        'architectures': machos,
        'js_bundles': js_bundles(app),
        'extension': {'path': str(extension.relative_to(app)), 'bundle_identifier': extension_info['CFBundleIdentifier']},
        'policy': 'Every Mach-O slice is arm64 and IOSSIMULATOR. Debug configuration is intentional.',
    }


if __name__ == '__main__':
    app = sys.argv[sys.argv.index('--app') + 1]
    bundle_id = sys.argv[sys.argv.index('--bundle-id') + 1]
    evidence = sys.argv[sys.argv.index('--evidence') + 1] if '--evidence' in sys.argv else None
    result = verify(app, bundle_id)
    if evidence:
        Path(evidence).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
