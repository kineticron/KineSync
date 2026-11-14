#!/usr/bin/env python3
"""Apply required 0755 modes only to executables inside this built app."""
import json
import os
from pathlib import Path
import plistlib
import stat
import sys
from validate_ipa import MAGIC, executable_name

app = Path(sys.argv[1]).resolve()
required = set()
for directory, _, files in os.walk(app):
    for name in files:
        file = Path(directory) / name
        if file.is_file() and file.open('rb').read(4) in MAGIC:
            required.add(file)
        if name == 'Info.plist':
            info = plistlib.loads(file.read_bytes())
            if 'CFBundleExecutable' in info:
                required.add(file.parent / executable_name(info['CFBundleExecutable']))
changes = []
for file in sorted(required):
    if not file.resolve().is_relative_to(app) or not file.is_file():
        raise ValueError(f'Unsafe or missing executable: {file}')
    old = stat.S_IMODE(file.stat().st_mode)
    if old != 0o755:
        file.chmod(0o755)
        changes.append({'path': str(file.relative_to(app)), 'old_mode': old, 'new_mode': 0o755})
Path(sys.argv[2]).write_text(json.dumps({'checked': len(required), 'repaired': changes}, indent=2) + '\n')
print(f'Executable mode repair: checked {len(required)}, chmod 0755 on {len(changes)}')
