# ABI4 typography runtime — safe integration checkpoint

This replaces the interrupted eager draft with a bounded on-demand path. Actual
comparison tooling remains exclusively parent/Gemini task f4169b6c owned. This
checkpoint does not claim visual parity or a new screenshot/numeric milestone.
No comparison script, CLI metric or pixel scoring code was edited in run14.
The existing one-line `examples/parity-capture.rs` mutable-binding adjustment is
included solely to keep the mutable runtime API compile-compatible; it still
uses the legacy constructor and **must not be called a two-style capture**.

## Runtime behavior

- ABI4/schema4 carries distinct Spicy/AMLL style, fontScale/orientation, original
  atoms and actual production paint words/UTF16 offsets/graphemes/group joins.
  Existing JS model and Unicode segmenter/Intl/FormatJS helpers prepare immutable
  metadata only; no JS animation tick. Rust validates surrogate boundaries,
  original text/offsets, grapheme segmentation via ICU, gaps and timing. Zero-
  duration source normalization may extend a prepared word by at most1ms; original
  source atom timing is retained separately.
- Exact existing SF Pro Regular/Bold bytes are packaged via CocoaPods resources,
  read/cached on the Swift worker, validated by SHA256/family/OS2 weight/role and
  registered once per native owner. No new font asset or restricted OS font was
  copied into the repo. Missing resources fail visibly rather than silently using
  a substitute. C/JS/Swift guards all require ABI4; KRMetrics stays152 bytes.
- Spicy sizes/weights, fractional lanes, .32ch gaps and joined wrapping are distinct
  from AMLL sizes/weights, insets, duet width and balanced line-break costs. Exact
  source-derived policies, whitespace remaps and UTF8/UTF16 mapping pass54 golden
  cases from actual production helpers, with source/fixture/lock hashes checked.
  This proves policy math under unit-grapheme measurements, not matched rasterizer
  metrics or native Yoga layout.
- Detailed timed fragments are built only for simultaneous active leads and next
  two rows. Visible inactive rows use cached plain paragraphs/white scenes and
  never build timed glyph slices on first display. Paragraph shaping still occurs
  when a previously unseen plain row becomes visible; it is required to render
  its text. The whole future track is not eagerly shaped. Previously prepared
  timed geometry can remain immutable in the bounded row cache; no rejected
  active-picture cache or epsilon redraw gating is introduced.
- Row preparation happens on window changes; stable frames reuse scene/buffers.
  Far paragraph/glyph ownership is evicted while measured heights persist. At
  most three inactive viewport/style/source scenes are cached per owner, plus the
  current scene. Keys include track identity, all original timing/text and paint
  metadata, actual immutable font digests, style/settings, DPR and extent.
  Rotation/style switches can reuse an exact key; changed inputs cannot reuse it.
- `copyLayout()` requests diagnostics asynchronously and explicitly after rendering;
  it is not per-frame JS work. Sparse receipts contain actual selected font byte
  SHA256, TTC index, family/subfamily/PostScript, requested attributes, normalized
  variation coordinates, dimensions and static geometry. Unprepared rows are null.
- Device cache/slice restrictions and phone opt1/debug1 build settings remain.
  Native caches now include bundled font inputs; final app proof rejects missing,
  duplicate or changed font bundles. Existing IPA ZIP byte verification carries
  those checked resources through packaging. No IPA was built here.

## Preserved baseline and validation

Shared half-size blur/full-size sharp, premultiplied transparency, GPU shaders,
nonblocking two-in-flight surface ownership, analytic native clock/motion and
player controls clipping are unchanged from a9b6398. Source checks and actual
alpha/premult/blur/sharp/resize readback at1x/3x pass. Existing pause/seek/rate,
completion ownership and variable-dt tests pass. A cache-height change remaps the
scroll coordinate before sampling, preserving its trajectory rather than replaying
an old target. Swift compilation remains a macOS verification requirement.

[Verification ledger](parity-typography-verification.json):26 non-budget Rust tests
plus the separately measured GPU effect test;24 Node ABI/cache/resource/C tests;
fmt, strict host/all-target and iOS Clippy, TypeScript, zero-warning ESLint,
actionlint and repository checks. A 120-frame warm scene test measures **zero
application-thread scene allocations**, without hiding shape-on-window-change
costs. Build environments disable host incremental/debug outputs only. Current
workspace storage remains bounded; no release cache or other checkout was touched.

[Raw per-effect budget](parity-typography-budget.json): exact a9b6398 source scene
is checked by SHA256 and compiled alongside the variant in the same test binary.
One Vulkan llvmpipe GPU; identical original song atoms/time/viewport/DPR/profile;
baseline and variant interleaved with alternating order,6 warmups/30 samples.
The current effect is fonts + distinct typography/layout, without new timed
appearance, glow, blur kernel or scrolling effects. Eight case/style/orientation
pairs passed the predeclared scene/encode budget. Steady scene allocation max is
1→0. Scene p50 ranges0.0310–0.0414ms baseline and0.0304–0.0408ms variant. Encode p95
ranges24.516–31.661ms variant; worst relative increase is about11%, explicitly
within the declared host tolerance, not a universal speedup. All raw samples,
per-case allocation counts, actual selected faces and thresholds are retained.
Headless render includes GPU completion/readback; throughput is labeled headless.
Native present-call throughput is null/unavailable; no phone120 claim is made.

Observed actual faces: SFProDisplay-Bold SHA a981001f… for Latin; NotoSansCJKjp-Bold
TTC index0 SHA faa5f365… for Korean. The earlier Skia host reference used the JP
Regular fallback: Korean **same-font equivalence is not established**. Do not
change a fixed reference silently to improve a score. Latin primary font bytes
match the existing source asset; raster/layout/timing still need the parent-owned
actual-source numeric comparison and final native fallback/packaging proof.

## Next work / ownership

Parent can integrate the reviewed Gemini tooling only at this clean commit
checkpoint, never by merging/resetting dirty Codex runtime edits. Its adapter must
use `Fonts::register` and `TrackScene::with_fonts(...Some(settings)...)`, then
prepare/render before reading diagnostics. Legacy `from_lines` is a baseline-only
path. No duplicated baseline under two style labels. See parity-script-ownership.md.

Timing/glow/release, style-specific scroll trajectories, translations/romanization,
BGV/duets/overlap layout, finite interludes, attribution/touch and full native Skia
capturing remain incomplete. The new layout uses source-derived geometry, not an
actual Yoga receipt. The deterministic native simulator capture implementation
is still pending; the prior plan is not an executed capture.

No intermediate phone tests or IPA deliveries gate continued work. One final IPA
only after near-complete parity and host gates. Physical device HUD/presentation
remains explicitly UNVERIFIED until the final user test. Account/rateLimits/read
was absent at every queried tool-catalog boundary; no live percentage is claimed,
no banked reset/provider switch/parallel Codex was used. Stop immediately if a
subsequent LIVE observation shows strictly less than15% remaining.
