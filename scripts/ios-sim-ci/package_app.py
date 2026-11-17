#!/usr/bin/env python3
"""Zip a simulator .app for Revyl and verify bytes, types and POSIX modes."""
import hashlib
import json
import shutil
import os
from pathlib import Path
import stat
import sys
import zipfile


def stream_hash(source):
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
    return digest.hexdigest()


def file_hash(file):
    with file.open('rb') as source:
        return stream_hash(source)


def package(app, archive, manifest):
    app, archive, manifest = Path(app), Path(archive), Path(manifest)
    if not app.is_dir() or app.suffix != '.app' or app.is_symlink():
        raise ValueError('Expected a real .app directory')
    if archive.exists():
        raise ValueError('Refusing to overwrite an existing ZIP on a non-fresh runner')
    entries = []

    def visit(file, name):
        info = file.lstat()
        is_link = stat.S_ISLNK(info.st_mode)
        is_dir = stat.S_ISDIR(info.st_mode)
        if not (is_link or is_dir or stat.S_ISREG(info.st_mode)):
            raise ValueError(f'Unsupported file type: {file}')
        if is_dir:
            name += '/'
        data = os.readlink(file).encode() if is_link else b''
        if is_link and (not file.exists() or not file.resolve().is_relative_to(app.resolve())):
            raise ValueError(f'Unsafe bundle symlink: {file}')
        entries.append({'path': name, 'mode': stat.S_IMODE(info.st_mode),
                        'type': 'symlink' if is_link else 'directory' if is_dir else 'file',
                        'sha256': file_hash(file) if not (is_link or is_dir) else hashlib.sha256(data).hexdigest(), 'source': file, 'data': data})
        if is_dir:
            for child in sorted(file.iterdir()):
                visit(child, name + child.name)

    visit(app, app.name)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as output:
        for entry in entries:
            item = zipfile.ZipInfo(entry['path'])
            item.create_system = 3
            kind = {'file': stat.S_IFREG, 'directory': stat.S_IFDIR, 'symlink': stat.S_IFLNK}[entry['type']]
            item.external_attr = ((kind | entry['mode']) << 16) | (0x10 if entry['type'] == 'directory' else 0)
            item.compress_type = zipfile.ZIP_DEFLATED
            if entry['type'] == 'file':
                with entry['source'].open('rb') as source, output.open(item, 'w', force_zip64=True) as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
            else:
                output.writestr(item, entry['data'], compresslevel=1)
    with zipfile.ZipFile(archive) as output:
        if output.testzip() is not None:
            raise ValueError('ZIP CRC failed')
        if set(output.namelist()) != {entry['path'] for entry in entries}:
            raise ValueError('ZIP entries differ from app tree')
        for entry in entries:
            item = output.getinfo(entry['path'])
            mode = item.external_attr >> 16
            if item.create_system != 3 or stat.S_IMODE(mode) != entry['mode']:
                raise ValueError(f'Mode loss: {entry["path"]}')
            kind = {'file': stat.S_IFREG, 'directory': stat.S_IFDIR, 'symlink': stat.S_IFLNK}[entry['type']]
            if stat.S_IFMT(mode) != kind:
                raise ValueError(f'Type loss: {entry["path"]}')
            with output.open(item) as source:
                if stream_hash(source) != entry['sha256']:
                    raise ValueError(f'Content change: {entry["path"]}')
    size = archive.stat().st_size
    if size > 5 * 1024 * 1024 * 1024:
        raise ValueError('Revyl 5 GiB artifact limit exceeded')
    if sum(item.file_size for item in output.infolist()) > 8 * 1024 * 1024 * 1024:
        raise ValueError('Revyl 8 GiB uncompressed workspace limit exceeded')
    for entry in entries:
        del entry['data']
        del entry['source']
    result = {'zip': str(archive), 'sha256': file_hash(archive),
              'bytes': size, 'entries': entries, 'app_root': app.name,
              'verification': 'ZIP CRC + source content/type/mode equality',
              'signing': 'unsigned', 'install_or_launch_tested_by_packager': False}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Verified simulator .app ZIP: {archive}, {len(entries)} entries, SHA-256 {result["sha256"]}')


if __name__ == '__main__':
    package(*sys.argv[1:4])
