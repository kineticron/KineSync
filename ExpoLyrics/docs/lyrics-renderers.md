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
playback and seek preview so it cannot change wrapping. Native filter blur is
disabled on iOS to avoid placing recycled animated rows inside React Native's
SwiftUI filter wrapper. Android can still use the filter; neither a JavaScript
bundle build nor the mocked native mounts can verify device-level stability.

The WebView uses Spicy's word/letter runtime and effect styles inside KineSync
rows. Its original center-scroll controller and virtualizer are no longer used.
The host keeps source rows mounted to make their measured geometry independent
of animation. Long songs should be included in device performance testing.
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
orientations, backgrounds, translations, static mode, seeks and follow/resume.
It must be restarted after rebuilding the bundle.

On iOS, switch to the native renderer during playback, seek in both directions,
pause/resume, rotate, and change the font scale. Include sustained words,
background vocals and interludes. Verify that the app remains open and that
word animation does not move neighboring rows. Repeat with the WebView renderer.
