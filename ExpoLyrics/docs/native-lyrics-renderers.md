# Native lyrics port: experiments and validation

Branch: `feat/native-lyrics-renderers`.

This is an experimental port of both Spicy and AMLL. **Full visual parity is not
complete and the production default remains the existing WebViews.** Set
`EXPO_PUBLIC_NATIVE_LYRICS=1` when starting Metro to select the native platform
hosts. Web retains the reference implementation. The native hosts currently
select FlashList with native Skia paragraphs to reproduce the reference's
gradients, glow and per-letter animation. Clip and software mask implementations
remain available in the lab for comparison; they do not provide visual parity.

## Reference fidelity work (October 11)

The bundled WebViews are the visual authority. Reference computed CSS, matching
paused timestamps, and Android motion recordings are used alongside source
comparisons. Real API lyrics can be frozen with `fixture=live`; this snapshots
already fetched lyrics without seeking or changing Spotify playback. The lab's
development-only `nativeLyricsParityArm(position, playing)` starts either host
after recording has begun.

- Spicy uses the original cubic splines, analytic spring integration, letter
  falloff, glow coefficients and follow-scroll easing/duration. Flagged word
  gaps are measured as 0.32ch; literal provider spaces keep their own advances.
  Inactive paint follows computed leaf styles (shadow only, including the leaf's
  0.5 unsung alpha), rather than assuming inherited line alpha is the final paint.
  Computed CSS also distinguishes background text size (75%) from its line
  spacing (62%). Joined-syllable pivots follow selector specificity and RTL
  overrides. Formatting controls are removed only from paint data; ZWJ/ZWNJ and
  original provider/callback objects are preserved.
  Flex wrapping counts trailing gaps, retains word-group boundaries, and updates
  paint offsets after inserted breaks. The sustained 46.1-second comparison
  caught the paragraph wrapper dropping a gap and fitting an extra word.
- AMLL uses the bundled CJK timing split and line-balancing policy. Native Skia
  measures shaped ranges instead of DOM boxes. Hermes lacks Intl.Segmenter, so
  the FormatJS implementation supplies word boundaries; its CJK boundaries still
  need comparison with the WebView's ICU dictionaries across languages.
  The lane follows `.2em` padding on both sides; songs with duet lines replace
  the far-side padding with 15% of the lane. Landscape uses the reference's
  inverted duet flag. Explicit paragraph struts keep fallback-font baselines
  aligned with the primary font's line box. A real QQ QRC Korean fixture caught
  both the excessive lane inset and a six-pixel fallback baseline displacement.
- AMLL word float, sampled letter emphasis, line scale and asymmetric alpha
  filtering use the reference equations. Follow-scroll uses independent row
  springs and stagger delays instead of Android's platform scroll animation.
  On disable, word float reverses from its clamped animation endpoint at elapsed
  time speed, including while playback is paused. Background vocals have their
  own collapse/slide/opacity wrapper and the reference main-text padding.
- The native list moves once per follow target; UI-thread transforms animate
  the residual displacement. No per-frame scroll positions enter React state.
  Canvas cells consume a precomputed discrete UI playback window, avoiding React
  cell updates at activation. Experimental clip/mask/tree cells receive semantic
  invalidation. Shared scroll bookkeeping stays
  on JS without synchronous reads of UI shared values.

`test:lyrics-native` now includes a comparison against the bundled reference:
7,505 spline samples, 3,600 Spicy spring frames, AMLL spring solver trajectories,
word float, CJK timing atoms, and synthetic/literal gap handling. These tests
verify equations and data policy, not complete visual parity. Recordings caught
additional activation and scroll reconciliation bugs, so the earlier performance
tables below describe the earlier prototypes and must not be presented as
measurements of the current fidelity implementation.

## Architecture

- One Reanimated UI clock projects playback anchors; playback position ticks do
  not subscribe React or cross into JS each frame. Focus and AppState suspend it.
- A binary search over precomputed cue boundaries schedules JS only when the
  semantic playback window changes. Overlaps, background voices and pauses use
  the existing timing planner. Late callbacks from a previous lyric array are
  ignored.
- Both FlatList and FlashList use the same memoized row model. FlashList uses
  recycling-aware local state/mapping keys and separate item types. No scrolling
  coordinates enter React state. Native scrolling owns gestures; a user touch
  disables following, and a subsequent layout change cannot restore it.
- Original line objects reach press/long-press callbacks. Unicode cluster repair
  and the reference AMLL spacing policy precede layout. Provider fragments in an
  Arabic word remain in one shaping run.
- Static lyrics use separate typography without distance blur or a ticking
  clock. Credits include writer/provider/community labels and linked attribution
  profiles with avatars. Their final measured scroll geometry is still open.
- The transform clip experiment uses native Text and two opposing transforms,
  avoiding animated layout width. A software MaskedView experiment tests feathered
  reveals. Neither reproduces all reference effects.
- The Skia candidate shapes the entire paragraph, visits its glyph runs including
  fallback fonts, and batches gradient/glow glyph draws into one native picture
  per voice. Spatial ink intersection and clipping preserve wrapped final glyphs
  and ligatures without relying on problematic native cluster indices. Settled
  voices cache their pictures. This removes per-letter React/Skia mask trees;
  `reveal=tree` retains that earlier implementation for comparison. Exact visual
  parity across all fonts, directions and lifecycle states is still unfinished.
  Skia is a native drawing engine,
  without a browser; it adds a native dependency and requires a rebuilt client.

Paused active voices also reuse their picture once word springs and line alpha
settle. Inactive AMLL float release continues on elapsed time until it reaches
rest, so caching does not truncate the reference's completion motion.
The final settled-paused Korean fixture captures recorded just one presentation
in each eight-second window (`spicy-paused-final`, `amll-paused-final`); this is an
idle check, not a playback FPS score or a physical-device battery measurement.

The signed-in main-player pass on October 11 covered fresh QQ QRC Korean lyrics
(`STOPLIGHT`, 45 lines) and subsequent live track replacement (`back of the club`,
35 lines), in both native styles. Sanitized network inspection observed successful
Spicy, LrcLib, Kugou and artwork responses; Spotify metadata also returned 429 and
some QQ search endpoints returned 500, while provider fallback loaded lyrics.
No credentials, cookies, request headers or lyric response bodies are recorded.
Original renderer preference and automatic playback-control hiding are restored
after the comparison. This pass does not certify every navigation/gesture state.

The choices follow [React Native list guidance](https://reactnative.dev/docs/optimizing-flatlist-configuration),
[Reanimated performance guidance](https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/),
and [FlashList recycling guidance](https://shopify.github.io/flash-list/docs/fundamentals/performance/).
Shopify's [FlashList v2 account](https://shopify.engineering/flashlist-v2) and
Discord's [mobile performance account](https://discord.com/blog/supercharging-discord-mobile-our-journey-to-a-faster-app)
motivated testing list alternatives rather than assuming a particular list wins.
Skia's [paragraph API](https://wcandillon.github.io/react-native-skia/v2/docs/text/paragraph/)
provides full text shaping and range bounds.
Native display lists use Skia's [picture API](https://wcandillon.github.io/react-native-skia/v2/docs/shapes/pictures/)
and [glyph drawing API](https://shopify.github.io/react-native-skia/docs/text/glyphs/).

## Batched drawing experiment (October 11)

Signed-in main application, real 58-line Ken Carson API result, isolated lab
clock starting at 18,876 ms; 12-second BlueStacks recordings. These are single
debug runs on the emulator's synthetic 240 Hz display, before the final
background-padding and joined-pivot corrections. They are not release benchmarks.

| AMLL implementation | Presented FPS | Presentation interval p95 | JS delay p95 |
| --- | ---: | ---: | ---: |
| Retained glyph/mask tree | 10.49 | 112.50 ms | about 248 ms |
| Batched glyph picture | 104.53 | 20.83 ms | 16.89 ms |

The corresponding Spicy batched run presented 85.94 FPS with 20.83 ms interval
p95 and 15.30 ms JS delay p95. Evidence is in `.cache/performance/amll-offset-sync`,
`amll-glyph-batch`, and `spicy-glyph-batch`, with matching motion recordings.
The retained tree was rejected because it stalled under the full animation
workload. FPS measures compositor presentation, not a guarantee of visual parity.
Memory reflects sequential debug runs and CPU tick deltas are not normalized.

A later refined run on the same fixture recorded Spicy 102.39 presented FPS /
16.67 ms presentation p95 and AMLL 90.07 FPS / 25.00 ms p95
(`spicy-parity-refined`, `amll-parity-refined`). These runs preceded the final
Spicy flex-wrap and AMLL background-stagger adjustments. The lab now supplies
the actual fixture duration to both reference hosts; their default demo duration
of 25 seconds had clamped comparisons at later timestamps. Earlier reference
captures beyond that cap are invalid. Initial playback comparisons below 25
seconds and native-only metrics are unaffected by that reference-host cap.

## BlueStacks playback measurements

Measured October 10, 2026 on BlueStacks Nougat32, Android 7.1 / SDK 25, x86.
Same deterministic 100-line fixture, translations and background vocals enabled;
3 seconds warmup followed by roughly 12 seconds capture. Figures are single-run
exploratory debug measurements, not a release performance claim.

| Style | List / reveal | JS delay p95 ms | Process CPU ticks | Presentation interval p95 ms |
| --- | --- | ---: | ---: | ---: |
| Spicy | WebView reference | 12.80 | 2015 | 12.50 |
| Spicy | FlatList / clip | 5.51 | 557 | 4.17 |
| Spicy | FlashList / clip | 5.38 | 515 | 4.17 |
| Spicy | FlashList / software mask | 5.28 | 761 | 4.17 |
| Spicy | FlashList / Skia | 6.75 | 493 | 12.50 |
| AMLL | WebView reference | 40.91 | 1781 | 45.83 |
| AMLL | FlatList / clip | 5.41 | 530 | 4.17 |
| AMLL | FlashList / clip | 5.55 | 520 | 4.17 |
| AMLL | FlashList / software mask | 5.13 | 778 | 4.17 |
| AMLL | FlashList / Skia | 7.19 | 487 | 12.50 |

Software masking used about 48–50% more process CPU ticks than FlashList clipping
in these runs. FlatList and FlashList were close. Skia restores more effects, but
its presentation cadence differs and the emulator emits repeated EGL context
warnings. No final winner is established: the clipped candidates do less visual
work than the references, and the Skia candidate is not yet visually equivalent.

During ten alternating native swipes over the same 12-second workload:

| Style | List / reveal | JS delay p95 ms | Process CPU ticks |
| --- | --- | ---: | ---: |
| Spicy | WebView reference | 7.76 | 1728 |
| Spicy | FlatList / clip | 6.88 | 811 |
| Spicy | FlashList / clip | 11.88 | 724 |
| Spicy | FlashList / software mask | 11.90 | 832 |
| Spicy | FlashList / Skia | 11.50 | 659 |
| AMLL | WebView reference | 26.31 | 2255 |
| AMLL | FlatList / clip | 7.38 | 792 |
| AMLL | FlashList / clip | 8.66 | 714 |
| AMLL | FlashList / software mask | 12.19 | 860 |
| AMLL | FlashList / Skia | 10.32 | 673 |

FlatList showed lower JS delay under these swipes while FlashList clipping used
fewer CPU ticks. This tradeoff is why the list backend remains configurable.

With deliberate 150 ms JS stalls every second, Skia's presentation interval p95
remained 12.50 ms for both styles, matching its normal playback captures. JS delay
p95 rose to 112.08 ms (Spicy) and 116.57 ms (AMLL), as expected. The reference
intervals were 12.50 ms and 54.17 ms respectively. This supports continuing with
UI-thread word animation; it does not prove boundary activation or follow-scroll
is independent of JS. Those semantic changes still schedule JS work and can be
late while JS is blocked.

Do not interpret these intervals as whole-app FPS. SurfaceFlinger reports a
synthetic 240 Hz display; framestats has a bounded history and measures native
frames, not every lyric surface independently. CPU ticks are raw deltas, not
percent utilization. Memory includes retained engine/process resources from
sequential runs. Emulator battery output is simulated. Repeat randomized cold
launches in an optimized build and on physical Android/iOS devices after parity.

## Reproduction

The user's existing installation was preserved. The test package is
`dev.kineticron.KineSync.performance`, installed side by side for the initial
measurements below. The main app's API 25 ExpoSQLite registration failure was
fixed by enabling the NIO desugaring artifact, and the original package was
updated with the matching signing key while preserving user data. Subsequent
fidelity comparisons run in `dev.kineticron.KineSync` with the signed-in session
and real API lyrics. The historical tables cover the isolated renderer workload.

```powershell
# ExpoLyrics/android, x86 BlueStacks; existing init script handles long Windows object paths.
.\gradlew.bat :app:assembleDebug '-PreactNativeArchitectures=x86' '-PkineSyncPerformanceSideBySide=true' '-Djavax.net.ssl.trustStoreType=Windows-ROOT' '-Djavax.net.ssl.trustStore=NONE' -I ../../scripts/android-short-object-paths.gradle --console=plain

# ExpoLyrics, in another terminal:
$env:EXPO_OFFLINE='1'
$env:KINESYNC_ISOLATED_LYRICS_LAB='1'
npx expo start --localhost --port 8086
adb -s 127.0.0.1:5555 reverse tcp:8086 tcp:8086
# Open the development client against http://127.0.0.1:8086 first.
$env:KINESYNC_PERFORMANCE_PACKAGE='dev.kineticron.KineSync.performance'
npm run profile:lyrics-native -- 127.0.0.1:5555 both playback
npm run profile:lyrics-native -- 127.0.0.1:5555 both scroll
npm run profile:lyrics-native -- 127.0.0.1:5555 both stall --canvas-only
```

The lab supports `backend=webview|flat|flash`, `reveal=clip|mask|canvas|tree`,
`renderer=spicy|amll`, `lines` (up to 2000), `position`, `paused=1`, and `stall=1`.
`fixture=static` supplies untimed text. `--parity-candidates` compares the WebView
reference and Skia; `--canvas-only` runs Skia alone.
The stall workload blocks JS for 150 ms each second. Measurements stream logcat
before launch, verify a unique readiness marker, save screenshots and merge
results into `.cache/performance/native-lyrics/<scenario>/comparison.json`.
Raw Android captures are under `.cache/performance/native-lab-*`.

Both 2000-line Skia playback workloads completed: JS delay p95 was 6.73 ms for
Spicy and 7.49 ms for AMLL, with 493/490 CPU ticks and 12.50 ms presentation p95.
These were playback at the beginning of the document, not a full traversal of
all 2000 lines. Paused Skia captures used 29/37 CPU ticks versus 28/33 for the
references; no continuing presentation cadence was recorded while settled.

## Required before switching the default

- Match reference geometry and fonts in portrait, landscape, previews, font
  scales, translations, mixed-direction text and long wrapped lines.
- Verify the ported spring/spline and letter-emphasis equations visually across
  completed-word states, overlaps, long emphasis and pause/resume transitions.
- Match measured scroll anchoring, credits end position, attribution profiles,
  pause indicators, static/empty/instrumental states and accessibility.
- Compare deterministic paused timestamps and animation videos against both
  references. Current visual inspection confirms effects render, not full parity.
- Validate seek, track replacement, navigation, background/resume, manual scroll,
  callback semantics and 2000-line workloads in the complete application.
- Resolve emulator graphics warnings and repeat release/device profiling with
  equivalent effects before choosing the final list/drawing combination.

`npm run test:lyrics-native` checks Unicode shaping inputs, spacing, background
blocks, timing progress, seeks and preservation of callback object identity.
It also steps the actual bundled Spicy word/letter animator alongside the native
implementation, including the exclusive end boundary and completed-letter tails.
The existing `npm run test:lyrics` suite remains the reference regression check.
