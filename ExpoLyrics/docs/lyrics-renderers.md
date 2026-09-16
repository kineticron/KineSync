# Lyrics renderers

Both hosts use the original native layout policy from `main`. The pure timing,
overlap, scroll-range and end-padding functions live in `lib/lyrics-layout.ts`.
`LYRICS_LAYOUT` defines the common typography. Landscape constants remain in
`constants/player-layout.ts`.

- Base text: 32px / 42px, rasterized at the original 1.05 active scale.
- Portrait: 88% text lane, 12px list inset plus 16px inner inset, 150px initial
  top padding, and active rows anchored at the viewport top.
- Landscape: 90% lane, existing list/inner insets, 168px initial top padding,
  32px active-row offset, and reversed lead/duet alignment. Only the supplied
  font scale changes text size.
- Rows retain an 84px minimum height and the original vertical padding.
  Background vocals reserve their layout space throughout playback.
- Scrolling uses the original 440ms easing, overlap ranges, manual-scroll
  thresholds and credits-aware bottom padding.

The native `LyricLine` uses one text tree per token. A soft brightness sweep
advances across grapheme spans using the original timestamps. Joining scripts
stay in a single attributed run. AMLL word float, background slide/opacity and
dot effects remain; stacked reveal/glow copies and animated text magnification
have been removed. Text is rendered at its final font size, including during
seek preview, so animation cannot change wrapping or enlarge a cached bitmap.
Native filter blur stays present on both platforms, including at zero blur, and
clears for manual scrolling.
When the lyrics route or app is inactive, the native host keeps its FlashList and
measurements mounted but unsubscribes its playback-window/scroll planners and
cancels row, background, reveal, pause-dot and list-scroll animations. Returning to
an auto-following screen resynchronizes from the current playback timestamp; a
manually scrolled screen keeps its existing position.
Pause-dot timing runs on the UI thread, without a React render on each playback
tick. Recycled rows cancel their delayed reveals and presentation animations.

Worklet helpers must be declared before their callers. Expo's production
Worklets transform captures closure values eagerly; moving the Bézier solver
below the text-lift worklets captures `undefined` and crashes on rendering with
`cubicBezierYForX is not a function`. Regression tests compile with that transform
before mounting the components. Device-level stability still requires an iOS run.

The WebView uses Spicy's word/letter runtime and effect styles inside KineSync
rows. Its original center-scroll controller and virtualizer are no longer used.
The host keeps source rows mounted to make their measured geometry independent
of animation, but only paints/animates nearby rows. During a short lyric gap, the
same upcoming row selected by the KineSync scroll planner is preactivated for
brightness/blur without advancing its real word timestamps. Settled/paused and
hidden WebViews sleep instead of polling `requestAnimationFrame`. Long songs
should still be included in device performance testing.
Animation uses display-rate frames while visible effects are moving, then sleeps
until the next cue. Measurements and timeline indexes are reused, settled styles
are not rewritten, and compositor hints are limited to nearby animated words.
The WebView projects the latest playback anchor when it becomes ready or regains
focus so an idle renderer resumes at the current timestamp.
Static lyrics use the existing native-sized static host.

## Clocks and input

Playing packets within 80ms of the projected store clock retain the existing
anchor. Track changes, play/pause changes and larger corrections update it.
Native reveal retargeting preserves the current UI value for corrections within
250ms; larger jumps and paused previews land immediately. The WebView slews
routine corrections at up to 10% of playback speed and converges even without
another packet. New lyrics, explicit seeks and preview exit reset it immediately.

The seek bar runs one linear UI animation per anchor. Store position ticks do
not restart it, and its fill uses a transform instead of changing layout width.
The thumb responds before the gesture crosses to JS; seeking uses the final
release coordinate, and canceled gestures do not seek. Hidden timelines cancel
their clock and release subscriptions. The release position is held only until
the host installs its optimistic seek anchor; there is no fixed 1.2s thumb freeze.

Native drag begin cancels auto-scroll on the UI thread. JS cancels pending
scroll retries and uses one idle timer instead of replacing it every scroll
event. The WebView cancels follow on touch start and retains manual ownership
through held touches and momentum. An explicit seek/resume releases ownership.
Settled WebView words skip spring/spline updates until their state changes.

## Refresh rate

iOS retains `CADisableMinimumFrameDurationOnPhone`. The Android
`with-high-refresh-rate` prebuild plugin requests the highest supported refresh
rate up to 120Hz at the current resolution while the window has focus, and
releases the preference when it loses focus. Display hardware, system power
settings and thermal limits still determine the actual presentation rate. See
[Android refresh-rate preferences](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#preferredRefreshRate).
The plugin needs a new native build; an OTA JavaScript update cannot install it.

## Provider spacing

Spicy's explicit `isPartOfWord` flags remain authoritative. KRC/QRC/YRC tokens
without these flags use literal whitespace to determine word boundaries. Their
trailing spaces are preserved and Spicy's synthetic word spacing is disabled,
preventing both gaps inside Korean words and double spaces between words.
The host adds no second column gap between these word groups.

The reported **XIBAL (X발), Sik-K, kugou-krc** case was downloaded from Kugou,
decoded with the desktop bridge's real KRC parser, and checked in the embedded
WebView harness (56 lyric lines). The provider splits Korean words into multiple
timed tokens and puts spaces at their ends. The downloaded lyrics stay in ignored
local fixtures; regression tests use synthetic text.

## Validation

From `ExpoLyrics`:

```sh
npm run test:lyrics
npm run build:spicy-webview
npx tsc --noEmit
npm run lint
npx expo export --platform ios --output-dir .expo/lyrics-ios-check
node scripts/preview-lyrics-renderers.cjs
```

The preview serves the exact embedded WebView HTML on `127.0.0.1:8766`, using
synthetic sample lyrics by default. Its **Run browser checks** button covers geometry, both
orientations, backgrounds, translations, static mode, seeks, follow/resume,
advance highlighting, nearby-row painting, and idle/visibility suspension.
It must be restarted after rebuilding the bundle. An optional JSON path can be
passed to load a local fixture with **Load local fixture**:

```sh
node scripts/preview-lyrics-renderers.cjs .expo/xibal-krc.json
```

**Profile 10 seconds** records browser RAF intervals and callback CPU time.
It does not measure native frames presented by the GPU. A local desktop XIBAL
run measured 0.20ms p95 callback work; this is a host-work measurement, not proof
of 120fps on a phone.
The native regression runner executes production-transformed worklets and effect
cleanup across 64 visible/hidden scenarios. Browser checks verify zero idle RAF
callbacks, gap preactivation without early word reveals, and suspension/resume.
Additional checks cover continuous clocks at simulated 60/90/120/144Hz, source
corrections, seek release/cancellation, UI drag interruption, Android plugin
idempotence, KRC spacing and settled word spring suppression.
The Android activity also passed `:app:compileDebugKotlin` with the plugin's
generated code. On this Windows host, dependency downloads required Gradle to
use the Windows certificate store (`-Djavax.net.ssl.trustStoreType=Windows-ROOT`
and `-Djavax.net.ssl.trustStore=NONE`); certificate verification stayed enabled.
These checks establish correctness and reduced work; sustained FPS, input
latency, energy use and native rendering quality require physical-device tests.

### Physical-device acceptance

Use release builds on supported 120Hz iOS and Android devices with high refresh
enabled. Capture presented frames and missed deadlines with Instruments or
Perfetto; the 120Hz frame budget is 8.33ms. Record actual refresh rate, frame
time percentiles and dropped-frame counts for both renderers. Include:

- A full song with dense syllables, sustained words, duets and background vocals.
- Rapid manual scroll during auto-follow, a held drag, momentum and resume.
- Rapid scrubbing, short/long seeks, pause/resume and delayed playback packets.
- Portrait/landscape, increased font size, long songs, background/foreground and
  switching routes/renderers. Hidden views should stop their animation work.
- A sustained warm-device run, plus 60Hz and low-power fallback checks.

On iOS, switch to the native renderer during playback, seek in both directions,
pause/resume, rotate, and change the font scale. Include sustained words,
background vocals and interludes. Verify that the app remains open and that
word animation does not move neighboring rows. Repeat with the WebView renderer.
