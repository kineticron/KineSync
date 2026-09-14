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
playback clock while preserving the renderer's DOM, spring/spline, emphasis,
blur, interlude-dot, virtualizer, line-state, and auto-scroll behavior.

## Apple Music-like Lyrics native renderer parity

The native React Native lyrics renderer translates visual behavior and animation
math from [`amll-dev/applemusic-like-lyrics`](https://github.com/amll-dev/applemusic-like-lyrics)
at commit `eb5c852f7bf809f32425c3025f423598c619af58`.

Apple Music-like Lyrics is licensed under the GNU Affero General Public License
v3.0 (AGPL-3.0). The native KineSync implementation reproduces the upstream
layout anchor, line/background scale and spring parameters, distance blur,
word-fade width, emphasis curves, duet inset, and interlude-dot choreography
using React Native and Reanimated primitives.
