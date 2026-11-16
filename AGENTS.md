KineSync agent guide

Read only the files needed for the task. Use this map and targeted searches instead of rescanning the repository. Check git status before editing and preserve unrelated work.

ExpoLyrics/ is the Expo React Native app, with routes in app/, renderers in components/lyrics/, shared logic in lib/, and regression checks in scripts/.
native/lyrics-renderer/ is the Rust wgpu, vello, and parley renderer crate.
ExpoLyrics/modules/kinesync-rust-lyrics/ is the Expo native module. Its ios/KineSyncRustLyricsModule.swift owns the Metal view, display link, touch handling, and C bridge.
DesktopBridge/ is the optional desktop playback bridge and includes shared TTML fixtures in test/fixtures/.
scripts/ contains repository, release, and iOS CI tooling. scripts/test/ contains Node regression tests.
.github/workflows/ contains CI and build automation. ci.yml runs repository and app checks. ios-development-build.yml produces the custom development IPA.
website/ is the public website. Read its own AGENTS.md before working there.

Renderer map, relative to native/lyrics-renderer/src/
ffi.rs defines the C ABI, handles, validation, and native entry points.
gpu.rs owns GPU resources, rendering, and effect passes.
scene.rs builds lyric scenes and geometry.
typography.rs shapes and lays out glyphs.
style_timing.rs defines style timing and priming behavior.
appearance.rs defines visual appearance transitions.
blur.wgsl, downsample.wgsl, composite.wgsl, and surface.wgsl are the four custom GPU shaders.
lib.rs contains the packet and timing model. live.rs manages the live renderer.
interlude.rs implements dots. credits.rs handles end credits.

The unchanged Skia AMLL and Spicy renderers are the visual reference, not edit targets.
Start at ExpoLyrics/components/lyrics/native-amll-lyrics-view.tsx and native-spicy-lyrics-view.tsx.
Their shared reference code is in ExpoLyrics/components/lyrics/native/, including native-lyrics-view.tsx, native-lyric-row.tsx, native-interlude-motion.ts, reference-motion.ts, and style-specific layout helpers.
The Rust JS entry is ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx.
Gesture ownership is in ExpoLyrics/lib/rust-lyrics-gesture.js and the Swift module.
No WebView renderer work. Do not alter the reference to make a Rust regression pass.

Run these commands from the repository root with existing dependencies installed.
On rescue, plain cargo has no configured default. Explicit +1.97.0 works.
Use an installed project-compatible toolchain elsewhere rather than installing or changing defaults blindly.

```sh
cargo +1.97.0 fmt --manifest-path native/lyrics-renderer/Cargo.toml --check
cargo +1.97.0 clippy --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 test --manifest-path native/lyrics-renderer/Cargo.toml
(cd ExpoLyrics && npm run typecheck)
(cd ExpoLyrics && npm test)
node ExpoLyrics/scripts/check-rust-gestures.cjs
node --test scripts/test/*.test.cjs
node scripts/check-repository.cjs
node scripts/release-version.js
```

All commands above passed on rescue before this guide was committed. Host tests do not establish iOS build success or visual parity. Verify the custom IPA on device for native visual or touch changes.

ABI changes must stay consistent across native/lyrics-renderer/src/ffi.rs, native/lyrics-renderer/include/KineSyncLyrics.h, ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift, and ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx.
Current ABI is 8. When changing the ABI contract, bump the Rust return and tests, header contract, Swift guard, and JS guard together. Rebuild the development client. Do not bump for documentation-only changes.

Never push main. This work belongs on rust-renderer-spike unless the user explicitly names another non-main branch.
Make small per-item commits with author Kineticron <kineticrondev@gmail.com>. Do not add AI coauthor trailers.
Documentation must contain no em dashes or semicolons.
Do not stop Metro, cancel CI, change build inputs, or restart services for docs-only work.
Use .agents/skills/renderer-parity-fix/SKILL.md for parity work and .agents/skills/verify-changes/SKILL.md to choose checks.
