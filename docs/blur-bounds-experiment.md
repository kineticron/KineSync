# Tight blur bounds experiment

Status: host raster parity PASS with a conservative fallback; default OFF. This is a development experiment, not a measured phone performance win or release acceptance.

Baseline: `5e76f08296ac4a99f4a4e4bcac7d708e69f47084`.
Tested implementation: `4ebb6ecdf91700c80a38ae952df64b1ca1ded238`.
Earlier implementation commits: `54311d1`, `4161b36`, `22b33b3`.
All implementation commits use Kineticron <kineticrondev@gmail.com>; no push or merge performed.

## Behavior and scope

Player menu → Developer Settings → **Tight blur bounds**. Fresh storage defaults to OFF; development choices persist. Release builds always return false and do not access this setting's storage. Changing the setting invalidates all six cached-picture early-return paths across production/development recording. Toggle-off retains the original glow `saveLayer` call and original voice props.

Enabled mode supplies local allocation bounds around the actual shaped slice clip, padded by `ceil(4 * sigma) + 2`. The saveLayer is inside the existing word and letter transforms, so it uses the actual current spring transform, not an assumed overshoot limit. No new clipping, filter quantization, draw suppression, motion buffer or retained graph is introduced. AMLL and emphasized Spicy glows use the hint. Ordinary, unemphasized Spicy glows retain their original unbounded saveLayer because changing their filtered surface changes raw transparent RGB in the host rasterizer. Existing union, mask, progressive/shared backdrop blur and attribution behavior remains unchanged.

The optimization deliberately does less than the original attempt. It does not tighten every saveLayer or native backdrop capture. Skia bounds are allocation hints; actual device surface allocation is not measured here.

## Diagnosis of all 40 original mismatches

Original result: 1,016/1,056 raw RGBA matches; maximum channel delta 255; 17,579 changed pixels. Every changed pixel has alpha **0 in both images**. All nonzero-alpha pixels and alpha values match. The original mismatches were reproduced from `22b33b3` and classified individually in `mismatch-diagnosis.json`.

The affected fixture is Latin Spicy, foreground and background, at widths 260 and 650, during reveal/mid/emphasis/peak/late/end/pause/pause-repeat/seek-back/resume. There are no original AMLL, Indic, Indic overlap, Arabic RTL or emoji mismatches. There is no evidence of visible clipped tails, shifted transforms or spring/emphasis clipping in these differences. They are consistent with numerical changes in sub-byte filtered tails exposed by PNG unpremultiplication as white RGB at zero alpha; the exact internal Skia numerical mechanism was not instrumented.

Increasing padding from `4*sigma+2` to `8*sigma+8` still left 40 mismatches (14,704 changed pixels). Preserving only connected alpha-max groups also left the original 40 mismatches (17,579 pixels), rejecting the initial group-compositing hypothesis. Preserving the ordinary Spicy glow path removed every mismatch while retaining bounded emphasized Spicy and AMLL glows. No comparator tolerance or alpha normalization was used.

All original non-identical cases are listed below; each has max delta 255 and exclusively `(alpha_base, alpha_on) = (0, 0)`. Every one is raw-RGBA exact with the final implementation.

| Original case | Changed pixels | Final changed pixels |
|---|---:|---:|
| 260-latin-spicy-fg-reveal | 358 | 0 |
| 260-latin-spicy-fg-mid | 190 | 0 |
| 260-latin-spicy-fg-emphasis | 138 | 0 |
| 260-latin-spicy-fg-peak | 232 | 0 |
| 260-latin-spicy-fg-late | 227 | 0 |
| 260-latin-spicy-fg-end | 473 | 0 |
| 260-latin-spicy-fg-pause | 184 | 0 |
| 260-latin-spicy-fg-pause-repeat | 184 | 0 |
| 260-latin-spicy-fg-seek-back | 228 | 0 |
| 260-latin-spicy-fg-resume | 228 | 0 |
| 260-latin-spicy-bg-reveal | 358 | 0 |
| 260-latin-spicy-bg-mid | 191 | 0 |
| 260-latin-spicy-bg-emphasis | 139 | 0 |
| 260-latin-spicy-bg-peak | 232 | 0 |
| 260-latin-spicy-bg-late | 227 | 0 |
| 260-latin-spicy-bg-end | 468 | 0 |
| 260-latin-spicy-bg-pause | 186 | 0 |
| 260-latin-spicy-bg-pause-repeat | 186 | 0 |
| 260-latin-spicy-bg-seek-back | 228 | 0 |
| 260-latin-spicy-bg-resume | 228 | 0 |
| 650-latin-spicy-fg-reveal | 793 | 0 |
| 650-latin-spicy-fg-mid | 488 | 0 |
| 650-latin-spicy-fg-emphasis | 405 | 0 |
| 650-latin-spicy-fg-peak | 543 | 0 |
| 650-latin-spicy-fg-late | 606 | 0 |
| 650-latin-spicy-fg-end | 1086 | 0 |
| 650-latin-spicy-fg-pause | 540 | 0 |
| 650-latin-spicy-fg-pause-repeat | 540 | 0 |
| 650-latin-spicy-fg-seek-back | 675 | 0 |
| 650-latin-spicy-fg-resume | 671 | 0 |
| 650-latin-spicy-bg-reveal | 793 | 0 |
| 650-latin-spicy-bg-mid | 488 | 0 |
| 650-latin-spicy-bg-emphasis | 405 | 0 |
| 650-latin-spicy-bg-peak | 543 | 0 |
| 650-latin-spicy-bg-late | 606 | 0 |
| 650-latin-spicy-bg-end | 1086 | 0 |
| 650-latin-spicy-bg-pause | 540 | 0 |
| 650-latin-spicy-bg-pause-repeat | 540 | 0 |
| 650-latin-spicy-bg-seek-back | 675 | 0 |
| 650-latin-spicy-bg-resume | 671 | 0 |

## Full raster parity and visual review

Final toggle ON: **1,056/1,056 exact**, max delta 0, changed pixels 0 (`raster-comparison.json`).
Final toggle OFF: **1,056/1,056 exact**, max delta 0, changed pixels 0 (`raster-comparison-off.json`).

The suite covers six fixtures (Latin ligatures/wrapping, Indic, Indic emphasis, connected Indic overlap, Arabic RTL and emoji fallback), two renderers, foreground/background voices, widths 260/650 and 22 saved stages per combination. It integrates deterministic spring/float state through 120 active frames and 90 release frames and saves future, attack, early/reveal/mid/emphasis/peak/late/end, pause/repeat, release early/mid/late/settled, seek forward/back, resume, end-active, sung and future-again. Noninteger translation and scales 0.91/1.137 exercise transformed device bounds. Baseline and final comparisons use strict decoded RGBA equality before background composition.

Visually inspected all six paired contact sheets: `contact-{260,650}-{emphasis,release-mid,seek-back}.png`. Baseline/on glow edges, letter placement, emphasis motion, Indic headline overlap, reveal and RTL placement match. This review supports the host verdict only. The emoji appears as a simplified disc in both host outputs, so this does not establish detailed phone color-emoji fidelity. The two widths model portrait/landscape text layout; this suite does not rotate a mounted phone screen. It does not prove full-screen simultaneous voices, physical-device GPU output, fallback-font coverage beyond these fixtures, or all possible spring histories.

The progressive/shared-blur regression separately passes source/hook checks for both styles, portrait/landscape, scrolling, translations and attribution protection. There is no new shared-blur or attribution rendering path in this experiment.

## Layer count and area

Summed over the 1,056 saved host cases (not per-frame or native allocation measurements):

| Metric | Baseline | Enabled |
|---|---:|---:|
| saveLayer calls | 9,040 | 9,040 |
| Glow layers | 1,384 | 1,384 |
| Calls with explicit bounds | 704 | 1,908 |
| Total clipped bounds/clip area proxy, px² | 263,118,378 | 205,337,640 |
| Glow area proxy, px² | 149,406,076 | 91,625,338 |
| Spicy total area proxy, px² | 180,506,009 | 155,593,967 |
| AMLL total area proxy, px² | 82,612,369 | 49,743,673 |

Total area proxy decreases 21.96%; glow area proxy decreases 38.67%. This instrumentation transforms each supplied bound into device coordinates and intersects its enclosing rectangle with the current device clip; unbounded layers use that clip. It does not inspect Skia's actual offscreen allocations, filter expansion, memory or GPU passes. Layer counts are unchanged.

## Validation

- `npm test`: PASS, final subprocess exit 0 in `mobile-tests-exit.txt`.
- `npm run typecheck`: PASS.
- `npm run lint`: exit 0, 0 errors and 13 existing warnings.
- `npm run test:blur-bounds`: PASS; separately Babel-transformed helper dependencies are serialized recursively and executed in an isolated UI-like VM. Also covers default OFF, persistence, release gating, load/write races and cache invalidation coverage.
- `npm run test:lyrics-native`: PASS, including native motion, shaping, masks and gradient cache.
- `node scripts/check-spicy-progressive-blur.cjs`: PASS.
- Additional switch-clock suite: diagnostics PASS, then `check-native-switch-clock.cjs` fails loading expo-blur's extensionless `build/BlurView` in Node. Reproduced independently at baseline 5e76f08; not fixed in this experiment.
- Additional translation suite: toggle and incremental checks PASS; translation-scroll harness rejects `@/lib/fast-lyric-loading`. Reproduced independently at baseline 5e76f08; not fixed in this experiment.
- DesktopBridge unchanged; no DesktopBridge checks required. `git diff --check` PASS.

## Sole phone development server

Exactly one Expo server was verified: PID 31591, worktree `/home/kit/.t3/worktrees/repo/perf-blur-bounds/ExpoLyrics`, port 32989; its ngrok child is PID 31700. HTTPS: **https://mwlomws-anonymous-32989.exp.direct**.

The existing safe launcher `/home/kit/start-blur-bounds-dev.sh` and sole Expo init entry `/home/kit/.hako/init.sh` already target this worktree and random port; they were preserved on resume. No second Expo was started; bridge and T3 services were preserved. HTTPS iOS manifest and full bundle were fetched successfully. `bundle-verification.json` records the bundle hash and confirms the setting label, bounds helper and final conservative condition are present. A dev client must support the installed native dependencies; serving a bundle does not establish a successful phone run.

## Reproduction and evidence

Evidence directory: `/home/kit/kinesync-perf/blur-bounds/`. Final images are `raster-base`, `raster-on` and `raster-off`; intermediate rejected attempts are retained in `raster-expanded-padding` and `raster-conservative`. Old `final-on`/`final-off` benchmark results predate the conservative correction and must not be used as final performance numbers.

Full multilingual raster harness: `raster-worker.cjs` and `raster-suite.cjs` in the evidence directory. Set `PERF_ROOT` to the selected ref's ExpoLyrics directory and `TIGHT_BLUR=true` or `false`; run Node with `--font /home/kit/shirorekha-evidence/NotoSansDevanagari-Bold.ttf`, `--rtl-font /home/kit/ci-run16-readiness-review-evidence/baseline/xpra-client/Xpra-Light-x86_64_6.5.3-r0/share/fonts/TTF/DejaVuSans.ttf`, `--emoji-font /home/kit/kinesync-perf/retained-renderer/NotoColorEmoji.ttf` and `--out DIRECTORY`. Leave `RASTER_LABEL` unset for all 1,056 images. `compare-rasters.py` compares `raster-base` and `raster-on`; set `RASTER_ON_DIR=raster-off RASTER_REPORT=raster-comparison-off.json` for disabled mode.

The deterministic perf CLI was read with `--help` and its README. It already accepts the `tightBlurBounds` component prop, so no CLI extension was necessary. Final invocation:

```sh
/home/kit/perf-compare/perf-compare 5e76f08 4ebb6ec \
  --repo /home/kit/.t3/worktrees/repo/perf-blur-bounds \
  --mode tightBlurBounds=true \
  --out /home/kit/kinesync-perf/blur-bounds/verified-on
```

## Performance measurements

Final deterministic run: 1,000 callback frames per case, 100 warmup frames, three independent callback mounts; reported means/p95 are medians across those repeats. CanvasKit pipeline sampled at frames 30, 304, 680 and 980, one warmup and three measured draws per sample; table pipeline values are the CLI's median of sample medians (upper median for four samples). Latin performance fixture only; this is separate from the 1,056-image multilingual acceptance suite. Final perf visual gate: 32/32 snapshots exact, max delta 0, changed pixels 0. Runtime 102.9 seconds. Raw trials, native-source/package/lock/font hashes and pipeline stages are in `verified-on/report.json` and its A/B artifacts.

The callback is the host-mocked execution of a **UI-runtime worklet**, including original picture recording. It is not an RN JS-thread measurement and not measured phone UI time. The downstream pipeline proxy is installed Skia JS command replay plus CanvasKit CPU parent-picture record/raster/flush; it is not actual native iOS/Android CPU recording or phone GPU timing.

| Case | Callback mean ms, base → ON | Callback p95 ms, base → ON | Host pipeline proxy ms, base → ON |
|---|---:|---:|---:|
| 260-spicy-fg | 0.707 → 0.789 | 1.256 → 1.509 | 53.58 → 38.54 |
| 260-spicy-bg | 0.690 → 0.819 | 1.129 → 1.391 | 51.59 → 42.51 |
| 260-amll-fg | 1.066 → 1.225 | 1.754 → 1.927 | 35.32 → 25.65 |
| 260-amll-bg | 1.016 → 1.059 | 1.675 → 1.884 | 34.05 → 27.74 |
| 650-spicy-fg | 0.709 → 0.763 | 1.148 → 1.303 | 55.19 → 37.75 |
| 650-spicy-bg | 0.653 → 0.684 | 1.008 → 1.226 | 62.26 → 39.91 |
| 650-amll-fg | 1.094 → 1.234 | 1.879 → 2.153 | 34.53 → 24.82 |
| 650-amll-bg | 1.120 → 1.144 | 1.899 → 1.741 | 41.41 → 26.27 |

CanvasKit pipeline proxy decreases in all eight cases; callback mean increases in all eight. Per-frame bounds computation and bounds/SkRect creation add work; instrumented app objects rise from 45,163 to 47,115 in each Spicy case and 21,272 to 23,312 in each AMLL case over the callback sequence. App picture counts remain 808 for Spicy and 1,000 for AMLL. These counts exclude library, engine and native allocations. The measured callback regression must not be hidden by the downstream proxy improvement. No sustained, order-balanced device/end-to-end performance win is established.

**Phone RN JS thread: unmeasured. Phone UI-runtime callback/native recording: unmeasured. Phone GPU/compositor/frame pacing/memory: unmeasured.** Host timings vary with load, engine warmup and fixed A-then-B order. Keep the toggle OFF by default and require real-device traces and full-screen visual acceptance before considering adoption. The corrected host experiment is not rejected for parity, but it remains unapproved for production enablement.

