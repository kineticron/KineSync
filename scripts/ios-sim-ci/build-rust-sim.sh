#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_WORKSPACE:?}"
: "${CI_EVIDENCE_DIR:?}"
: "${RUST_SIM_PREBUILT_DIR:?}"
: "${RUST_SIM_KEY:?}"
cd "$GITHUB_WORKSPACE"
export SDKROOT="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TOOLCHAIN=$(node -p 'require("./scripts/ios-sim-ci/config.json").rust.toolchain')
TARGET=$(node -p 'require("./scripts/ios-sim-ci/config.json").rust.target')
PROFILE=$(node -p 'require("./scripts/ios-sim-ci/config.json").rust.profile')
[[ "$TARGET" == aarch64-apple-ios-sim && "$PROFILE" == release ]]
FEATURES=$(node -p 'require("./scripts/ios-sim-ci/config.json").rust.features.join(",")')
set -- "+${TOOLCHAIN}" build --locked --lib --manifest-path native/lyrics-renderer/Cargo.toml \
  --target "$TARGET" --profile "$PROFILE"
if [[ -n "$FEATURES" ]]; then set -- "$@" --features "$FEATURES"; fi
cargo "$@"
LIBRARY="${CARGO_TARGET_DIR}/${TARGET}/release/liblyrics_renderer.a"
[[ $(xcrun lipo -archs "$LIBRARY") == arm64 ]]
HEADERS="${RUNNER_TEMP}/kinesync-rust-simulator-headers"
mkdir -p "$HEADERS" "$RUST_SIM_PREBUILT_DIR"
cp native/lyrics-renderer/include/KineSyncLyrics.h "$HEADERS/KineSyncLyrics.h"
printf 'module KineSyncLyrics {\n  header "KineSyncLyrics.h"\n  export *\n}\n' > "$HEADERS/module.modulemap"
xcodebuild -create-xcframework -library "$LIBRARY" -headers "$HEADERS" \
  -output "$RUST_SIM_PREBUILT_DIR/KineSyncLyrics.xcframework"
node scripts/ios-sim-ci/rust-sim.cjs seal
