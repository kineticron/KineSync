# Lyrics renderers

Both lyrics styles are WebViews now. The poor-performing AMLL native port
(`lib/amll-native.ts`, `lyric-line.tsx`, `lyrics-view.tsx`, `native-lyric-*`)
was removed. The settings panel switches style between **Spicy** and **AMLL**,
stored as `lyricsStyle: 'spicy' | 'amll'` (legacy `native` maps to `amll`,
legacy `webview` maps to `spicy`).

- **Spicy** (`components/lyrics/spicy-lyrics-view.tsx`, `spicy-webview-entry.ts`,
  `spicy-webview-bundle.ts`): replicates Spicy Lyrics word/letter runtime and
  effect styles. Built with `npm run build:spicy-webview
npm run build:amll-webview`.
- **AMLL** (`components/lyrics/amll-lyrics-view.tsx`, `amll-webview-entry.ts`,
  `amll-webview-bundle.ts`): the AMLL WebView host.
  It wraps **AMLL core 0.5.2**. The reference is
  [applemusic-like-lyrics](https://github.com/amll-dev/applemusic-like-lyrics)
  (AGPL-3.0-only). Built with `npm run build:amll-webview`.

The Spicy WebView uses Spicy's word/letter runtime and effect styles inside KineSync
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

Both WebViews use the bundled `unicode-segmenter` grapheme rules, independent
of the device's `Intl.Segmenter` availability or Unicode version. Spicy's
emphasized letters are complete character clusters. AMLL's build plugin patches
both its emphasis segmenter and its earlier CJK splitting pass (whose upstream
range includes Thai and Indic scripts), retaining the original timing span.
The plugin fails the build if upstream source changes no longer match.

Before either renderer builds words, `repairSyllableClusters` combines only
provider tokens whose boundary falls inside a cluster. Repaired tokens retain
the earliest start, latest end and final word-boundary flag. Safe tokens remain
unchanged; provider input is never mutated. A split cluster therefore shares one
animation timing window instead of moving its character parts independently.
Glow, lift, scaling and karaoke gradients/masks continue to animate complete
clusters. Unflagged AMLL fragments preserve literal spacing without synthesizing
spaces inside Thai or Indic words.

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
npm run build:amll-webview
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

Real API typography checks can be reproduced with:

```sh
node scripts/fetch-cluster-lyrics.cjs
node scripts/preview-lyrics-renderers.cjs .expo/cluster-lyrics
```

Open `http://127.0.0.1:8766/cluster-checks` and run all cluster checks. The
fixtures cover NONT TANONT's **โต๊ะริม** (Kugou KRC), Arijit Singh's **Tum Hi Ho**
(a Devanagari LRCLIB upload), and Sid Sriram's **Inkem Inkem Inkem Kaavaale**
(Telugu LRCLIB). LRCLIB has line timing; the bridge interpolates token timing.
Fetched lyrics remain in ignored `.expo` files. The harness checks every lead
line in both embedded renderers, original timing and forced code-point token
splits, with and without `Intl.Segmenter`. Sustained words exercise emphasis
and karaoke effects. AMLL rows are checked individually because it virtualizes
distant rows. On Windows hosts needing system certificate roots, configure
`NODE_EXTRA_CA_CERTS` with trusted roots; keep HTTPS verification enabled.

For iPhone acceptance, reload the existing development build from Metro after
rebuilding the bundles; these changes require no native rebuild. Test both
styles on Thai, Hindi and Telugu songs, including sustained words, pause/resume,
seeks, background vocals, translation, rotation and larger text. Verify attached
vowel/tone marks and conjuncts, plus glow, lift, scale and progressive highlighting.

**Profile 10 seconds** records browser RAF intervals and callback CPU time.
It does not measure native frames presented by the GPU. A local desktop XIBAL
run measured 0.20ms p95 callback work; this is a host-work measurement, not proof
of 120fps on a phone.
Browser checks verify zero idle RAF
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

On iOS, switch between Spicy and AMLL styles during playback, seek in both directions,
pause/resume, rotate, and change the font scale. Include sustained words,
background vocals and interludes. Verify that the app remains open and that
word animation does not move neighboring rows. Repeat with the WebView renderer.
