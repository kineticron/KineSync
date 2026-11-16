# Round 3 phone follow-up

Base: 5ae52ec, rust-renderer-spike. Reference files were read without edits:

- ExpoLyrics/components/lyrics/native/native-lyric-row.tsx
- ExpoLyrics/components/lyrics/native/use-reference-line-motion.ts
- ExpoLyrics/components/lyrics/native/native-skia-voice.tsx
- ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx
- ExpoLyrics/components/lyrics/native/reference-motion.ts
- ExpoLyrics/components/lyrics/native/native-interlude.tsx
- ExpoLyrics/components/lyrics/native/native-interlude-motion.ts

## A: preparation handoff inventory

The previous alpha-only fix left the AMLL scale at 1 instead of the cold row's
settled 0.97. Its first spring update therefore raised both alpha targets above
0.2, then released them back to 0.2. Initialize scale and alpha together. Paused
rows use Skia's scale 1 / dark 0.4 consistently on both sides of preparation.

Before its actual cue a prepared row keeps the same cold glyph scene, font,
layout, translation and transform; adding timed geometry does not change its
paint path. Outer opacity starts at the currently displayed endpoint. A newly
prepared Spicy row already in the visual gap window starts at the cold path's
primed outer opacity, rather than defaulting to 0.51.

Bottom fade is a single final compositor operation, shared by both states.
The half-resolution near/far bases are regenerated from the current sharp
texture before every composition, in queue order; there is no first-frame
fallback that skips blur. GPU tests compare exact RGBA bytes before preparation
and for its first four frames, with playback running/paused, at the bottom
fade, and with both protected and blurred rendering.

## B: priming and size

AMLL now applies its visual active window to outer opacity and spring/alpha
targets, while its word clock still waits for the actual cue. A two-line gap
regression covers both styles.

Spicy cold text now bakes Skia's p=0 per-word scale 0.95 and y=0.01, plus the
emphasized-letter scale 0.95 and y=0.02. These use the live path's exact glyph
runs, pivots and clips, without changing font size or reshaping at activation.
GPU comparisons check cold/active-start transitions and a real gap, including
emphasized letters, within two RGBA levels (layer/gradient quantization).

## C: interlude dots

Spicy uses the actual SF Pro Display Bold bullet at 1.3 times row font size,
with the measured glyph advance and centered ink bounds; the former guessed
circle and guessed 0.35-em advance are gone. Dot gap is 2.88 logical points,
box height is 0.65 times dot font size, and glyph alpha is 0.85. Dot/group
spring curves and entry/exit constants are checked against the Skia source.
Glyph and shadow receive their combined outer opacity as a group.

The shadow uses Vello's local analytic Gaussian at Skia's continuous
(4 + 6 * glow)/2 sigma and clamp(glow * 0.9) alpha, instead of interpolation
between the shared 2.5/6-pixel row-blur bases. The shadow's geometry is the
bullet's measured rounded ink bounds; this is not pixel-equivalence evidence
for Skia's glyph-mask shadow rasterization.

AMLL uses white circles of diameter 0.5em, gap 0.25em plus 4 logical points,
top 0.4em, the source breathing/light-up curves, and no shadow. Coverage is
encoded only in red: white RGB accidentally populated both glow channels.
The padded dot slot stays protected from row blur when the upcoming row primes.
GPU draws cover entry, breathing and exit for both styles. Warm frame allocation
checks remain zero, including Spicy's local shadow.

## Ghost and validation limits

The reported one-off upside-down/mirrored line was not reproduced. Surface
copy uses pixel coordinates without a UV reflection; render attachments clear,
blur kernels use transparent padding, and all shared texture accesses are
ordered on one queue. A GPU regression compares every glyph alpha at its exact
surface coordinate, then verifies a blank next frame clears sharp, blur and
surface output. The existing two-frames-in-flight ownership GPU test is also run.
These are Linux host GPU checks, not a new iPhone/Metal capture or IPA test.
