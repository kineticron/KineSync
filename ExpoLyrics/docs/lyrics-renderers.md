# Lyrics renderers

The native renderer ports the effects from **AMLL core 0.5.2**, the version
locked by the AMLL WebView on `main`. The reference is
[applemusic-like-lyrics](https://github.com/amll-dev/applemusic-like-lyrics)
(AGPL-3.0-only). The algorithms live in `lib/amll-native.ts`; native masks and
word effects live in `components/lyrics/native-lyric-token.tsx`.

Native typography remains the existing system font: 32px / 42px with the
existing 1.05 active-size multiplier, weight 700, background scale 0.62 and
weight 500, plus the user's font scale. Translation sizes stay unchanged.
Scaling and emphasis are transforms; they never change text layout metrics.

The native implementation includes:

- One shaped text pass behind a continuously moving native alpha mask, with
  the WebView's 0.56-line-height feather. The cursor uses measured token widths,
  shares its feather across adjacent syllables, and holds during timing gaps.
- AMLL's 0.97-to-1 line spring, scale-dependent bright/dark alpha, and asymmetric
  exponential attack/release. Group opacity and distance blur use the reference
  400ms transitions; manual scrolling clears blur.
- Normal word float, and 32-keyframe sustained-word emphasis with staggered
  characters, expansion, horizontal spread, lift, glow, and stronger last words.
  Joining scripts remain shaped runs rather than disconnected characters.
- Background-vocal slide, fade, 0.8-to-1 wrapper scale, 0.75-to-1 text scale,
  40% brightness, and an expanding/collapsing layout slot. Pausing presents all
  backgrounds, as in AMLL. Translations use the reference opacity.
- Independent row springs and the decaying 50ms stagger. Spring stiffness
  adapts to line intervals, with the slower policy for seeks/interludes. The
  active row anchors at 8% of viewport height, matching `main`'s AMLL settings.
  The native list scrolls exactly this way: the scroll position only moves on
  instant jumps and the user's finger, while auto-follow glides every visible
  row with its own delayed position spring toward one shared shift target.
  All scrolling motion is transform-only, so playback scrolling never drives
  layout, recycling, or per-frame scroll events.
- The 0.5.2 interlude's breathing, sequential dot fill, entrance and exit curves.
  These intentionally differ from the newer AMLL interlude implementation.

The native list is windowed: only rows near the viewport (or the follow
target) mount, and unmounted rows release their views, gradients and mask
bitmaps. When the renderer is hidden, the row tree unmounts entirely and
remounts on return. Gesture handling, overlap/timing rules, credits and seek
controls are preserved. Full-width word flow removes the old nested 88%/90%
width reduction; duet songs reserve an opposing lane. Row spacing and insets
follow the AMLL host while preserving native font metrics.

Playback clocks, masks, letter effects, blur and row motion run on the UI thread.
Hidden renderers cancel their clocks/springs, and recycled rows cancel delayed
motion. Alpha integration stops after settling. Android uses software mask
invalidation so moving masks repaint. This trades bitmap work for a real
continuous mask; sustained frame rate still needs profiling on physical devices.
iOS uses the project's existing experimental React Native release level for
SwiftUI-backed view blur; the filter remains present at zero to avoid changing
the view hierarchy during focus transitions.

Worklet helpers must be declared before their callers. The regression runner
compiles the native modules with Expo's production Worklets transform and
executes their serialized closures, catching missing captures before deployment.

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
Native timeline retargeting preserves the current UI value for corrections within
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
AMLL reference checks also cover unequal-width mask boundaries, held-word and
last-word emphasis, float, asymmetric blur, spring/stagger policies and interlude
snapshots. Additional checks cover continuous clocks at simulated 60/90/120/144Hz, source
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
