# Third-party notices

## Spicy Lyrics renderer

The WebView lyrics renderer includes code and CSS from
[`Spikerko/spicy-lyrics`](https://github.com/Spikerko/spicy-lyrics), version
6.3.15 at commit `2a14863f8c29782f9ab3becff2b1360dfb74a4fb`.

Spicy Lyrics is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0). `components/lyrics/spicy-webview.css` contains the upstream
`src/css/Lyrics/main.css` and `src/css/Lyrics/Mixed.css` renderer styles, followed
by a small KineSync host shell. The standalone WebView renderer also copies or
closely ports the upstream implementations from `src/modules/Spring.ts`,
`src/utils/Lyrics/LyricsVirtualizer.ts`,
`src/utils/Lyrics/Animator/Lyrics/LyricsAnimator.ts`,
`src/utils/Lyrics/Animator/Lyrics/LyricsSetter.ts`,
`src/utils/Lyrics/Applyer/Synced/Syllable.ts`, and
`src/utils/Scrolling/ScrollToActiveLine.ts`. These live in
`components/lyrics/spicy-upstream-*.ts` and are wrapped by
`components/lyrics/spicy-webview-entry.ts`, which replaces Spicetify, Spotify,
network, and global-store dependencies with KineSync's local WebView bridge and
playback clock. The renderer preserves upstream spring/spline, emphasis,
blur, interlude-dot and line-state effects. `spicy-layout-host.ts` and
`spicy-layout.css` provide KineSync's native row geometry and scrolling policy.
The upstream virtualizer and scroll controller are not bundled into the host.

## Apple Music-like Lyrics WebView renderer

The AMLL WebView host bundles `@applemusic-like-lyrics/core` version 0.5.2
from [`amll-dev/applemusic-like-lyrics`](https://github.com/amll-dev/applemusic-like-lyrics).
The installed version and integrity hash are recorded in `package-lock.json`.
The earlier native port used commit `eb5c852f7bf809f32425c3025f423598c619af58`.
That port is no longer the active renderer.

Apple Music-like Lyrics is licensed under the GNU Affero General Public License
v3.0 (AGPL-3.0-only). `components/lyrics/amll-webview-entry.ts` wraps its
lyric player and background support with KineSync's local message bridge,
playback clock, layout options, and attribution UI. Generated JavaScript and
CSS are included in `amll-webview-bundle.ts`. Native React Native controls
surround the WebView. The lyrics themselves use the upstream web renderer.

The mobile app declares AGPL-3.0-only in its package metadata. The complete
license text is included in [LICENSE](LICENSE). Other dependencies retain
the license files and copyright notices distributed with their packages.

## Experimental native lyric renderers

`components/lyrics/native/reference-motion.ts` and the native word/line/scroll
controllers port the bundled Spicy and AMLL motion policies cited above.
The `amll-reference-*.ts` files contain pure layout and word splitting source
extracted from AMLL core 0.5.2 and retain its AGPL-3.0-only license.
The Skia measurement adapter replaces the browser's DOM measurement.

The native AMLL layout adapter uses `@formatjs/intl-segmenter` for runtimes
without `Intl.Segmenter`. FormatJS is MIT licensed; its package metadata and
upstream copyright/license notices apply to this dependency.
