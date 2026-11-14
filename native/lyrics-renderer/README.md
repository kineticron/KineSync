# Linux Rust lyric renderer spike

The branch also contains the phase-2 live iOS integration described in
[INTEGRATION.md](INTEGRATION.md). The phase-1 benchmark/report below records the
original host experiment, not measurements of the current iOS client.

Phase 1 is a headless Linux experiment on branch `rust-renderer-spike`, based on
`origin/development` at `ca05b01` (v1.2.8). Plain **wgpu + Vello + Parley**, no
GPUI. It renders one existing real-song fixture with timed syllable fill, shared
GPU distance blur, a sharp next line and portrait/landscape PNG capture. It is
not integrated into the app, and supplies no evidence about phone performance.

See [DESIGN.md](DESIGN.md) for the proposed iOS/Android view boundary and Expo
custom-development-client build/lifecycle plan. See [REPORT.md](REPORT.md) for
measurements, visual evidence and limitations.

## Reproduce on this host

The working directory for every command below is
`/home/kit/rust-renderer-spike/native/lyrics-renderer`. There is no workspace-level
Cargo manifest. Keep the repo's existing fixture at its original relative path.
Use the explicit toolchain because this host has no rustup default:

```bash
cd /home/kit/rust-renderer-spike/native/lyrics-renderer
# Already installed on the rescue host; needed for a new Ubuntu host:
sudo apt-get install -y pkg-config libfontconfig1-dev fonts-noto-cjk libvulkan1 mesa-vulkan-drivers
export PATH=/home/kit/.cargo/bin:$PATH
# Select exactly the software Vulkan ICD used for these measurements.
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json
export CARGO_BUILD_JOBS=2
cargo +1.97.0 build --release --locked
cargo +1.97.0 fmt --check
cargo +1.97.0 test --locked
cargo +1.97.0 clippy --locked --all-targets -- -D warnings

# Twelve frames, six real-song timestamps per orientation:
target/release/lyrics-renderer gallery /files
# Sharp control uses the identical compositor with blur weight disabled.
# It still runs filter passes, so it is not a no-blur performance baseline.
target/release/lyrics-renderer 390 844 17500 /files/rust_spike_sharp_control.png --no-blur
# 120 samples/orientation after 12 warmup; PNG encoding excluded from timings.
target/release/lyrics-renderer bench evidence/benchmark.json 120 12 /files

# Optional verification/chart scripts use the host's Pillow and matplotlib:
python3 scripts/verify_images.py /files
python3 scripts/plot_benchmark.py evidence/benchmark.json /files/rust_spike_benchmark_chart.png
```

No display server, browser, UI server or running app/dev server is needed.
For a single arbitrary capture:

```bash
target/release/lyrics-renderer 390 844 33400 /files/rust_spike_custom.png
```

Arguments are width, height, track time **milliseconds**, PNG path; dimensions
are raster pixels, not an automatic phone device-pixel-ratio conversion.
`--help` lists commands. Inputs to the CLI must be finite; dimensions are bounded
at 128..4096. Render frames are deterministic snapshots, not recordings of native
playback or scrolling.

## Pinned dependencies and APIs

Direct versions: Vello **0.12.0**, wgpu **30.0.0**, Parley **0.12.0**, pollster
**0.4.0**, png **0.18.1**, roxmltree **0.21.1**, serde **1.0.229**, serde_json
**1.0.151**. The committed Cargo.lock pins all transitive versions (including
wgpu-core/hal/types 30.0.1 and Peniko 0.6.1). Rust/cargo **1.97.0** was used.
Host fonts and Mesa are system dependencies, not Cargo-managed assets.

Versions were resolved with `cargo +1.97.0 info vello` / `info parley` and the
actual downloaded registry Cargo.toml and source; no guessed cross-version APIs.
The implementation follows the pinned [Vello source](https://docs.rs/crate/vello/0.12.0/source/src/lib.rs),
[Parley layout API](https://docs.rs/parley/0.12.0/parley/), and
[wgpu API](https://docs.rs/wgpu/30.0.0/wgpu/). In particular wgpu 30 uses
`InstanceDescriptor::new_without_display_handle()`, fallible mapped ranges,
and Parley normalized coordinates must be converted to their i16 bits for Vello.

## Fixture and font provenance

The only lyric source is the repository's existing
[`ZZA0P2622376.ttml`](../../DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml):
**seesaw (Feat. IU), Crush**, ISRC ZZA0P2622376. The fixture's
[existing provenance README](../../DesktopBridge/test/fixtures/lrc-red/README.md)
records an unmodified lrc.red response captured in the October 29, 2026 audit.
The crate includes that file directly at compile time; no lyric file was fetched,
modified, synthesized or duplicated. We render all 42 lead lines, preserving
source atom timings and literal spaces; translations and duet-agent presentation
are not yet implemented. Byte ranges refer to UTF-8 text built from the spans.

### Historical phase-1 simultaneous-line limitation

Phase 2 now highlights/protects all overlapping lead intervals. The description
below records the original phase-1 limitation. Background voices and duet layout
remain outside this experimental renderer's fidelity scope.

Only the latest started line receives timed highlighting and active blur
protection; scroll focus is also that single line. **Simultaneously singing
lines are not supported.** This affects timing, not just duet alignment:
fixture L18/L19 overlap during 88009–88483 ms. At **88200 ms**, L18's final
atom is still singing, but L19's start has already removed L18's timed reveal
and active protection. Likewise, L34/L35 overlap during 136445–136555 ms;
at **136445 ms**, L35 replaces L34's highlighting/protection even though L34
has not ended. Earlier overlapping lines become dim and eligible for distance
blur. Source timing data is retained, but fixture-wide simultaneous highlight
fidelity is not implemented. A future version must track all active intervals
for reveal/protection separately from the single scroll-focus index. The short
benchmark/gallery window does not validate these overlaps.

Fixture SHA-256:
`040d3d229bc0289c29bbbbab661e863414279b6e1e62b3a39f6a754bcfc4827e`.

Parley uses system **Noto Sans CJK KR**, requesting weight 800; Fontconfig on this
host resolves the installed Noto CJK bold collection. `fonts-noto-cjk` version
`1:20230817+repack1-3`; bold collection path
`/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc`, SHA-256
`faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb`.
The font is not copied into the repository. Layout reports **671 glyphs and zero
missing glyphs** in both orientations and aborts if any glyph ID is zero.
Korean glyphs were also visually inspected in the output PNGs.

## Implementation map

- `src/lib.rs`: existing TTML fixture, timing atoms, progress/focus/anchor math,
  boundary/pause/seek/rate tests.
- `src/scene.rs`: whole-line Parley shaping cached at construction; Vello glyph
  scenes and per-atom visual rectangles retained across frames. Active syllables
  reveal independently, splitting reveal width across wrapped fragments.
- `src/gpu.rs`: headless Vulkan adapter, Vello raster, retained blur textures and
  bind groups, shared compute passes, optional timestamp queries, PNG readback.
- `src/blur.wgsl`: separable normalized Gaussian near/far filters (sigma 2.5/6 px).
- `src/composite.wgsl`: protected active+next band, 60/100/60 px near/cross profile,
  viewport edge fade.
- `src/main.rs`: single capture, gallery, release benchmark and raw JSON results.

On the first meaningful frame and significant fill/blur/landscape/benchmark
milestones, PNG paths and notes are appended to
`/home/kit/rust-renderer-milestones.jsonl` for the coordinator. These are milestone
notifications from this implementation run; reproduction commands do not append
duplicate notifications. PNGs are exported to `/files/rust_spike_*.png`, not
committed as downloaded or bundled song assets.
