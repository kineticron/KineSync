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
`spicy-layout.css` provide KineSync's native row geometry and scrolling policy;
the upstream virtualizer and scroll controller are not bundled into the host.

## Apple Music-like Lyrics native renderer parity

The native React Native lyrics renderer translates visual behavior and animation
math from [`amll-dev/applemusic-like-lyrics`](https://github.com/amll-dev/applemusic-like-lyrics)
at commit `eb5c852f7bf809f32425c3025f423598c619af58`.

Apple Music-like Lyrics is licensed under the GNU Affero General Public License
v3.0 (AGPL-3.0). The native KineSync implementation reproduces the upstream
line/background scale and spring parameters, word-fade width, emphasis curves,
and interlude-dot choreography using React Native and Reanimated primitives.
KineSync owns font sizes, line wrapping, row spacing, alignment and scrolling.
Background animation changes only painting, keeping its layout space reserved.
Native filter blur is restricted to Android: iOS lyric rows avoid the SwiftUI
filter wrapper and retain a stable Fabric view hierarchy during recycling.
