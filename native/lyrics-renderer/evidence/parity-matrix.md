# Visual parity audit — baseline a9b6398

Audit recorded before visual implementation. Source line references below are pinned
by `parity-source-manifest.json`; they are repository-relative, not upstream guesses.
Phone acceptance reported by owner: ABI3 transparent background, smooth motion,
~1ms encode and 120 present **calls**/s. Physical scanout is not measured here.
No applicable root/ancestor AGENTS.md or CLAUDE.md exists; website/AGENTS.md is outside scope.

## Distinct targets and present gaps

`ExpoLyrics/components/lyrics/native/` abbreviated N below. Rust paths abbreviated R
are `native/lyrics-renderer/src/`. **None of the unimplemented rows is accepted parity.**

| Feature | Actual source / expected behavior | Rust at audit | Required proof |
| --- | --- | --- | --- |
| Style selection | N/native-lyrics-model.ts:12; N/native-lyric-row.tsx:93. Separate Spicy / AMLL presentation | R/scene.rs:55 fixed 34px, 800, 1.35; no style payload | same-input captures for each style; settings invalidation |
| Font ownership | N/native-lyrics-fonts.ts:5-22; existing Regular/Bold assets, immutable provider; system fallback | R/scene.rs:73 Apple sans-serif / Linux Noto CJK KR; no registered assets | hashes of actual loaded faces; packaged iOS proof; fallback discrepancy labeled |
| Sizes and weights | N/native-lyric-row.tsx:109-114; N/native-skia-voice.tsx:143-149: Spicy33.6/44.1, foreground700/background500; AMLL36 portrait/32 landscape,800; fontScale | fixed34/45.9/800 | measured baselines/ink/wraps at 1x/2x/3x, fontScale variants |
| Wrapping / gaps | N/native-skia-voice.tsx:129,150-190 invokes N/spicy-native-layout.ts:7 and N/amll-native-layout.ts:8; Spicy joined groups and .32ch gaps; AMLL balance + duet inset | Parley generic line breaks; different lane/margins | production helper execution, Latin/Korean/CJK/long group/punctuation/RTL captures |
| Unicode mapping | N/native-lyrics-model.ts:70-156 and ExpoLyrics/lib/graphemes.ts; unicode-segmenter + cluster repair, original text/timing preservation | R/lib.rs:16 byte-range atoms; no auxiliary mapping in packet | exact source UTF16/grapheme/UTF8 boundary roundtrip; established segmentation library |
| Fill / glow | N/native-glyph-picture.tsx drawVoice; N/reference-word-motion.ts:12, N/reference-motion.ts:11-15,108-112; Spicy springs vs AMLL continuous word advance/emphasis/release | R/scene.rs:195 onward simple linear clips and pulse | attack/sustain/end/release at same dt history; real glyph and glow pixels |
| Inactive appearance | N/native-skia-voice.tsx:131 and N/native-lyric-row.tsx:104-108 opacity transitions; foreground/BGV differ | fixed alpha treatment | future/past/paused release captures, brightness transition tests |
| Shared blur | N/native-shared-blur.tsx:36-54,122-159: two style profiles; measured moving active+next protection; UIKit BlurView material | optimized half-res compute blur, full-res sharp; one active/next band | actual iOS reference required for material intensity; no claim CanvasKit duplicates UIKit blur |
| Overlaps / duets / BGV | N/native-lyrics-model.ts:176,223; N/native-progressive-blur.ts:14; N/native-lyric-row.tsx:112-129: alignment flips in landscape | R/lib.rs:56 lead spans only; R/lib.rs:92 latest-started focus | simultaneous foreground/BGV/duet interval and alignment tests; protected envelope contains every moving active voice + next |
| Scrolling | N/reference-scroll.tsx:18,117; N/reference-motion.ts:87-105; distinct delayed rows, easing/springs | R/motion.rs single analytic spring; existing known-good phone behavior | recorded command/dt sequence, seek/pause/resume/rate/rotation; do not regress phone baseline |
| Translation / romanization | N/native-skia-voice.tsx:213-227; N/native-lyrics-model.ts:223; upstream selected line translation must retain exact mapping | ExpoLyrics/lib/rust-lyrics-protocol.js:14 discards auxiliary fields | settings reflow, language selection, native packet acceptance, touch extent |
| Attribution / touch | N/native-lyrics-view.tsx:408-437: credits timestamp seek, exact provider/community and maker/uploader HTTPS callbacks; N/native-shared-blur.tsx protects attribution | omitted from packet and scene; surface has no equivalent lyric touch API | actual callback tests, metadata identity, visible last-footer capture, never blur credit block |
| Interludes | N/native-interlude-motion.ts:7,33,49; N/native-lyrics-model.ts:245 onward | absent | finite gap entry/exit, no terminal endless dots, pause/seek/dt history |
| Geometry caching | N/native-geometry-cache.ts:11,36; N/native-skia-voice.tsx:139 exact font/style/width/settings keys | cached white scenes, R/scene.rs:184 allocates positions per frame | preparation counters and invalidation tests; remove per-frame positions allocation in later runtime milestone |
| GPU / transparency | R/gpu.rs, R/ffi.rs and phone-present-handoff.md | accepted ABI3 path: two bounded in-flight, no live wait, premultiplied output, transparent surface | preserve existing alpha/readback/ownership tests and CPU metrics names |

## Reference feasibility and limitations

Read-only investigation found `/home/kit/kinesync-perf/retained-renderer/REPORT.md`
and `run-pinned.cjs`: Nov9 experiment rasterizes actual production `drawVoice`
with CanvasKit0.41.0 / RN Skia2.13.1; it rejected its retained candidate. Do not
select that candidate or use its output as the current reference. Reuse the
**technique**, compile this checkout's current source, and hash the entire bundled
input graph. Current installed dependency versions must be recorded anew.

Existing checkout helpers: `ExpoLyrics/scripts/native-glyph-canvaskit.cjs` adapts
CanvasKit shaped runs to native `extendedVisit`; `check-native-glyph-paint.cjs`
exports real drawVoice/motion functions. `skia-paragraph-compositing-harness.cjs`
has mocked pixel boundaries and is **not** a screenshot reference.

The ci-sim branch resources exist in read-only baseline copies, including
`/home/kit/ci-run16-readiness-review-evidence/baseline/ExpoLyrics/lib/simulator-test-harness.ts`.
They freeze playback and await renderer/orientation/screenshot acknowledgement.
`/home/kit/ci-sim-diagnostic-implementation.md` documents runner boot diagnostics,
not lyric reference captures. No running server or other checkout is changed.

Linux CanvasKit can provide real Skia **voice** captures early, including actual
font assets, wrapping helpers, glyph drawing and style-specific appearance.
It cannot execute UIView layout, Reanimated scheduling or UIKit material blur.
A full native reference requires coordinator-run macOS simulator/device captures.
Do not substitute custom HTML, SVG, Rust output or a hand-painted scene for Skia.

Documentation lookup: chub search `canvaskit ParagraphBuilder` and `parley
FontContext` returned no results (2026-11-14). Use installed exact-version Skia
web adapter / CanvasKit type/source and locked Rust registry source, plus official
Skia / RN Skia docs as fallback. No dependency or font copying needed for audit.

## Phased plan and gates

1. **Audit + early capture harness**: commit this matrix first. Execute current
   production Skia shaping/draw code against deterministic existing TTML inputs;
   render Rust baseline with same fixture/time/viewport/DPR. Record font differences,
   source hashes, effective geometry, history/settings and scope. Produce actual
   PNG side-by-sides/differences; inspect. Stop at first meaningful screenshot
   milestone for coordinator review. No visual runtime rewrite before that review.
2. **Typography/layout**: separate style payloads, explicit font ownership with
   existing bundled assets, weights/metrics/lane/wrap policy and Unicode mappings.
   Cache immutable geometry by track/style/settings/fonts/size. Keep ABI3 unchanged
   until a reviewed transport change requires an ABI increment and native/JS/C guards.
3. **Timed appearance**: port source-specific fill/glow/release and scroll equations;
   preserve native clock, bounded GPU frames, sharp text and premultiplied path.
   Add simultaneous voice model/protection and measured moving bounds.
4. **Auxiliary features**: translations/romanization/BGV/duets/interludes/attribution,
   exact touch callbacks and settings reflow; test final row and finite gaps.
5. **Native integration proof**: reviewed matching deterministic manifests drive
   ci-sim frozen captures and Rust phone captures. Coordinator owns build/CI/Metro.
   Test font packaging, resize/disposal, controls clipping and dynamic background.

Matrix must cover both styles; portrait/landscape; DPR1/2/3; Latin/Korean/CJK;
translation/romanization/BGV/duets/overlaps; long wraps; gaps/interludes; active-next;
last line + attribution; seek/pause/restore/rotation; variable dt. Each capture must
say implemented/skipped/blocked and why. Do not silently call isolated voice proof
full screen parity. Full fmt/test/strict host+iOS Clippy, Node/TS/lint/actionlint,
alpha/premult/in-flight tests and before/after Linux proxy benchmark remain gates
for runtime changes. A new IPA/font/style packaging proof is coordinator-owned.

## Active run14 user overrides

See `parity-performance-plan.md`: lazy near-active timed geometry, cheap cached
plain inactive rows, exact invalidation across source/font/style/viewport,
per-effect comparative host timing/allocation gates, and unchanged shared GPU
blur/transparency/two-frame scheduler. Earlier intermediate phone checkpoints are
superseded: one final IPA when close to complete, no per-effect phone tests or
implementation dependency on them. Actual native Skia simulator evidence is still
required for full-screen acceptance; physical phone performance remains unverified
until the final user test.

## ABI5 live appearance checkpoint (2026-11-14)

Typography remains c08dfd2 plus validated emphasis/group transport. Source timing
65593ff now has a bounded native renderer integration with immutable glyph IDs /
positions and separately resettable owner timing. Per-effect CPU/encode/alloc
results and the enabled policy are in `parity-live-appearance-handoff.md`.
Actual GPU pixel checks prove changing fill/motion, transparent premultiplied
coverage and emission outside real glyphs; they do **not** prove Skia parity.
Glow is only a shared two-Gaussian approximation, not exact variable-radius
source filtering. Parent comparison scripts remain untouched and unmerged.

Still incomplete: source-exact glyph-ink/overlap union handling and colored glyphs;
actual Skia numeric acceptance (including font/fallback/wrap differences); native
full-viewport deterministic capture; BGV transport/layout, full duet/auxiliary
rows, translations/romanization, style scroll, finite interludes, attribution
links/touch/accessibility. Existing simultaneous foreground highlighting and
protected envelope remain; those alone are not BGV parity. No mocked reference
or duplicated baseline is accepted as a distinct style.

Latest user override permits ONE coordinator-built **parity-so-far** IPA after
independent review, and supersedes the near-complete-only delivery rule. No
intermediate per-effect phone checkpoints. Physical phone performance remains
unverified for ABI5. Start wrap-up around10% weekly remaining and target review /
coordinator IPA preparation by about5%; no15% stop or reset-credit redemption.

## ABI6 auxiliary checkpoint (2026-11-14)

Foreground translation visibility, exact source-selected text, cached paragraph
geometry, distinct Spicy/AMLL subtitle policy and row reflow are now live. The
existing sharp attribution overlay is reachable for all Rust providers and
credit-only metadata, with actual provider/maker/uploader HTTPS callbacks.
`parity-auxiliary-handoff.md` records source trace, per-feature host gate and actual
Rust glyph/premultiplied readbacks. These are not actual Skia parity scores.

BGV/group ownership and full duet/overlap layout remain incomplete. Independent
romanization selection/concurrent rows, finite interludes, source-style scrolling,
full native footer/timestamp touch, exact complex/color glyph handling and native
capture/font/performance acceptance remain pending. Existing upstream text already
selected into `translatedText` is preserved; this is not a new romanization
channel. Glow remains disabled. No comparison scripts were edited or merged.
