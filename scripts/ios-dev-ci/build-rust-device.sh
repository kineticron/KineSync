#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_WORKSPACE:?}"
: "${CI_EVIDENCE_DIR:?}"
: "${RUST_PREBUILT_DIR:?}"
: "${RUST_DEVICE_KEY:?}"
cd "$GITHUB_WORKSPACE"
export SDKROOT="$(xcrun --sdk iphoneos --show-sdk-path)"
TOOLCHAIN=$(node -p 'require("./scripts/ios-dev-ci/config.json").rust.toolchain')
TARGET=$(node -p 'require("./scripts/ios-dev-ci/config.json").rust.target')
PROFILE=$(node -p 'require("./scripts/ios-dev-ci/config.json").rust.profile')
[[ "$TARGET" == aarch64-apple-ios && "$PROFILE" == dev ]]
FEATURES=$(node -p 'require("./scripts/ios-dev-ci/config.json").rust.features.join(",")')
FEATURE_ARGS=()
if [[ -n "$FEATURES" ]]; then FEATURE_ARGS=(--features "$FEATURES"); fi
cargo "+${TOOLCHAIN}" build --locked --lib --manifest-path native/lyrics-renderer/Cargo.toml \
  --target "$TARGET" --profile "$PROFILE" "${FEATURE_ARGS[@]}"
LIBRARY="${CARGO_TARGET_DIR}/${TARGET}/debug/liblyrics_renderer.a"
[[ $(xcrun lipo -archs "$LIBRARY") == arm64 ]]
HEADERS="${RUNNER_TEMP}/kinesync-rust-device-headers"
mkdir -p "$HEADERS" "$RUST_PREBUILT_DIR"
cp native/lyrics-renderer/include/KineSyncLyrics.h "$HEADERS/KineSyncLyrics.h"
printf 'module KineSyncLyrics {\n  header "KineSyncLyrics.h"\n  export *\n}\n' > "$HEADERS/module.modulemap"
xcodebuild -create-xcframework -library "$LIBRARY" -headers "$HEADERS" \
  -output "$RUST_PREBUILT_DIR/KineSyncLyrics.xcframework"
# Keep the entire defined-symbol inventory available to the validator, not just .a existence.
xcrun nm -gU "$LIBRARY" > "$CI_EVIDENCE_DIR/rust-static-nm.txt"
node scripts/ios-dev-ci/rust-device.cjs seal
