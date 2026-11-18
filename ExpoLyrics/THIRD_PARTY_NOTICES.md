# Third-party notices

## Kawarp artwork backgrounds

The native player background adapts the tint, Kawase blur, simplex domain warp,
and output shaders from [`better-lyrics/kawarp`](https://github.com/better-lyrics/kawarp),
commit `bb914faf44a394c8b05896b31b21edbb369b5596`,
`packages/core/src/index.ts`. Copyright (c) 2026 Better Lyrics, MIT licensed.
The complete notice is in [THIRD_PARTY_LICENSES/Kawarp-LICENSE](THIRD_PARTY_LICENSES/Kawarp-LICENSE).

`components/lyrics/kawarp-shaders.ts` ports GLSL to SkSL, combines warp and
output into one pass, and adds native texture crossfading, fixed grain and a
readability scrim. `kawarp-texture.ts` replaces WebGL framebuffers with native
128 by 128 Skia textures. Blur runs only when artwork changes. The animated
canvas uses Reanimated on the UI thread with bounded output resolution, and
stops ambient motion on pause, loss of focus, backgrounding or reduced motion.
The web player and native failures use a static artwork fallback.

## Spicy Lyrics and Apple Music-like Lyrics

The Rust styles and native reference helpers adapt layout and motion policies
from [Spikerko/spicy-lyrics](https://github.com/Spikerko/spicy-lyrics) v6.3.15,
commit `2a14863f8c29782f9ab3becff2b1360dfb74a4fb`, and
[amll-dev/applemusic-like-lyrics](https://github.com/amll-dev/applemusic-like-lyrics).
Spicy Lyrics is AGPL-3.0 and Apple Music-like Lyrics is AGPL-3.0-only.
The reference tests use the Spicy spring and spline fixture in
`scripts/fixtures/spicy-motion-reference.ts` and AMLL core 0.6.0.
The AMLL package version and integrity hash are recorded in `package-lock.json`.

The mobile app declares AGPL-3.0-only in its package metadata. The complete
license text is included in [LICENSE](LICENSE). Other dependencies retain
the license files and copyright notices distributed with their packages.

## Noto Sans CJK SC fallback font

The iOS Rust lyric module bundles the full official Noto Sans CJK SC Regular
and Bold OpenType files from
[`notofonts/noto-cjk`](https://github.com/notofonts/noto-cjk), path
`Sans/OTF/SimplifiedChinese/` on `main`. They are used only when the platform
Japanese, Chinese and Korean system fonts cannot draw a cluster. The files are
licensed under the SIL Open Font License 1.1. The complete license is in
`modules/kinesync-rust-lyrics/ios/Fonts/NotoSansCJK-LICENSE.txt`.

Recorded SHA-256 values:

- `NotoSansCJKsc-Regular.otf`: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`
- `NotoSansCJKsc-Bold.otf`: `b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a`

No Android bundle is added because Android exposes its own system CJK fonts.

## Experimental native lyric renderers

`components/lyrics/native/reference-motion.ts` and the native word/line/scroll
controllers port the Spicy and AMLL motion policies cited above.
The `amll-reference-*.ts` files contain pure layout and word splitting source
extracted from AMLL core 0.5.2 and retain its AGPL-3.0-only license.
The Skia measurement adapter replaces the browser's DOM measurement.

The native AMLL layout adapter uses `@formatjs/intl-segmenter` for runtimes
without `Intl.Segmenter`. FormatJS is MIT licensed, its package metadata and
upstream copyright/license notices apply to this dependency.
