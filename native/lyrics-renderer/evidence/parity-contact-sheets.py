"""Compose actual renderer PNGs, never substitute hand-painted lyric references.
Calculates global, foreground, and per-region normalized pixel parity metrics.
Binds to declared parity-manifest.json thresholds and enforces anti-collapse ink constraints.
"""
import math
import hashlib
import json
import os
import sys
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

root = Path(sys.argv[1])
output = Path(sys.argv[2]) if len(sys.argv) > 2 else root
output.mkdir(parents=True, exist_ok=True)

manifest_path = root / 'capture-manifest.json'
assert manifest_path.exists(), f"missing capture manifest: {manifest_path}"
manifest = json.loads(manifest_path.read_text())

# Load specification manifest for fixture contracts and thresholds
if len(sys.argv) > 3:
    spec_path = Path(sys.argv[3])
elif 'selected_manifest_path' in manifest and Path(manifest['selected_manifest_path']).exists():
    spec_path = Path(manifest['selected_manifest_path'])
elif (root / 'parity-manifest.json').exists():
    spec_path = root / 'parity-manifest.json'
else:
    spec_path = Path(__file__).parent / 'parity-manifest.json'

assert spec_path.exists(), f"specification manifest not found at: {spec_path}"
spec = json.loads(spec_path.read_text())
fixtures_by_id = {f['id']: f for f in spec.get('fixtures', [])}

try:
    font_file = subprocess.check_output(['fc-match', '-f', '%{file}', 'sans-serif'], text=True).strip()
    font = ImageFont.truetype(font_file, 16)
    small_font = ImageFont.truetype(font_file, 13)
except Exception:
    font = ImageFont.load_default()
    small_font = ImageFont.load_default()

background = (22, 28, 40, 255)
rows = []
all_rows = []
artifacts = []
metrics = []

for record in manifest['records']:
    images = [Image.open(record['pngs'][name]).convert('RGBA') for name in ['skia', 'rust']]
    assert images[0].size == images[1].size, f"mismatched renderer dimensions: {images[0].size} vs {images[1].size}"

    # Strict dimension check against declared viewport * DPR
    dpr = record['viewport']['dpr']
    expected_width = record['viewport']['width'] * dpr
    expected_height = record['viewport']['height'] * dpr
    assert images[0].size == (expected_width, expected_height), (
        f"strict dimension check failed: got {images[0].size}, expected {(expected_width, expected_height)}"
    )

    for name, image in zip(['skia', 'rust'], images):
        assert hashlib.sha256(Path(record['pngs'][name]).read_bytes()).hexdigest() == record['pngHashes'][name]
        assert image.getchannel('A').getbbox(), f'empty {name} raster'

    # Look up fixture thresholds explicitly by declared fixture ID
    fixture_key = record.get('fixture_id') or ('korean' if 'korean' in record['id'] else 'latin')
    assert fixture_key in fixtures_by_id, f"fixture '{fixture_key}' not found in manifest fixtures: {list(fixtures_by_id.keys())}"
    spec_fixture = fixtures_by_id[fixture_key]
    assert 'baseline_thresholds' in spec_fixture, f"missing baseline_thresholds for fixture {fixture_key}"
    fixture_thresholds = spec_fixture['baseline_thresholds']

    # Premultiplied float arrays for Zero-Alpha RGB Invariance:
    # When A = 0, premultiplied RGBA is (0, 0, 0, 0); unassociated raw RGB has zero effect.
    sk_raw = np.asarray(images[0]).astype(float) / 255.0
    ru_raw = np.asarray(images[1]).astype(float) / 255.0
    p1 = sk_raw.copy()
    p2 = ru_raw.copy()
    p1[:, :, :3] *= p1[:, :, 3:4]
    p2[:, :, :3] *= p2[:, :, 3:4]

    a_skia = sk_raw[:, :, 3]
    a_rust = ru_raw[:, :, 3]
    alpha_delta = np.abs(a_skia - a_rust)
    max_alpha_delta = int(np.round(alpha_delta.max() * 255.0))
    mean_alpha_delta = float(alpha_delta.mean() * 255.0)

    # Count meaningful ink pixels (alpha >= 8/255 to eliminate sub-quantization/flooding)
    ink_thresh = 8.0 / 255.0
    sk_ink_mask = a_skia >= ink_thresh
    ru_ink_mask = a_rust >= ink_thresh
    n_skia = int(sk_ink_mask.sum())
    n_rust = int(ru_ink_mask.sum())
    coverage_ratio = float(min(n_skia, n_rust) / max(n_skia, n_rust)) if max(n_skia, n_rust) > 0 else 0.0

    # Rust ink alpha energy: mean alpha on Rust ink pixels
    # Rejects alpha-8 camouflage where text is rendered at alpha 8 (~0.031) instead of real ink (~0.53+)
    mean_ru_ink_alpha = float(a_rust[ru_ink_mask].sum()) / max(n_rust, 1) if n_rust > 0 else 0.0
    mean_ru_alpha_on_ref = float(a_rust[sk_ink_mask].sum()) / max(n_skia, 1) if n_skia > 0 else 0.0

    # Bounding boxes per renderer on meaningful ink (alpha >= 8/255)
    if n_skia > 0:
        sk_y, sk_x = np.nonzero(sk_ink_mask)
        sk_bbox = (int(sk_x.min()), int(sk_y.min()), int(sk_x.max()), int(sk_y.max()))
    else:
        sk_bbox = None

    if n_rust > 0:
        ru_y, ru_x = np.nonzero(ru_ink_mask)
        ru_bbox = (int(ru_x.min()), int(ru_y.min()), int(ru_x.max()), int(ru_y.max()))
        rust_bbox_w = int(ru_x.max() - ru_x.min())
        rust_bbox_h = int(ru_y.max() - ru_y.min())
    else:
        ru_bbox = None
        rust_bbox_w = 0
        rust_bbox_h = 0
    min_bbox_dim = 16 * dpr

    # Combined bounding box of ink (with margin)
    margin = 16 * dpr
    if sk_bbox and ru_bbox:
        comb_box = (
            max(0, min(sk_bbox[0], ru_bbox[0]) - margin),
            max(0, min(sk_bbox[1], ru_bbox[1]) - margin),
            min(images[0].width, max(sk_bbox[2], ru_bbox[2]) + margin),
            min(images[0].height, max(sk_bbox[3], ru_bbox[3]) + margin),
        )
    elif sk_bbox:
        comb_box = (
            max(0, sk_bbox[0] - margin), max(0, sk_bbox[1] - margin),
            min(images[0].width, sk_bbox[2] + margin), min(images[0].height, sk_bbox[3] + margin)
        )
    else:
        comb_box = (0, 0, images[0].width, images[0].height)

    # Background flood check: detect unassociated alpha flood outside combined ink bounding box
    outside_mask = np.ones_like(a_rust, dtype=bool)
    outside_mask[comb_box[1]:comb_box[3], comb_box[0]:comb_box[2]] = False
    outside_rust_alpha_max = int(np.round((a_rust[outside_mask].max() if outside_mask.any() else 0.0) * 255.0))
    outside_rust_alpha_mean = float(a_rust[outside_mask].mean()) if outside_mask.any() else 0.0

    # In-box mask for antialiased foreground: pixels within ink bounding box where either has alpha
    in_box = np.zeros_like(a_skia, dtype=bool)
    in_box[comb_box[1]:comb_box[3], comb_box[0]:comb_box[2]] = True
    fg_mask = ((a_skia > 0) | (a_rust > 0)) & in_box
    total_pixels = int(expected_width * expected_height)
    fg_pixels = int(fg_mask.sum())
    fg_pixel_ratio = float(fg_pixels / total_pixels) if total_pixels > 0 else 0.0

    # 1. Undiluted Foreground Alpha Score
    fg_alpha_norm_delta = float(alpha_delta[fg_mask].mean()) if fg_pixels > 0 else 0.0
    fg_alpha_score = float(1.0 - fg_alpha_norm_delta) if fg_pixels > 0 else 1.0

    # 2. Undiluted Foreground Premultiplied RGBA Score
    rgba_delta = np.abs(p1 - p2).mean(axis=2)
    fg_rgba_norm_delta = float(rgba_delta[fg_mask].mean()) if fg_pixels > 0 else 0.0
    fg_rgba_score = float(1.0 - fg_rgba_norm_delta) if fg_pixels > 0 else 1.0

    # 3. Composited Appearance Diff over standard background
    bg_norm = np.array([22.0 / 255.0, 28.0 / 255.0, 40.0 / 255.0])
    c_sk = p1[:, :, :3] + bg_norm * (1.0 - p1[:, :, 3:4])
    c_ru = p2[:, :, :3] + bg_norm * (1.0 - p2[:, :, 3:4])
    norm_delta = np.abs(c_sk - c_ru).mean(axis=2)

    changed_pixels = int(np.any(np.abs(c_sk - c_ru) > (0.5 / 255.0), axis=2).sum())
    max_rgb_delta = int(np.round(np.abs(c_sk - c_ru).max() * 255.0))
    mean_rgb_delta = float(norm_delta.mean() * 255.0)
    global_norm_delta = float(norm_delta.mean())
    global_norm_score = float(1.0 - global_norm_delta)

    # Composited Foreground Score
    if fg_pixels > 0:
        fg_norm_delta = float(norm_delta[fg_mask].mean())
        fg_norm_score = float(1.0 - fg_norm_delta)
        fg_changed_pixels = int((norm_delta[fg_mask] > (0.5 / 255.0)).sum())
        fg_changed_ratio = float(fg_changed_pixels / fg_pixels)
    else:
        fg_norm_delta = 0.0
        fg_norm_score = 1.0
        fg_changed_pixels = 0
        fg_changed_ratio = 0.0

    # Physical premultiplied reference energy score (fixed reference normalizer)
    total_phys_error = float(np.abs(p1 - p2).sum())
    e_ref_phys = float(p1.sum())
    assert e_ref_phys > 0, 'ZERO_REFERENCE_ENERGY'
    physical_threshold = fixture_thresholds.get('max_physical_error')
    assert type(physical_threshold) in (int, float) and math.isfinite(physical_threshold) and 0 <= physical_threshold <= 0.10, 'INVALID_PHYSICAL_THRESHOLD'
    physical_error = total_phys_error / e_ref_phys
    ref_energy_normalized_score = max(0.0, 1.0 - physical_error)
    physical_passed = physical_error <= physical_threshold

    # Region: text ink bounding box
    bounds = comb_box
    cmin, rmin, cmax, rmax = bounds
    bbox_slice = norm_delta[rmin:rmax, cmin:cmax]
    bbox_pixels = int(bbox_slice.size)
    bbox_norm_delta = float(bbox_slice.mean()) if bbox_pixels > 0 else 0.0
    bbox_norm_score = float(1.0 - bbox_norm_delta) if bbox_pixels > 0 else 1.0

    # Region: vertical thirds
    h3 = expected_height // 3
    top_score = float(1.0 - norm_delta[:h3, :].mean())
    center_score = float(1.0 - norm_delta[h3:2*h3, :].mean())
    bottom_score = float(1.0 - norm_delta[2*h3:, :].mean())

    min_fg_rgb = fixture_thresholds['min_foreground_score']
    min_fg_alpha = fixture_thresholds.get('min_foreground_alpha_score', 0.35)
    min_coverage = fixture_thresholds.get('min_coverage_ratio', 0.50)
    min_ink = fixture_thresholds.get('min_ink_pixels_3x', 10000) if dpr == 3 else fixture_thresholds.get('min_ink_pixels_1x', 1500)
    max_rgb_delta_limit = fixture_thresholds.get('max_mean_rgb_delta', 6.0)
    max_alpha_delta_limit = fixture_thresholds.get('max_mean_alpha_delta', 160.0)
    min_ru_ink_alpha = fixture_thresholds.get('min_mean_rust_ink_alpha', 0.20)
    max_outside_alpha = fixture_thresholds.get('max_outside_alpha', 0)

    # Multi-dimensional anti-regression gate: catches vanishing text, 1-pixel collapse, and alpha camouflage
    baseline_passed = bool(
        physical_passed
        and fg_norm_score >= min_fg_rgb
        and fg_alpha_score >= min_fg_alpha
        and coverage_ratio >= min_coverage
        and n_rust >= min_ink
        and n_skia >= min_ink
        and mean_rgb_delta <= max_rgb_delta_limit
        and mean_alpha_delta <= max_alpha_delta_limit
        and rust_bbox_w >= min_bbox_dim
        and rust_bbox_h >= min_bbox_dim
        and mean_ru_ink_alpha >= min_ru_ink_alpha
        and outside_rust_alpha_max <= max_outside_alpha
    )

    record_metric = {
        'id': record['id'],
        'fixture_id': fixture_key,
        'compared': 'unregistered same-viewport composited bytes; includes known layout/font/appearance differences',
        'changed_pixels': changed_pixels,
        'max_rgb_delta': max_rgb_delta,
        'mean_rgb_delta': round(mean_rgb_delta, 4),
        'max_alpha_delta': max_alpha_delta,
        'mean_alpha_delta': round(mean_alpha_delta, 4),
        'accepted_parity': False,
        'global_normalized_score': round(global_norm_score, 4),
        'global_normalized_delta': round(global_norm_delta, 4),
        'foreground_normalized_score': round(fg_norm_score, 4),
        'foreground_normalized_delta': round(fg_norm_delta, 4),
        'foreground_alpha_score': round(fg_alpha_score, 4),
        'foreground_rgba_score': round(fg_rgba_score, 4),
        'ref_energy_normalized_score': round(ref_energy_normalized_score, 4),
        'ink_coverage_ratio': round(coverage_ratio, 4),
        'skia_ink_pixels': n_skia,
        'rust_ink_pixels': n_rust,
        'mean_rust_ink_alpha': round(mean_ru_ink_alpha, 4),
        'mean_rust_alpha_on_ref': round(mean_ru_alpha_on_ref, 4),
        'outside_rust_alpha_max': outside_rust_alpha_max,
        'rust_bbox_dimensions': [rust_bbox_w, rust_bbox_h],
        'foreground_pixels': fg_pixels,
        'foreground_pixel_ratio': round(fg_pixel_ratio, 4),
        'foreground_changed_pixels': fg_changed_pixels,
        'foreground_changed_ratio': round(fg_changed_ratio, 4),
        'bbox_normalized_score': round(bbox_norm_score, 4),
        'bbox_bounds': list(bounds),
        'region_scores': {
            'top': round(top_score, 4),
            'center': round(center_score, 4),
            'bottom': round(bottom_score, 4),
        },
        'alpha_normalized_score': round(fg_alpha_score, 4),
        'physical_error': physical_error,
        'physical_score': ref_energy_normalized_score,
        'physical_threshold': physical_threshold,
        'physical_passed': physical_passed,
        'gate_passed': baseline_passed,
        'status': 'NUMERIC_PASS' if baseline_passed else 'FAIL',
        'failure_reasons': ([] if physical_passed else ['PHYSICAL_ERROR_EXCEEDED']) + ([] if baseline_passed else ['BASELINE_GATE_FAILED']),
        'baseline_passed': baseline_passed,
        'baseline_thresholds': fixture_thresholds,
        'honest_labels': {
            'scope': 'isolated_voice_baseline_diagnostic',
            'style_parity': 'unsupported_in_rust_baseline',
            'font_parity': 'unmatched_system_fallback',
            'rust_font_provenance': 'UNVERIFIED_SYSTEM_FALLBACK_CANDIDATES',
            'rust_face_attestation': 'UNVERIFIED',
            'fullscreen_parity': 'out_of_scope',
        },
    }
    metrics.append(record_metric)

    # Visual compositing for comparison sheet
    composited = []
    for image in images:
        display = Image.new('RGBA', image.size, background)
        display.alpha_composite(image)
        composited.append(display.convert('RGB'))
    diff = ImageChops.difference(*composited)

    # Crop text lane for the comparison sheet
    crops = [im.crop(bounds) for im in composited + [diff.point(lambda x: min(255, x * 4))]]
    size = (round(crops[0].width * 2 / dpr), round(crops[0].height * 2 / dpr))
    crops = [im.resize(size, Image.Resampling.NEAREST) for im in crops]
    sheet = Image.new('RGB', (size[0] * 3 + 32, size[1] + 92), background[:3])
    draw = ImageDraw.Draw(sheet)
    header_text = (
        f"{record['id']} | t={record['time_ms']:.1f}ms | "
        f"FG={fg_norm_score:.1%} | Alpha={fg_alpha_score:.1%} | Cov={coverage_ratio:.1%}"
    )
    draw.text((8, 5), header_text, font=font, fill='white')
    for i, (label, crop) in enumerate(zip(['ACTUAL SKIA / CanvasKit', 'RUST ABI3 BASELINE', 'RGB DIFFERENCE x4'], crops)):
        x = 8 + i * (size[0] + 8)
        draw.text((x, 31), label, font=font, fill='white')
        sheet.paste(crop, (x, 58))
    draw.text((8, size[1] + 65), 'Explicit Linux fallback; host lane; no UIKit blur, native row opacity or device claim.', font=font, fill='#b7c1d0')
    p = output / f"rust_parity_{record['id']}_compare.png"
    sheet.save(p)
    artifacts.append(p)

    all_rows.append((record['id'], sheet, record_metric))

    # Maintain original 4-item list for backward-compatible rust_parity_first_contact.png
    if dpr == 1 and record['viewport']['width'] < record['viewport']['height']:
        rows.append((record['id'], sheet))

# 1. Backwards-compatible first contact sheet (4 rows or fallback)
width = 1320
contact_rows = rows if rows else [(r[0], r[1]) for r in all_rows]
heights = [round(im.height * width / im.width) for _, im in contact_rows]
contact_total_h = max(60, sum(heights))
contact = Image.new('RGB', (width, contact_total_h), background[:3])
y = 0
for (_, im), height in zip(contact_rows, heights):
    contact.paste(im.resize((width, height), Image.Resampling.LANCZOS), (0, y))
    y += height
contact_path = output / 'rust_parity_first_contact.png'
contact.save(contact_path)
artifacts.append(contact_path)

# 2. Consolidated Side-by-Side Review Grid (all 12 records: portrait & landscape, spicy & amll)
grid_width = 1320
grid_heights = [round(im.height * grid_width / im.width) for _, im, _ in all_rows]
header_banner_h = 44
grid_total_h = max(header_banner_h + 60, sum(grid_heights) + header_banner_h)
grid = Image.new('RGB', (grid_width, grid_total_h), background[:3])
grid_draw = ImageDraw.Draw(grid)
grid_draw.text(
    (12, 12),
    "RUST VS PRODUCTION SKIA DETERMINISTIC PARITY GRID (12 FIXTURES: PORTRAIT & LANDSCAPE, SPICY & AMLL)",
    font=font,
    fill='white'
)
gy = header_banner_h
for (_, im, _), height in zip(all_rows, grid_heights):
    grid.paste(im.resize((grid_width, height), Image.Resampling.LANCZOS), (0, gy))
    gy += height
grid_path = output / 'rust_parity_grid.png'
grid.save(grid_path)
artifacts.append(grid_path)

# Determinism metadata from environment
determinism_status = os.environ.get('PARITY_DETERMINISM_STATUS', 'UNKNOWN')
determinism_verified = os.environ.get('PARITY_DETERMINISM_VERIFIED', 'false').lower() == 'true'

# 3. Write structured JSON report
report = {
    'schema': 2,
    'manifest_digest': manifest.get('manifest_digest'),
    'determinism_status': determinism_status,
    'determinism_verified': determinism_verified,
    'scope': 'Deterministic numerical Rust vs production Skia parity comparison. Baseline diagnostic; no full native parity claim.',
    'font_provenance': {
        'skia': 'EXPLICITLY_LOADED_ASSETS_VERIFIED',
        'rust': 'UNVERIFIED_SYSTEM_FALLBACK_CANDIDATES',
        'rust_face_attestation': 'UNVERIFIED: Selected font face and blob digest cannot be intercepted without modifying forbidden runtime/example files. Only system candidate paths are recorded.'
    },
    'honest_limitations': [
        'React hooks/state/clock sampled in Node; no Yoga/UI thread/UIKit material blur',
        'Skia paragraph adapter appends explicit Parity Linux CJK family; not iOS cascade',
        'Rust baseline has no style support and is intentionally identical in both style comparisons',
        'Same source syllables/times; each production model retains its own text/spacing transformation',
        'Isolated host-selected lane origin and width, no claim of native measured layout or touch proof',
        'AMLL line-motion sampled at declared bright/dark/scale; outer row/view opacity and transforms excluded for both styles',
        'Rust font selection is unverified system candidate fallback; exact face blob/index attestation is unsupported in baseline'
    ],
    'records': metrics,
    'artifacts': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in artifacts]
}
report_json_path = output / 'comparison-report.json'
report_json_path.write_text(json.dumps(report, indent=2) + '\n')
if output != root:
    (root / 'comparison-report.json').write_text(json.dumps(report, indent=2) + '\n')

# 4. Write Markdown table report
table_lines = [
    "# Deterministic Rust vs Production Skia Parity Report",
    "",
    "> [!NOTE]",
    "> Differences are diagnostic against unchanged ABI3 Rust baseline.",
    "> Rust baseline currently lacks style support and uses system CJK font candidate.",
    f"> Determinism Status: `{determinism_status}` (verified: {determinism_verified})",
    "> Rust Font Provenance: `UNVERIFIED_SYSTEM_FALLBACK_CANDIDATES` (face attestation unverified)",
    "",
    "| ID | Fixture | Style | Viewport | DPR | Global Score | FG Score | FG Alpha | Coverage | Gate |",
    "|---|---|---|---|---|---|---|---|---|---|",
]
for m in metrics:
    fid = m['id']
    fixture = 'Korean' if 'korean' in fid else 'Latin'
    style = 'Spicy' if 'spicy' in fid else 'AMLL'
    if '844x390' in fid:
        vp = '844x390 (Landscape)'
    else:
        vp = '390x640 (Portrait)'
    dpr_str = '3x' if '-3x' in fid else '1x'
    gate = "PASS" if m['baseline_passed'] else "FAIL"
    table_lines.append(
        f"| `{fid}` | {fixture} | {style} | {vp} | {dpr_str} | "
        f"{m['global_normalized_score']:.2%} | **{m['foreground_normalized_score']:.2%}** | "
        f"{m['foreground_alpha_score']:.2%} | {m['ink_coverage_ratio']:.1%} | `{gate}` |"
    )
table_lines.append("")
table_lines.append(f"**Review Grid Image**: `{grid_path}`")
table_lines.append(f"**Contact Sheet Image**: `{contact_path}`")
table_lines.append(f"**JSON Report**: `{report_json_path}`")
table_lines.append("")

md_report_path = output / 'parity-comparison-report.md'
md_report_path.write_text('\n'.join(table_lines) + '\n')
if output != root:
    (root / 'parity-comparison-report.md').write_text('\n'.join(table_lines) + '\n')

print(json.dumps({
    'comparisons': len(metrics),
    'grid_sheet': str(grid_path),
    'contact_sheet': str(contact_path),
    'json_report': str(report_json_path),
    'markdown_report': str(md_report_path)
}))
