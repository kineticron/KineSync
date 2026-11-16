#!/usr/bin/env python3
"""Package an unsigned .app inside an IPA, preserving POSIX modes and symlinks.

Verify ZIP CRC, every entry's type/mode, symlink target and content SHA against
its source before upload. No signing, installation or launch is performed.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile
from validate_ipa import validate_app, validate_zip


def package(app, ipa, manifest):
    app, ipa, manifest = Path(app), Path(ipa), Path(manifest)
    if not app.is_dir() or app.suffix != '.app' or app.is_symlink():
        raise ValueError('Expected a real .app directory')
    if ipa.exists():
        raise ValueError('Refusing to overwrite an existing IPA on a non-fresh runner')
    validate_app(app)
    entries = []

    def visit(file, name):
        info = file.lstat()
        is_link = stat.S_ISLNK(info.st_mode)
        is_dir = stat.S_ISDIR(info.st_mode)
        if not (is_link or is_dir or stat.S_ISREG(info.st_mode)):
            raise ValueError(f'Unsupported file type: {file}')
        if is_dir:
            name += '/'
        data = os.readlink(file).encode() if is_link else b'' if is_dir else file.read_bytes()
        entries.append({'path': name, 'mode': stat.S_IMODE(info.st_mode),
                        'type': 'symlink' if is_link else 'directory' if is_dir else 'file',
                        'sha256': hashlib.sha256(data).hexdigest(), 'data': data})
        if is_dir:
            for child in sorted(file.iterdir()):
                visit(child, name + child.name)

    visit(app, 'Payload/' + app.name)
    ipa.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ipa, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for entry in entries:
            item = zipfile.ZipInfo(entry['path'])
            item.create_system = 3  # Unix metadata. Artifact upload preserves this inner ZIP intact.
            kind = {'file': stat.S_IFREG, 'directory': stat.S_IFDIR, 'symlink': stat.S_IFLNK}[entry['type']]
            item.external_attr = ((kind | entry['mode']) << 16) | (0x10 if entry['type'] == 'directory' else 0)
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, entry['data'], compresslevel=1)
    with zipfile.ZipFile(ipa) as archive:
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC failed')
        if set(archive.namelist()) != {entry['path'] for entry in entries}:
            raise ValueError('ZIP entries differ from app tree')
        for entry in entries:
            item = archive.getinfo(entry['path'])
            mode = item.external_attr >> 16
            if item.create_system != 3 or stat.S_IMODE(mode) != entry['mode']:
                raise ValueError(f'Mode loss: {entry["path"]}')
            kind = {'file': stat.S_IFREG, 'directory': stat.S_IFDIR, 'symlink': stat.S_IFLNK}[entry['type']]
            if stat.S_IFMT(mode) != kind:
                raise ValueError(f'Type loss: {entry["path"]}')
            if hashlib.sha256(archive.read(item)).hexdigest() != entry['sha256']:
                raise ValueError(f'Content change: {entry["path"]}')
    executable_validation = validate_zip(ipa)
    for entry in entries:
        del entry['data']
    result = {'ipa': str(ipa), 'sha256': hashlib.sha256(ipa.read_bytes()).hexdigest(),
              'bytes': ipa.stat().st_size, 'entries': entries,
              'verification': 'ZIP CRC + source content/type/mode equality',
              'executable_validation': executable_validation, 'signing': 'unsigned', 'livecontainer_launch_tested': False}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Verified unsigned IPA: {ipa}, {len(entries)} entries, SHA-256 {result["sha256"]}')


if __name__ == '__main__':
    package(*sys.argv[1:])
