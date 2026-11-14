"""Compose actual renderer PNGs, never substitute hand-painted lyric references."""
import hashlib
import json
import sys
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

root = Path(sys.argv[1])
output = Path(sys.argv[2]) if len(sys.argv) > 2 else root
output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((root / 'capture-manifest.json').read_text())
font = ImageFont.truetype(subprocess.check_output(['fc-match', '-f', '%{file}', 'sans-serif'], text=True), 16)
background = (22, 28, 40, 255)
rows = []
artifacts = []
metrics = []
for record in manifest['records']:
    images = [Image.open(record['pngs'][name]).convert('RGBA') for name in ['skia', 'rust']]
    assert images[0].size == images[1].size
    for name, image in zip(['skia', 'rust'], images):
        assert hashlib.sha256(Path(record['pngs'][name]).read_bytes()).hexdigest() == record['pngHashes'][name]
        assert image.getchannel('A').getbbox(), f'empty {name} raster'
    composited = []
    for image in images:
        display = Image.new('RGBA', image.size, background)
        display.alpha_composite(image)
        composited.append(display.convert('RGB'))
    diff = ImageChops.difference(*composited)
    delta = np.asarray(diff)
    alpha_delta = np.abs(np.asarray(images[0].getchannel('A')).astype(int) - np.asarray(images[1].getchannel('A')).astype(int))
    metrics.append({'id': record['id'], 'compared': 'unregistered same-viewport composited bytes; includes known layout/font/appearance differences',
                    'changed_pixels': int(np.any(delta > 0, axis=2).sum()), 'max_rgb_delta': int(delta.max()),
                    'mean_rgb_delta': float(delta.mean()), 'max_alpha_delta': int(alpha_delta.max()),
                    'accepted_parity': False})
    dpr = record['viewport']['dpr']
    ink = images[0].getchannel('A').getbbox()
    other = images[1].getchannel('A').getbbox()
    bounds = (max(0, min(ink[0], other[0]) - 12 * dpr), max(0, min(ink[1], other[1]) - 16 * dpr),
              min(images[0].width, max(ink[2], other[2]) + 12 * dpr), min(images[0].height, max(ink[3], other[3]) + 16 * dpr))
    # Same crop in all columns. DPR3 sheet downsamples to logical display pixels;
    # the original full-size renderer PNGs remain available and hashed.
    crops = [im.crop(bounds) for im in composited + [diff.point(lambda x: min(255, x * 4))]]
    size = (round(crops[0].width * 2 / dpr), round(crops[0].height * 2 / dpr))
    crops = [im.resize(size, Image.Resampling.NEAREST) for im in crops]
    sheet = Image.new('RGB', (size[0] * 3 + 32, size[1] + 92), background[:3])
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 5), f"{record['id']} | t={record['time_ms']:.1f}ms | isolated active voice", font=font, fill='white')
    for i, (label, crop) in enumerate(zip(['ACTUAL SKIA / CanvasKit', 'RUST ABI3 BASELINE', 'RGB DIFFERENCE x4'], crops)):
        x = 8 + i * (size[0] + 8)
        draw.text((x, 31), label, font=font, fill='white')
        sheet.paste(crop, (x, 58))
    draw.text((8, size[1] + 65), 'Explicit Linux fallback; host lane; no UIKit blur, native row opacity or device claim.', font=font, fill='#b7c1d0')
    p = output / f"rust_parity_{record['id']}_compare.png"
    sheet.save(p)
    artifacts.append(p)
    if dpr == 1 and record['viewport']['width'] < record['viewport']['height']:
        rows.append((record['id'], sheet))
# Compact review contact sheet, resized only for display; originals above retain detail.
width = 1320
heights = [round(im.height * width / im.width) for _, im in rows]
contact = Image.new('RGB', (width, sum(heights)), background[:3])
y = 0
for (_, im), height in zip(rows, heights):
    contact.paste(im.resize((width, height), Image.Resampling.LANCZOS), (0, y))
    y += height
p = output / 'rust_parity_first_contact.png'
contact.save(p)
artifacts.append(p)
report = {'scope': 'First isolated-voice comparison. Differences are diagnostic, no pixel acceptance threshold or full parity claim.',
          'records': metrics, 'artifacts': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in artifacts]}
(root / 'comparison-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'comparisons': len(metrics), 'contact_sheet': str(p)}))
