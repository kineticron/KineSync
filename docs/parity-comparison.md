# Deterministic Numerical Rust vs Production Skia Parity Harness

## Overview

The parity compare command executes actual production Skia paragraph shaping and drawing against the compiled ABI3 Rust lyrics renderer across a fixed matrix of fixtures, viewports, device pixel ratios (DPR), and styles.

No LLM is invoked at runtime. The pipeline is 100% deterministic, numerical, and fails closed.

---

## Command

The primary plain command can be run directly from the workspace root:

```bash
node scripts/parity-compare.cjs
```

Or make it directly executable:

```bash
./scripts/parity-compare.cjs
```

### CLI Options

| Option | Description | Default |
|---|---|---|
| `--output <dir>` | Directory where artifacts, reports, and manifests are written | `/tmp/rust-parity-compare-output` |
| `--manifest <path>` | Path to specification manifest contract | `native/lyrics-renderer/evidence/parity-manifest.json` |
| `--fresh-rust` | Force fresh compilation of the Rust `parity-capture` example binary on existing target | `false` |
| `--skip-repeat` | Skip the second capture pass | `false` (runs two passes by default) |
| `--json` | Print only the JSON metrics report to `stdout` | `false` |
| `--help`, `-h` | Display help and usage information | |

### Scoped Resource, Disk, and Build Constraints

The command strictly adheres to repository and disk space limitations:
- **Build inputs and toolchain attestation**: Binds binary SHA256 to complete depfile source closure digest, embedded TTML fixture (`DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml`), Cargo.lock, `rustc -Vv` compiler identity, and effective build flags.
- **Normalized Target**: Enforces `CARGO_TARGET_DIR=native/lyrics-renderer/target` in own worktree to prevent duplicate target trees or reading stale outputs.
- **Incremental dev profile**: Invokes incremental cargo build on the existing target with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`. This takes under 0.2s when unchanged and rebuilds automatically when Rust source files are modified. When `--fresh-rust` is passed, `cargo clean -p lyrics-renderer` removes only the local crate on the existing target without creating a second tree.
- **Pre-build disk space guard**: Verifies that available disk space exceeds 400 MB before initiating any cargo build.
- **Node module resolution**: References saved dependencies in `/home/kit/rust-renderer-spike/ExpoLyrics/node_modules` via explicit module resolution paths (`NODE_PATH`), preventing source ownership confusion or symlinking wrong worktrees.

---

## Manifest Contract, Cartesian Matrix, and Strict Schema

All executions bind strictly to `native/lyrics-renderer/evidence/parity-manifest.json`:
- **Strict Executable Schema**: Rejects unknown keys, contradictory dimensions, missing matrix items, or unsupported capabilities.
- **Cartesian Product Completeness**: Matrix mandates completeness across fixtures, viewports, and styles. All record IDs are unique and strictly bound.
- **Korean Fixture**: Line index 1 of `ZZA0P2622376.ttml` (start 13170 ms, end 16440 ms, sample ratio 0.47, timestamp 14706.9 ms, text "깍지 놓친 손은").
- **Latin Fixture**: Line index 9 of `ZZA0P2622376.ttml` (first ASCII-only line, start 55205 ms, end 58865 ms, sample ratio 0.47, timestamp 56925.2 ms, text "Du, du-ru-ru-ru-ru-du-du").
- **Viewports**: 390x640 1x, 844x390 1x, 390x640 3x.
- **Styles**: Spicy and AMLL.
- **Total records**: 12 combinations bound to explicit expected IDs.
- **Fail-closed contract validation**: The capture harness verifies that TTML start and end times, text syllables, and computed ratios match the manifest. The manifest digest and path are recorded in capture provenance and passed to Python metrics for explicit per-fixture threshold lookup.

---

## Output Files and Absolute Paths

When executed with default settings or `--output <dir>`, the command outputs:

| Artifact | Absolute Path | Purpose |
|---|---|---|
| **Side-by-Side Review Grid PNG** | `<output>/rust_parity_grid.png` | Comprehensive 12-fixture review grid covering portrait, landscape, Spicy, AMLL, 1x, and 3x |
| **Contact Sheet PNG** | `<output>/rust_parity_first_contact.png` | Backwards-compatible 4-row contact sheet for standard review |
| **Individual Compare PNGs** | `<output>/rust_parity_<id>_compare.png` | Side-by-side crops: `[Actual Skia \| Rust Baseline \| RGB Diff x4]` |
| **JSON Metrics Report** | `<output>/comparison-report.json` | Complete machine-readable numerical scores (global, foreground, bbox, regions, alpha, coverage, energy) |
| **Markdown Table Report** | `<output>/parity-comparison-report.md` | Human-readable table report with baseline gate verdicts |
| **Rust Binary Attestation** | `<output>/rust-binary-attestation.json` | Attested build inputs, complete depfile source closure hash, `rustc -Vv` compiler identity, and flags |
| **Capture Manifest (Pass 1)** | `<output>/captures/capture-manifest.json` | Attested source hashes, fonts, environment, and PNG digests |
| **Capture Manifest (Pass 2)** | `<output>/repeat/capture-manifest.json` | Second independent run manifest used for bit-for-bit determinism assertion |

---

## Metric Formulation, Anti-Collapse Gates, and Alpha Verification

### Premultiplied RGBA and Zero-Alpha RGB Invariance

Both Skia and Rust rasters are converted to premultiplied floating point representations:
$$p = (r, g, b, a) = ((R/255) \cdot (A/255), (G/255) \cdot (A/255), (B/255) \cdot (A/255), A/255)$$

When $A = 0$, $r = g = b = a = 0$ identically. Raw unassociated RGB differences on fully transparent pixels have zero influence on scores or metrics.

### Preventing Blank Background Dilution and Flood Attacks

In full-frame lyric rendering ($390 \times 640$ or $844 \times 390$), text occupies only 1% to 15% of the canvas. The remaining 85% to 99% of pixels are transparent background.

To prevent blank background dilution, alpha flood gaming, and ink collapse:

1. **Ink Bounding Box and Background Flood Check**:
   Ink pixels are defined as pixels with meaningful alpha ($\alpha \ge 8/255$). Bounding boxes are computed strictly from ink pixels. Any non-zero Rust alpha outside the combined ink bounding box is flagged as background alpha flood (`outside_rust_alpha_max <= 0`). Full-frame alpha-1 flooding is rejected.

2. **Rust Ink Alpha Energy Preservation**:
   $$\text{MeanInkAlpha}_{\text{rust}} = \frac{1}{N_{\text{rust}}} \sum_{p \in P_{\text{rust\_ink}}} \alpha_{\text{rust}}(p)$$
   Requires $\text{MeanInkAlpha}_{\text{rust}} \ge 0.20$. This decisively rejects alpha-8 camouflage where text is rendered at alpha 8 (0.031) instead of genuine ink (0.53 or higher).

3. **Undiluted Foreground Scores**:
   Foreground pixels $P_{fg}$ are bounded to pixels with alpha within the ink bounding box. Background pixels outside the box cannot expand the denominator.

4. **Ink Coverage Ratio Constraint**:
   $$\text{CoverageRatio} = \frac{\min(N_{\text{rust}}, N_{\text{skia}})}{\max(N_{\text{rust}}, N_{\text{skia}})}$$
   Where $N = |\{(x,y) \mid \alpha(x,y) \ge 8\}|$. Requires $\text{CoverageRatio} \ge 0.50$. Catches single-pixel or micro-area collapse.

5. **Bounding Box Dimension Minimums**:
   Both renderers must produce an ink bounding box with width and height of at least $16 \times \text{DPR}$ pixels.

---

## Baseline Score Examples

Representative numerical scores captured from the current ABI3 baseline:

| ID | Fixture | Style | Viewport | DPR | Global Score | FG Score | FG Alpha | Coverage | Gate |
|---|---|---|---|---|---|---|---|---|---|
| `korean-390x640-1x-spicy` | Korean | Spicy | 390x640 | 1x | 99.30% | **63.11%** | 58.20% | 75.3% | `PASS` |
| `korean-390x640-1x-amll` | Korean | AMLL | 390x640 | 1x | 99.34% | **60.93%** | 55.72% | 78.3% | `PASS` |
| `korean-844x390-1x-spicy` | Korean | Spicy | 844x390 (L) | 1x | 99.35% | **63.35%** | 58.47% | 75.2% | `PASS` |
| `korean-844x390-1x-amll` | Korean | AMLL | 844x390 (L) | 1x | 99.39% | **55.64%** | 49.71% | 66.8% | `PASS` |
| `korean-390x640-3x-spicy` | Korean | Spicy | 390x640 | 3x | 99.30% | **58.61%** | 53.09% | 70.8% | `PASS` |
| `korean-390x640-3x-amll` | Korean | AMLL | 390x640 | 3x | 99.35% | **55.18%** | 49.21% | 75.9% | `PASS` |
| `latin-390x640-1x-spicy` | Latin | Spicy | 390x640 | 1x | 98.49% | **58.60%** | 53.08% | 96.5% | `PASS` |
| `latin-390x640-1x-amll` | Latin | AMLL | 390x640 | 1x | 98.36% | **51.32%** | 44.83% | 93.6% | `PASS` |
| `latin-844x390-1x-spicy` | Latin | Spicy | 844x390 (L) | 1x | 98.96% | **61.24%** | 56.08% | 96.5% | `PASS` |
| `latin-844x390-1x-amll` | Latin | AMLL | 844x390 (L) | 1x | 98.97% | **53.09%** | 46.84% | 84.8% | `PASS` |
| `latin-390x640-3x-spicy` | Latin | Spicy | 390x640 | 3x | 98.50% | **55.56%** | 49.65% | 97.1% | `PASS` |
| `latin-390x640-3x-amll` | Latin | AMLL | 390x640 | 3x | 98.39% | **46.09%** | 38.90% | 93.5% | `PASS` |

---

## Determinism and `--skip-repeat` Provenance

1. **Two-Pass Determinism (Default)**:
   Executes two independent capture passes and verifies that all 12 PNG hashes match bit-for-bit.
   Records `determinism_status: "VERIFIED_IDENTICAL_REPEAT"` and `determinism_verified: true`.
2. **Single-Pass Validation (`--skip-repeat`)**:
   Always validates complete input inventories, source closures, and packet file hashes on disk.
   Explicitly records `determinism_status: "SKIPPED_SINGLE_PASS_ONLY"` and `determinism_verified: false` in all persistent JSON and markdown reports.

---

## Honest Known Unsupported Limitations

1. **Rust Baseline Lacks Style Choice**:
   The unchanged ABI3 Rust renderer does not implement distinct Spicy vs AMLL style branches. The harness pairs the same Rust baseline raster against both Skia styles and asserts that the Rust hashes are identical between style comparisons.
2. **Rust Font Provenance is Unverified System Fallback**:
   Skia loads explicit asset files (`SF-Pro-Display-Regular.otf`, `SF-Pro-Display-Bold.otf`, `NotoSansCJK-Regular.ttc`). Rust Parley resolves fonts via host system FontContext. Selected font blob digest and face index cannot be intercepted without modifying forbidden runtime files (`scene.rs` / `parity-capture.rs`). Rust font provenance is therefore explicitly labeled `UNVERIFIED_SYSTEM_FALLBACK_CANDIDATES`.
3. **Isolated Voice vs Full Native Screen**:
   Evaluates isolated active voice preparation (`NativeSkiaVoice` and `drawVoice`) at sampled playback timestamps. Full UIKit backdrop blur, native row opacity, Yoga layout, and touch interactions are excluded from this evidence scope.
4. **Future Adapter**:
   A future adapter will land after integration via backward-compatible interface without modifying the Rust capture example.
