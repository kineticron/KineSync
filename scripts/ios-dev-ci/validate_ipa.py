#!/usr/bin/env python3
"""Independent executable-policy validation, not source/archive mode equality.

Reject a non-executable Mach-O or CFBundleExecutable even when source and ZIP
have identical 0644 modes. Does not repair data, sign, install or launch apps.
"""
import json
import os
from pathlib import Path
import plistlib
import posixpath
import stat
import sys
import zipfile

MAGIC = {bytes.fromhex(value) for value in ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']}

def executable_name(value):
    if not isinstance(value, str) or not value or '/' in value or value in {'.', '..'}:
        raise ValueError('Invalid CFBundleExecutable name')
    return value

def validate_app(app):
    app = Path(app).resolve()
    required = set()
    for directory, _, files in os.walk(app):
        for name in files:
            file = Path(directory) / name
            if not file.resolve().is_relative_to(app):
                raise ValueError(f'Executable path escapes app: {file}')
            if file.is_file() and file.open('rb').read(4) in MAGIC:
                required.add(file)
            if name == 'Info.plist':
                info = plistlib.loads(file.read_bytes())
                if 'CFBundleExecutable' in info:
                    required.add(file.parent / executable_name(info['CFBundleExecutable']))
    for file in required:
        if not file.resolve().is_relative_to(app) or not file.is_file() or stat.S_IMODE(file.stat().st_mode) & 0o111 != 0o111:
            raise ValueError(f'Non-executable or missing bundled executable: {file}')
    if not required:
        raise ValueError('No bundled executables found')
    return {'checked_executables': len(required), 'policy': 'Every Mach-O and CFBundleExecutable must have 0111 execute bits'}

def validate_zip(ipa):
    with zipfile.ZipFile(ipa) as archive:
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC failed')
        entries = {entry.filename.rstrip('/'): entry for entry in archive.infolist()}
        if len(entries) != len(archive.infolist()):
            raise ValueError('Duplicate ZIP entries')
        required = set()
        def resolve(name):
            for _ in range(64):
                parts = name.split('/')
                for index in range(1, len(parts) + 1):
                    prefix = '/'.join(parts[:index])
                    entry = entries.get(prefix)
                    if entry and stat.S_ISLNK(entry.external_attr >> 16):
                        target = archive.read(entry).decode('utf-8')
                        if target.startswith('/'):
                            raise ValueError('Absolute ZIP symlink')
                        name = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), target, *parts[index:]))
                        if not name.startswith('Payload/') or '/../' in name:
                            raise ValueError('ZIP symlink escapes payload')
                        break
                else:
                    return entries.get(name)
            raise ValueError('ZIP symlink cycle')
        for name, entry in entries.items():
            if not name.startswith('Payload/'):
                raise ValueError('Unexpected non-Payload IPA entry')
            mode = entry.external_attr >> 16
            if not stat.S_ISLNK(mode):
                with archive.open(entry) as stream:
                    first = stream.read(4)
                if first in MAGIC:
                    required.add(name)
                if name.endswith('/Info.plist'):
                    info = plistlib.loads(archive.read(entry))
                    if 'CFBundleExecutable' in info:
                        required.add(posixpath.join(posixpath.dirname(name), executable_name(info['CFBundleExecutable'])))
        for name in required:
            entry = resolve(name)
            if not entry or not stat.S_ISREG(entry.external_attr >> 16) or (entry.external_attr >> 16) & 0o111 != 0o111:
                raise ValueError(f'Non-executable or missing IPA executable: {name}')
        if not required:
            raise ValueError('No IPA executables found')
        return {'checked_executables': len(required), 'policy': 'Every Mach-O and CFBundleExecutable must have 0111 execute bits'}

if __name__ == '__main__':
    mode, source = sys.argv[1:3]
    result = validate_app(source) if mode == '--app' else validate_zip(source) if mode == '--ipa' else None
    if result is None:
        raise ValueError('Expected --app or --ipa')
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
