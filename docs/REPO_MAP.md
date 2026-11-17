# Repository map

Compact orientation for KineSync. Start with the subsystem you need, then open only the listed files. Runtime code is the authority when this map and the code disagree.

## Top-level layout

- `ExpoLyrics/` is the Expo React Native app. No root `package.json` exists, so run app scripts with `npm --prefix ExpoLyrics run ...`.
- `native/lyrics-renderer/` is the Rust wgpu, vello, and parley renderer crate.
- `ExpoLyrics/modules/kinesync-rust-lyrics/` is the Expo native module for iOS and Android.
- `DesktopBridge/` is the optional Electron playback bridge.
- `scripts/` contains repository checks, release tooling, Android helpers, and iOS CI helpers. `scripts/test/` contains Node contract tests.
- `.github/workflows/` contains CI and build automation.
- `website/` has its own `website/AGENTS.md`, read it before website work.
- `Previews/`, `ui-regression-tests/`, and `xpra-client/` are supporting visual, regression, and container assets.

## Mobile app entrypoints

- `ExpoLyrics/app/_layout.tsx` mounts the router stack, gesture root, theme, and `BridgeProvider`.
- `ExpoLyrics/app/(tabs)/_layout.tsx` defines the tab stack and orientation and animation behavior.
- `ExpoLyrics/app/(tabs)/index.tsx` is the player screen. It owns lyric rendering, controls dock composition, fullscreen artwork, tour state, and Spotify browser fallback.
- `ExpoLyrics/app/(tabs)/explore.tsx` is the Bridge settings screen.
- `ExpoLyrics/app/(tabs)/vault.tsx` is the local vault, TTML import, export, rename, and share UI.
- `ExpoLyrics/app/modal.tsx`, `ExpoLyrics/app/renderer-lab.tsx`, and `ExpoLyrics/app/arrival-lab.tsx` are auxiliary routes. Renderer lab is enabled in development or when `EXPO_PUBLIC_LYRICS_LAB=1`.
- `ExpoLyrics/app/+native-intent.ts` redirects Expo sharing paths to `/vault`.
- `ExpoLyrics/providers/bridge-provider.tsx` owns bridge connection lifecycle.
- `ExpoLyrics/store/playback-store.ts` is the central playback, lyrics, settings, and renderer state store.

## Lyrics providers and picker

- `ExpoLyrics/components/lyrics/settings-menu.tsx` contains the source picker in `SOURCE_OPTIONS` and the AMLL or Spicy style picker in `RENDERER_OPTIONS`, which calls `onChangeLyricsStyle` and does not choose the Rust, Skia, or WebView backend.
- Picker source IDs are `auto`, `local-vault`, `lrc-red`, `kugou`, `netease`, `qq-direct`, `musixmatch`, `lrclib`, and `spicy-lyrics`.
- `ExpoLyrics/lib/lyrics-sync.ts` defines `LyricsSourcePreference` and coordinates requests with the playback store.
- `ExpoLyrics/lib/mobile-lyrics-client.ts` calls the bundled mobile lyrics service.
- `ExpoLyrics/lib/mobile-lyrics-service.js` is the phone-side provider bundle. Its header says it is generated from the Desktop Bridge parts, so provider changes must stay aligned in both places.
- `DesktopBridge/src/lyrics/index.js` loads ordered provider parts into one VM context.
- `DesktopBridge/src/lyrics/parts/07a-source-scoring.js` owns source ordering, candidate validation and finalization, and the concurrent `fetchBestSyncedLyrics` pipeline.
- `DesktopBridge/src/lyrics/parts/07b-service-orchestration.js` owns the `createLyricsService` facade, caches, selection generations, request orchestration, and publication.
- `DesktopBridge/src/lyrics/parts/08-local-vault-source.js` owns the local vault provider adapter.
- `DesktopBridge/src/lyricsAutoPicker.js` and `DesktopBridge/src/lyricsSourceHealth.js` own desktop auto selection and health.
- `ExpoLyrics/lib/lyrics-policy.js` and `DesktopBridge/src/lyricsPolicy.js` enforce provider export restrictions.
- `ExpoLyrics/lib/lyrics-timing.ts` and `ExpoLyrics/lib/lyrics-status.ts` own timing labels and user-facing source status.
- Provider behavior and key configuration are documented in `docs/lyrics-sources.md`.

Provider gotchas:

- In auto mode, a valid local vault hit returns immediately without fetching API providers. On a vault miss, eligible API providers run concurrently and the auto picker selects and upgrades candidates. An explicitly selected API provider bypasses local vault lookup.
- Karaoke or syllable data generally outranks line data, though community Spicy and provider-equivalence exceptions in `DesktopBridge/src/lyricsAutoPicker.js` can change that order. A selected provider can still return no match.
- All lyrics fetched through the Spicy API are blocked from export, including official-provider responses and vault save, import, or transfer.
- Spicy vault copies expire using original provider metadata, capped at 30 days.
- Picker cache behavior is covered by `ExpoLyrics/scripts/check-mobile-picker-cache.cjs`.
- Desktop picker behavior is covered by `DesktopBridge/test/lyrics-auto-picker.test.js`, `DesktopBridge/test/lyrics-progressive-picker.test.js`, and `DesktopBridge/test/lyrics-provider-concurrency.test.js`.

## Renderers and reference parity

- `ExpoLyrics/components/lyrics/native-amll-lyrics-view.tsx` and `ExpoLyrics/components/lyrics/native-spicy-lyrics-view.tsx` are the Skia AMLL and Spicy reference entrypoints.
- `ExpoLyrics/components/lyrics/native/native-lyrics-view.tsx` is the shared Skia reference host.
- `ExpoLyrics/components/lyrics/native/native-lyric-row.tsx`, `ExpoLyrics/components/lyrics/native/native-interlude.tsx`, `ExpoLyrics/components/lyrics/native/native-interlude-motion.ts`, and `ExpoLyrics/components/lyrics/native/reference-motion.ts` cover rows, dots, and motion.
- `ExpoLyrics/components/lyrics/native/amll-native-layout.ts`, `ExpoLyrics/components/lyrics/native/amll-reference-line-break.ts`, `ExpoLyrics/components/lyrics/native/amll-reference-word-split.ts`, and `ExpoLyrics/components/lyrics/native/spicy-native-layout.ts` are style-specific layout helpers.
- `ExpoLyrics/components/lyrics/native/use-native-lyrics-clock.ts`, `ExpoLyrics/components/lyrics/native/reference-scroll.tsx`, and `ExpoLyrics/components/lyrics/native/use-reference-line-motion.ts` cover clocks and scrolling.
- `ExpoLyrics/components/lyrics/amll-lyrics-view.tsx` and `ExpoLyrics/components/lyrics/spicy-lyrics-view.tsx` are the WebView hosts. Their generated bundles are `ExpoLyrics/components/lyrics/amll-webview-bundle.ts` and `ExpoLyrics/components/lyrics/spicy-webview-bundle.ts`.
- `ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx` is the Rust JS entry.
- `ExpoLyrics/lib/rust-lyrics-gesture.js`, `ExpoLyrics/lib/rust-lyrics-follow.js`, `ExpoLyrics/lib/rust-lyrics-protocol.js`, and `ExpoLyrics/lib/rust-lyrics-preparation.ts` own gesture, follow, anchor, and packet preparation.
- `ExpoLyrics/components/lyrics/native/renderer-lab.tsx` is the comparative lab.

Parity gotchas:

- The Skia AMLL and Spicy renderers are the visual reference, not edit targets.
- Do not change reference code to make a Rust regression pass.
- WebView renderer work is out of scope for the Rust renderer.
- `npm --prefix ExpoLyrics run test:lyrics-native` covers native lyric regressions.
- `node ExpoLyrics/scripts/check-lyrics-renderers.cjs` checks renderer wiring.
- `node ExpoLyrics/scripts/check-rust-gestures.cjs` checks Rust gesture ownership.

## Rust renderer crate

- `native/lyrics-renderer/Cargo.toml` defines the crate.
- `native/lyrics-renderer/src/ffi.rs` defines the C ABI, handles, validation, and native entrypoints.
- `native/lyrics-renderer/include/KineSyncLyrics.h` is the public C header.
- `native/lyrics-renderer/src/lib.rs` owns the packet and timing model.
- `native/lyrics-renderer/src/live.rs` manages the live renderer.
- `native/lyrics-renderer/src/gpu.rs` owns GPU resources, rendering, and effect passes.
- `native/lyrics-renderer/src/scene.rs` builds scenes and geometry.
- `native/lyrics-renderer/src/typography.rs` shapes and lays out glyphs.
- `native/lyrics-renderer/src/style_timing.rs` and `native/lyrics-renderer/src/appearance.rs` own style timing and appearance transitions.
- `native/lyrics-renderer/src/interlude.rs` implements dots. `native/lyrics-renderer/src/credits.rs` handles end credits.
- `native/lyrics-renderer/src/motion.rs`, `native/lyrics-renderer/src/scheduling.rs`, `native/lyrics-renderer/src/timed_scene.rs`, and `native/lyrics-renderer/src/auxiliary.rs` cover motion, frame scheduling, timed scenes, and auxiliary output.
- `native/lyrics-renderer/src/blur.wgsl`, `native/lyrics-renderer/src/downsample.wgsl`, `native/lyrics-renderer/src/composite.wgsl`, and `native/lyrics-renderer/src/surface.wgsl` are the four custom shaders.
- `native/lyrics-renderer/ANDROID.md`, `native/lyrics-renderer/DESIGN.md`, and `native/lyrics-renderer/CREDITS-FOOTER-SWITCH.md` are crate design notes.

Rust gotchas:

- Current ABI is 11.
- ABI changes must stay aligned across `native/lyrics-renderer/src/ffi.rs`, `native/lyrics-renderer/include/KineSyncLyrics.h`, the Swift module guard, the JS guard in `ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx`, and Rust tests.
- Rebuild the custom development client after ABI or native changes. Expo Go cannot load the Rust surface.
- On rescue, plain `cargo` has no configured default. Explicit `+1.97.0` works. Use an installed project-compatible toolchain elsewhere rather than installing or changing defaults blindly.

## iOS and Android shims

- `ExpoLyrics/modules/kinesync-rust-lyrics/expo-module.config.json` registers the module.
- `ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift` owns the Metal view, display link, touch handling, and C bridge.
- `ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyrics.podspec` and `ExpoLyrics/modules/kinesync-rust-lyrics/ios/Fonts/` are iOS packaging and fonts.
- `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/KineSyncRustLyricsModule.kt` exposes the Expo module.
- `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/KineSyncRustLyricsView.kt` owns the TextureView, Choreographer, touch, and surface lifecycle.
- `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/RustBridge.kt` declares JNI externals and `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/RustOwner.kt` owns native lifetime and metrics state.
- `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/cpp/kinesync_rust_lyrics.cpp` is the JNI shim over the shared C ABI.
- `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/cpp/CMakeLists.txt` links the static Rust archive.
- `ExpoLyrics/modules/kinesync-rust-lyrics/android/build.gradle` wires CMake and the module.
- `scripts/build-rust-lyrics-android.sh` builds Android static libraries.

Native gotchas:

- iOS keeps the native layer alive until `kr_destroy` completes.
- Android keeps the `ANativeWindow` acquired until `kr_destroy` completes.
- Android uses premultiplied alpha because the TextureView consumer imports RGBA as premultiplied.
- Never hide the Android TextureView with `visibility`. Use alpha.
- `node ExpoLyrics/modules/kinesync-rust-lyrics/android/check-jni-contract.cjs` checks Kotlin externals, JNI symbols, header resolution, and touch lifecycle.
- iOS development build steps live in `.github/workflows/ios-development-build.yml` and `scripts/ios-dev-ci/`.

## Playback controls and dock

- `ExpoLyrics/app/(tabs)/index.tsx` defines `PlaybackControlsDock` and the `controlsWrap` dock layout and animation.
- `ExpoLyrics/components/lyrics/playback-controls.tsx` owns transport buttons, scrub timeline, and control layouts.
- `ExpoLyrics/components/lyrics/horizontal-player-panel.tsx` is the landscape player panel.
- `ExpoLyrics/lib/controls-motion.ts` and `ExpoLyrics/constants/player-layout.ts` own motion and responsive layout constants.
- `ExpoLyrics/components/lyrics/use-playback-timeline-clock.ts` projects playback anchors for the timeline.
- `ExpoLyrics/lib/playback-source.ts` defines playback modes and source behavior.
- `ExpoLyrics/store/playback-store.ts` maintains position and time anchors.
- `ExpoLyrics/components/lyrics/lyrics-attribution.tsx` owns provider attribution near the controls.
- `ExpoLyrics/components/lyrics/settings-menu.tsx` owns the controls and renderer settings UI.

Dock gotchas:

- `node ExpoLyrics/scripts/check-controls-motion.cjs` checks dock geometry and animation.
- `node ExpoLyrics/scripts/check-controls-lifecycle.cjs` is also available.
- The dock consumes `controlsDockHeight`, so layout changes can affect lyric bottom padding and fullscreen reserve.
- Attribution visibility and provider restrictions are covered by `ExpoLyrics/scripts/check-spicy-attribution.cjs`.

## Spotify

- `ExpoLyrics/lib/spotify-browser.ts` owns the embedded browser flow.
- `ExpoLyrics/lib/spotify-player-actions.ts` owns pause, resume, previous, next, and seek actions.
- `ExpoLyrics/lib/spotify-detector/` contains protocol, binary, bootstrap, client, health, packet, reachability, timing, and diagnostics modules.
- `ExpoLyrics/components/lyrics/spotify-native-detector.tsx` is the native detector component.
- `ExpoLyrics/components/lyrics/spotify-browser-fallback.tsx`, `ExpoLyrics/components/lyrics/spotify-connection-strip.tsx`, and `ExpoLyrics/components/spotify-login-webview.tsx` are the UI surfaces.
- `ExpoLyrics/store/spotify-connection-store.ts` and `ExpoLyrics/store/spotify-session-store.ts` own connection and session state.
- `DesktopBridge/src/spotifyDetector.js`, `DesktopBridge/src/spotifyAuth.js`, and `DesktopBridge/src/containerSpotifyTokenWatcher.js` cover desktop detection, auth, and container tokens.
- `ExpoLyrics/docs/spotify-detector.md` is the detailed detector behavior and device test guide.

Spotify gotchas:

- Mobile-only controls require verified detector health, a current connection ID, and an unrestricted target.
- Cached foreground playback is display-only after connection loss.
- Browser playback messages do not populate the native clock.
- `npm --prefix ExpoLyrics run test:spotify-detector` and `test:spotify-browser` cover detector and browser regressions.
- `DesktopBridge/test/spotifyAuth-recovery.test.js` covers desktop auth recovery.

## Vault and export

- `ExpoLyrics/app/(tabs)/vault.tsx` owns catalog listing, import, export, rename, delete, and share handling.
- `ExpoLyrics/lib/mobile-lyrics-vault.ts` is the SQLite-backed mobile vault. `ExpoLyrics/lib/mobile-lyrics-vault.web.ts` is the web adapter.
- `ExpoLyrics/lib/desktop-vault-transfer.ts`, `ExpoLyrics/lib/incoming-vault-share.ts`, and `ExpoLyrics/lib/vault-spotify-match.ts` own transfer, share intake, and Spotify identity matching.
- `ExpoLyrics/components/lyrics/desktop-vault-catalog.tsx` is the desktop catalog UI.
- `ExpoLyrics/lib/lyrics-ttml-import.js` and `ExpoLyrics/lib/lyrics-ttml-export.js` parse and build TTML.
- `ExpoLyrics/lib/lyrics-policy.js` and `DesktopBridge/src/lyricsPolicy.js` enforce export restrictions.
- `DesktopBridge/src/lyricsVault.js`, `DesktopBridge/src/bridgeVault.js`, `DesktopBridge/src/exportRequestRegistry.js`, `DesktopBridge/src/lyricsTtmlImport.js`, and `DesktopBridge/src/lyricsTtmlExport.js` are the desktop equivalents.
- Shared TTML fixtures are in `DesktopBridge/test/fixtures/`.

Vault gotchas:

- `expo-sqlite` requires a rebuilt native app. An OTA JavaScript update cannot add it.
- TTML imports use embedded Spotify identifiers when present and otherwise use strict matching.
- Original TTML, translations, credits, expiry metadata, and vault IDs survive migration.
- All lyrics fetched through the Spicy API remain blocked from export after vault save, import, or transfer, including official-provider responses.
- `npm --prefix ExpoLyrics run test:vault` covers mobile vault, policy, TTML, sharing, artwork, desktop transfer, and lrc.red vault behavior.
- Desktop vault tests start at `DesktopBridge/test/sqlite-vault.test.js` and `DesktopBridge/test/bridgeVault.test.js`.

## Desktop Bridge

- `DesktopBridge/src/index.js` is the Electron main process.
- `DesktopBridge/src/index.html` and `DesktopBridge/src/index.css` are the bridge settings and status UI.
- `DesktopBridge/src/bridgeServer.js`, `DesktopBridge/src/bridgeRelayClient.js`, and `DesktopBridge/src/relayServer.js` own LAN and relay transport.
- `DesktopBridge/src/playbackController.js` owns desktop playback state and anchors.
- `DesktopBridge/src/lyrics/` is the provider service, with ordered parts under `DesktopBridge/src/lyrics/parts/`.
- `DesktopBridge/src/lyricsAutoPicker.js` and `DesktopBridge/src/lyricsSourceHealth.js` own source selection and health.
- `DesktopBridge/src/lyricsVault.js`, `DesktopBridge/src/bridgeVault.js`, and `DesktopBridge/src/exportRequestRegistry.js` own vault and export requests.
- `DesktopBridge/native/` contains the Windows media-session addon and Spotify seek helper.
- `DesktopBridge/docker/` and `DesktopBridge/Dockerfile` contain the Linux MPRIS runtime.
- `DesktopBridge/test/` contains mocked provider, vault, Spotify, relay, security, and picker regressions.
- `DesktopBridge/README.md` and `DesktopBridge/src/lyrics/README.md` are the local guides.

Desktop gotchas:

- `npm --prefix DesktopBridge run lint` is a syntax check, not an ESLint style check.
- `npm --prefix DesktopBridge test` uses Node's runner and mocked providers, not live credentials.
- Provider parts share one VM context, so top-level declarations become global across parts.
- Prefer the smallest relevant part file over the monolithic former service.
- Native Windows builds need Visual Studio C++ tools and .NET 9 when release assets are unavailable.

## CI, checks, and contract tests

- `.github/workflows/ci.yml` has repository, desktop, and mobile jobs. Repository runs docs, version, workflow, and contract checks. Desktop runs lint and tests. Mobile runs typecheck, lint, and the app test suite.
- `.github/workflows/ios-development-build.yml` produces the custom development IPA.
- `.github/workflows/ios-unsigned-ipa.yml` produces an unsigned IPA.
- `.github/workflows/android-apk.yml` builds Android APKs, including a development variant.
- `.github/workflows/build-native-binaries.yml` builds the Windows desktop release and native assets.
- `.github/workflows/docker-image.yml` builds the container image.
- `.github/workflows/pages.yml` publishes the website.
- `scripts/check-repository.cjs` checks required community files, Markdown files directly in the repository root, immediate Markdown children of `docs/`, `ExpoLyrics/docs/`, `scripts/`, and `.github/`, plus explicit `ExpoLyrics/README.md`, `ExpoLyrics/THIRD_PARTY_NOTICES.md`, `DesktopBridge/README.md`, `DesktopBridge/src/lyrics/README.md`, `website/README.md`, and `website/THIRD_PARTY_NOTICES.md`, and does not recurse. It checks Markdown links, documentation punctuation, pinned action SHAs, read-only permissions, and tracked secret-file exclusions. Backticked paths are not checked for existence.
- `scripts/release-version.js` checks that Desktop Bridge and ExpoLyrics versions and lockfiles match `ExpoLyrics/app.json`.
- `scripts/test/repository-check.test.cjs`, `scripts/test/release-publisher.test.cjs`, `scripts/test/ios-dev-ci.test.cjs`, and `scripts/test/android-generic-compat-harness.test.cjs` are repository contract tests.
- `scripts/ios-dev-ci/ci.cjs`, `scripts/ios-dev-ci/build-rust-device.sh`, `scripts/ios-dev-ci/rust-device.cjs`, `scripts/ios-dev-ci/package.py`, and `scripts/ios-dev-ci/validate_ipa.py` own iOS CI and IPA validation.
- `scripts/publish-production-release.sh`, `scripts/release-version.js`, and `DesktopBridge/forge.config.js` own release publishing.

## Root-scoped commands

Run from the repository root with dependencies already installed.

```sh
cargo +1.97.0 fmt --manifest-path native/lyrics-renderer/Cargo.toml --check
cargo +1.97.0 clippy --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 test --manifest-path native/lyrics-renderer/Cargo.toml
npm --prefix ExpoLyrics run typecheck
npm --prefix ExpoLyrics test
npm --prefix ExpoLyrics run test:lyrics
npm --prefix ExpoLyrics run test:lyrics-native
npm --prefix ExpoLyrics run test:vault
npm --prefix ExpoLyrics run test:spotify-detector
npm --prefix ExpoLyrics run test:spotify-browser
npm --prefix DesktopBridge run lint
npm --prefix DesktopBridge test
node --test scripts/test/*.test.cjs
node scripts/check-repository.cjs
node scripts/release-version.js
node ExpoLyrics/scripts/check-rust-gestures.cjs
node ExpoLyrics/modules/kinesync-rust-lyrics/android/check-jni-contract.cjs
```

## Cross-cutting gotchas

- There is no root `package.json`. Use `npm --prefix ExpoLyrics ...` or `npm --prefix DesktopBridge ...`.
- Documentation must contain no em dashes or semicolons. `scripts/check-repository.cjs` enforces this and checks relative Markdown links.
- Do not scan the whole repository for a subsystem task. Use this map and targeted searches.
- Do not push `main`. Work belongs on `rust-renderer-spike` unless a non-main branch is explicitly named.
- Use small per-item commits with author `Kineticron <kineticrondev@gmail.com>` and no AI coauthor trailers.
- Do not stop Metro, cancel CI, change build inputs, or restart services for docs-only work.
- Host tests do not prove iOS build success or visual parity. Verify native visual and touch changes on a device with the custom IPA.
- Use `.agents/skills/renderer-parity-fix/SKILL.md` for parity work and `.agents/skills/verify-changes/SKILL.md` to choose checks.
