# Lyrics rendering

The iOS and Android apps render lyrics with the native Rust surface in both
development and release. The Lyrics style setting selects **Spicy** or **AMLL**
within Rust. Saved styles are retained. Old `native` and `webview` style
values map to AMLL and Spicy respectively, and the old backend preference is
removed.

Onboarding uses the same Rust surface for the selected style and a 25-second
sample with its own monotonic playback anchor. The player tutorial uses that
sample through an interactive Rust view with its own seek and pause state.
Clients without the compatible native module display a renderer availability
message. The Skia implementations remain as independent references.

## Clocks and input

Rust projects playback anchors on the native monotonic clock. JavaScript sends
a new anchor when the source changes, the user scrubs, or the view reports
readiness. The platform display callbacks advance the animation when visible
and sleep until the next cue when possible.

The seek bar runs one linear UI animation per anchor. Store position ticks do
not restart it, and its fill uses a transform instead of changing layout width.
Seeking uses the final release coordinate, and canceled gestures do not seek.
Hidden timelines cancel their clock and release subscriptions. The release
position is held until the host installs its optimistic seek anchor.

The native owner handles drag, momentum and follow. The player receives
tap-to-seek, long-press selection and credits actions through the existing
gesture path. Plain lyrics without valid timing show an explanatory message.

## Refresh rate

iOS retains `CADisableMinimumFrameDurationOnPhone`. The Android
`with-high-refresh-rate` prebuild plugin requests the highest supported refresh
rate up to 120Hz at the current resolution while the window has focus, and
releases the preference when it loses focus. Display hardware, system power
settings and thermal limits still determine the actual presentation rate. See
[Android refresh-rate preferences](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#preferredRefreshRate).
The plugin needs a new native build. An OTA JavaScript update cannot install it.

## Provider spacing

Rust packet preparation shares the reference word and grapheme helpers.
`repairSyllableClusters` joins provider tokens that split a cluster and keeps
the earliest start, latest end and final word-boundary flag. Provider input
stays immutable. Explicit Spicy `isPartOfWord` flags remain authoritative.
KRC, QRC and YRC tokens without a flag retain literal whitespace.

## Validation

From `ExpoLyrics`:

```sh
npm run typecheck
npm run test:lyrics
npm run test:tour
```

Use an iOS or Android build that bundles the Rust module for visual and touch
validation. Exercise both styles with translations, background vocals, dense
and sustained words, pause and resume, seeks, scrolling, rotation, and a
background and foreground cycle. Verify the selected onboarding card and the
interactive player tutorial. Collect actual presentation and missed deadlines
on physical devices when measuring rendering performance.

The [reference renderer notes](native-lyrics-renderers.md) preserve the earlier
Skia comparisons. The app's renderer lab now profiles Rust.
