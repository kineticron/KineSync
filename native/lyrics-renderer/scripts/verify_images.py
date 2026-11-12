#!/usr/bin/env python3
"""Check actual rendered pixels for this fixed fixture/time/390x844 capture set.

Requires Pillow. This checks compositor/reveal behavior, not Skia pixel parity.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

root = Path(sys.argv[1] if len(sys.argv) > 1 else '/files')

def load(name):
    image = Image.open(root / name).convert('RGB')
    assert image.size == (390, 844), image.size
    return image

def changed(a, b, box):
    diff = ImageChops.difference(a.crop(box), b.crop(box))
    data = diff.tobytes()
    return sum(bool(r or g or b) for r, g, b in zip(data[0::3], data[1::3], data[2::3]))

sharp = load('rust_spike_sharp_control.png')
blur = load('rust_spike_portrait_17500.png')
early = load('rust_spike_portrait_17300.png')
late = load('rust_spike_portrait_17700.png')
# These fixed bounds are interior to the fully protected active+next band.
protected = changed(sharp, blur, (0, 320, 390, 480))
inactive = changed(sharp, blur, (0, 100, 390, 280))
fill = changed(early, late, (28, 312, 360, 360))
outside_fill = changed(early, late, (0, 380, 390, 844))
assert protected == 0, f'active/next band blurred: {protected} pixels'
assert inactive > 1000, f'blur did not change inactive text: {inactive}'
assert fill > 50, f'timed fill did not advance: {fill}'
assert outside_fill == 0, f'time changed unrelated rows: {outside_fill}'
print(json.dumps({'protected_band_changed_pixels': protected,
                  'inactive_blur_changed_pixels': inactive,
                  'fill_progress_changed_pixels': fill,
                  'unrelated_lower_rows_changed_pixels': outside_fill,
                  'note': 'Actual PNG checks; no Skia pixel-diff gate.'}, indent=2))
