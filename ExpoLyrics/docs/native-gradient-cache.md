# Exact native gradient reuse

This is a targeted host allocation-call optimization, not proof that phone
scroll/frame performance is fixed. Active picture recording, glyph drawing,
blur and offscreen mounted-row work remain. Their native cost fractions are unknown.

`drawVoice` previously called `MakeLinearGradient` on every slice of every
recording, even when all gradient arguments repeated. A per-voice LRU now retains
at most 32 shader handles. Hits compare scalar inputs with `Object.is`, with no
rounding, JSON/string keys, key objects or array allocations. Coordinates, shared
endpoint Y and both white-color alphas are exact. White RGB, null color positions,
Clamp tiling, and default matrix/flags are invariant helper semantics. If those
semantics change, the helper and its fixed-semantics tests must change together.
Point/color/entry objects are constructed only on misses. No picture, motion,
timing, layout, clip, mask, draw order, gradient parameter or blur change is made.

## Installed API ownership check

Inspected installed @shopify/react-native-skia 2.13.1 sources before implementing:

- `cpp/skia/include/core/SkPaint.h:68`: paint copies share reference-counted
  shaders; referenced shaders cannot be modified after creation. `fShader` is
  `sk_sp<SkShader>`; `setShader` takes an owning reference.
- `cpp/api/JsiSkShader.h`: the JS wrapper holds `sk_sp<SkShader>` and exposes no
  shader mutation methods. Its common dispose method eagerly releases the wrapper.
- `cpp/api/JsiSkPaint.h:107` and `JsiSkNativeObjects.h:305`: conversion copies the
  reference-counted shader handle into the paint, rather than borrowing a raw
  pointer from a JS cache entry.
- `cpp/api/JsiSkCanvas.h`: drawGlyphs/drawPaint/saveLayer pass the paint to the
  recording canvas. `cpp/skia/include/core/SkPictureRecorder.h:58` specifies the
  resulting immutable picture; `JsiSkPictureRecorder.h` transfers it into an
  owning `sk_sp<SkPicture>` wrapper. Recorded paint state/resources outlive later
  mutations of the reusable paint.

Eviction drops cache references; it never calls `dispose()`. Recorded pictures
may retain shader references. The cache owns at most 32 handles per voice;
recordings can retain additional old shader resources. This is not a native
memory measurement or an assertion that total retained shaders cannot exceed 32.
A component remount creates fresh per-voice state. No global cross-voice cache.

## Reproducible pinned checks

Use installed dependencies and Node tooling PATH=/opt/hako/bin:$PATH. From root:

```sh
git show cf816c41126795201346eabb3514e5265f05a1ac:ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx > /tmp/cf816c4-glyph.tsx
cd ExpoLyrics
node scripts/check-native-gradient-cache.cjs --baseline /tmp/cf816c4-glyph.tsx
node scripts/check-native-shaping-paint.cjs --glyph-baseline /tmp/cf816c4-glyph.tsx
node scripts/check-native-glyph-idle.cjs
node scripts/check-native-glyph-paint.cjs
```

The SHA-pinned replay runs real fixture parsers/models/layout/motion/draw logic
(including Babel-serialized glyph callback/helper and line-motion worklet bodies)
with native fonts, geometry, Skia and scheduling mocked. It performs 17326 tick comparisons of complete
canonical pictures and motion state during playback, release, pause/resume and
seeks. The shaping/paint comparison covers 768 recordings across both styles,
emphasis/lead/background modes, full ownership/clipping geometry, RTL/wrapped
rows, the captured Ariana heart fallback, punctuation, text selectors, color emoji,
ZWJ and keycaps. Unit checks cover exact-field misses, signed zero, LRU eviction,
bounds, retained-handle immutability, no disposal and independent/remounted state.

The five selected complex fixture voices per style produce these host counts:

| Style | Gradient factories before | After | Active picture recordings before and after |
|---|---:|---:|---:|
| AMLL |20488|8899|1470|
| Spicy |24569|1385|1426|

Each avoided call matches an exact baseline trace reuse opportunity. Blur filter
allocations and full canonical commands are unchanged. These are host call counts,
not milliseconds, pixels or native frame-time attribution. Hermes compiler success
for the Babel-transformed real module is separate from runtime/device execution.
