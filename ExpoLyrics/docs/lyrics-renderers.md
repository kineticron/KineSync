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

The native `LyricLine` retains AMLL's linear reveal, word float, emphasis/glow,
line/background springs and dot effects. Emphasis uses transforms during both
playback and seek preview so it cannot change wrapping. Native filter blur stays
present on both platforms, including at zero blur, and clears for manual scrolling.
When the lyrics route or app is inactive, the native host keeps its FlashList and
measurements mounted but unsubscribes its playback-window/scroll planners and
cancels row, background, reveal, pause-dot and list-scroll animations. Returning to
an auto-following screen resynchronizes from the current playback timestamp; a
manually scrolled screen keeps its existing position.

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
Static lyrics use the existing native-sized static host.

## Validation

From `ExpoLyrics`:

```sh
npm run test:lyrics
npm run build:spicy-webview
npx tsc --noEmit
npx expo export --platform ios --output-dir .expo/lyrics-ios-check
node scripts/preview-lyrics-renderers.cjs
```

The preview serves the exact embedded WebView HTML on `127.0.0.1:8766`, using
sample lyrics only. Its **Run browser checks** button covers geometry, both
orientations, backgrounds, translations, static mode, seeks, follow/resume,
advance highlighting, nearby-row painting, and idle/visibility suspension.
It must be restarted after rebuilding the bundle.

On iOS, switch to the native renderer during playback, seek in both directions,
pause/resume, rotate, and change the font scale. Include sustained words,
background vocals and interludes. Verify that the app remains open and that
word animation does not move neighboring rows. Repeat with the WebView renderer.
