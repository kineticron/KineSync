# Native scroll-mount shaping work

Job 3 changes only the creation of per-letter geometry in `NativeSkiaVoice`.
Ordinary words are painted as one slice using their full `rects`. Emphasized
words retain all per-letter boxes. Timing, word text, glyph shaping, fallback
selection, clipping, reveal gradients, blur and scrolling policies are unchanged.

Consumer audit: `AnimatedWord` selects `letters` only when emphasized.
`shapeGlyphWords` does the same in its setup and run visitor. `drawVoice` selects
letter rectangles only in that branch. Static paragraph painting has no use for
the letter arrays. Source `word.letters` (graphemes used for motion and emoji
classification) is retained. Only unused **geometry queries** are removed.

The untouched baseline is **3eff8808939f1caff11fb4d32e9b0cd7f799d137**.
Before any production edit, the actual hook/model/wrapping code was run with
mock paragraph metrics (8 px/code unit), mock native hosts and glyph recorder.
Across the five real TTML fixtures, each style mounts 190 lead/background voices
at width 320. The saved baseline fixture pins the exact source SHA-256 and every
consumed-input digest. These are host call counts, not device frame timings.

| Host count, all five fixtures | AMLL before | AMLL after | Spicy before | Spicy after |
|---|---:|---:|---:|---:|
| `getRectsForRange` | 5347 | 2931 | 5621 | 2573 |
| Paragraph builds, including translations | 488 | 488 | 488 | 488 |
| Glyph shape passes | 190 | 190 | 190 | 190 |
| Extra shape passes over 10 unchanged renders/voice | 0 | 0 | 0 | 0 |

Reproduce from the repository root with Node tooling on PATH:

```sh
export PATH=/opt/hako/bin:$PATH
git show 3eff8808939f1caff11fb4d32e9b0cd7f799d137:ExpoLyrics/components/lyrics/native/native-skia-voice.tsx > /tmp/kinesync-before-voice.tsx
cd ExpoLyrics
node scripts/check-native-shaping-work.cjs --baseline /tmp/kinesync-before-voice.tsx
node scripts/check-native-shaping-paint.cjs --baseline /tmp/kinesync-before-voice.tsx
```

The paint test compares complete consumed shaped objects (word data, timing,
rectangles, widths, offsets, glyph runs/fonts, ownership, clips, reveal bounds,
emoji masks and recorded alpha pictures), excluding only the audited unused
non-emphasized letter geometry. It compares 288 complete canvas command
recordings from the actual `shapeGlyphWords`/`drawVoice` code, and resolved tree
renderer output from the actual component functions. Cases include both styles,
emphasized/non-emphasized words, RTL, multi-line and real captured heart fallback
geometry, glow, foreground/background, active/inactive release and seek timing.
Native paragraph/font/drawing APIs are mocked. Equality is not pixel evidence.

Device JS/UI frame times, GPU blur cost, virtualization populations and actual
React row render counts were unavailable. The optimization reduces synchronous
paragraph API calls during mount/relayout. It does not establish smoother device
scrolling or a whole-app frame-time/FPS improvement. FlashList draw distance
420, FlatList window size 5, glyph picture recording and blur behavior remain
unchanged. The optional spacing probe had zero uses in these fixtures and was
not optimized.

For a later matched Android run with an existing installed dev client/device:

```sh
node scripts/profile-native-lyrics.cjs SERIAL both scroll --canvas-only
```

That existing script captures JS delay, presentation intervals/jank and resource
data. It is exploratory debug instrumentation, not a release/iOS performance
guarantee. iOS device validation still needs matching on-device profiling.
