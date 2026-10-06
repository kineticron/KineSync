"""Reject an empty compact Island in the light-mode simulator fixture.

Uses only Python's standard library so the macOS runner needs no image packages.
This checks visible foreground pixels inside the Island, not ActivityKit status.
"""
import argparse
import struct
import zlib
from pathlib import Path


def foreground_pixels(path):
    data = Path(path).read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Preview is not a PNG')
    offset, compressed = 8, []
    while offset < len(data):
        size = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b'IHDR':
            width, height, depth, color, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            if depth != 8 or color not in (2, 6) or interlace:
                raise ValueError('Expected a noninterlaced 8-bit RGB/RGBA screenshot')
        elif kind == b'IDAT':
            compressed.append(chunk)
        offset += size + 12
    channels = 4 if color == 6 else 3
    stride = width * channels
    raw = zlib.decompress(b''.join(compressed))
    rows = []
    previous = bytearray(stride)
    # Only decode the status-bar area containing the Island.
    for y in range(height // 8):
        start = y * (stride + 1)
        filtering = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        if filtering not in range(5):
            raise ValueError('Unknown PNG row filter')
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            above = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if filtering == 1:
                row[x] = (row[x] + left) & 255
            elif filtering == 2:
                row[x] = (row[x] + above) & 255
            elif filtering == 3:
                row[x] = (row[x] + (left + above) // 2) & 255
            elif filtering == 4:
                estimate = left + above - corner
                distances = [abs(estimate - value) for value in (left, above, corner)]
                prediction = (left, above, corner)[distances.index(min(distances))]
                row[x] = (row[x] + prediction) & 255
        rows.append(row)
        previous = row

    def pixel(x, y):
        return rows[y][x * channels:x * channels + 3]

    def dark(x, y):
        return max(pixel(x, y)) < 60

    center = width // 2
    top = next((y for y in range(len(rows)) if dark(center, y)), None)
    if top is None or top == 0:
        raise ValueError('Cannot locate the Island in the light-mode fixture')
    bottom = next((y for y in range(top, len(rows)) if not dark(center, y)), None)
    if bottom is None:
        raise ValueError('Cannot locate the bottom of the Island')
    island_height = bottom - top
    # A lower row has no icon/text and provides a black span narrower than the
    # central capsule. This excludes white background, clock, and back labels.
    anchor = bottom - max(2, island_height // 12)
    left, right = center, center
    while left > 0 and dark(left - 1, anchor):
        left -= 1
    while right + 1 < width and dark(right + 1, anchor):
        right += 1
    return sum(
        min(pixel(x, y)) > 200
        for y in range(top + island_height // 5, bottom - island_height // 5)
        for x in range(left, right + 1)
    )


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('png')
    args = parser.parse_args()
    count = foreground_pixels(args.png)
    if count < 20:
        raise SystemExit(f'Empty compact Island: only {count} foreground pixels')
    print(f'Visible compact Island content: {count} foreground pixels')
