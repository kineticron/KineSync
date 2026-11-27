#!/usr/bin/env bash
# Build the static Rust archive consumed by the Android module's JNI shim.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate="${root}/native/lyrics-renderer"
output="${root}/ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/jniLibs"
build_kind="${KINESYNC_BUILD_KIND:-release}"
features=()
case "${build_kind}" in
  development) features=(--features dev-render-metrics) ;;
  release) ;;
  *) echo "Invalid KINESYNC_BUILD_KIND: ${build_kind}" >&2; exit 2 ;;
esac
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${crate}/target}"
# Cargo resolves relative target directories from its working directory.
cd "${root}"
mkdir -p "${CARGO_TARGET_DIR}"
CARGO_TARGET_DIR="$(cd "${CARGO_TARGET_DIR}" && pwd)"
export CARGO_TARGET_DIR

# Match React Native's universal APK rather than silently omitting 32-bit libs.
if [[ $# -eq 0 ]]; then
  set -- arm64-v8a x86_64
elif [[ $# -eq 1 && "$1" == universal ]]; then
  set -- armeabi-v7a arm64-v8a x86 x86_64
elif [[ $# -eq 1 ]]; then
  IFS=, read -r -a requested <<< "$1"
  set -- "${requested[@]}"
fi
abis=("$@")
if [[ ${#abis[@]} -eq 0 ]]; then
  echo 'At least one Android ABI is required.' >&2
  exit 2
fi
triples=()
for abi in "${abis[@]}"; do
  case "${abi}" in
    arm64-v8a) triples+=(aarch64-linux-android) ;;
    x86_64) triples+=(x86_64-linux-android) ;;
    armeabi-v7a) triples+=(armv7-linux-androideabi) ;;
    x86) triples+=(i686-linux-android) ;;
    *) echo "Unsupported Android ABI '${abi}'. Use arm64-v8a, x86_64, armeabi-v7a, x86, or universal." >&2; exit 2 ;;
  esac
done

if [[ -z "${ANDROID_NDK_HOME:-}" || ! -f "${ANDROID_NDK_HOME}/source.properties" ]]; then
  echo 'Set ANDROID_NDK_HOME to an installed Android NDK root.' >&2
  exit 1
fi
if ! cargo +1.97.0 ndk --version >/dev/null 2>&1; then
  echo 'Install cargo-ndk with cargo +1.97.0 install cargo-ndk --version 4.1.2 --locked.' >&2
  exit 1
fi
rustup target add --toolchain 1.97.0 "${triples[@]}"
# cargo-ndk discovers crate metadata before forwarding Cargo build arguments.
cd "${crate}"

# Prevent an unsuccessful rebuild from leaving an old archive for Gradle to use.
for abi in "${abis[@]}"; do
  rm -f "${output}/${abi}/liblyrics_renderer.a"
done
for i in "${!abis[@]}"; do
  abi="${abis[$i]}"
  triple="${triples[$i]}"
  cargo +1.97.0 ndk --target "${abi}" --platform 24 \
    build --manifest-path "${crate}/Cargo.toml" --lib --release --locked "${features[@]}"
  archive="${CARGO_TARGET_DIR}/${triple}/release/liblyrics_renderer.a"
  if [[ ! -s "${archive}" ]]; then
    echo "Missing Rust static archive for ${abi}: ${archive}" >&2
    exit 1
  fi
  node "${root}/scripts/check-release-diagnostics.cjs" rust-archive "${archive}" "${build_kind}"
  # cargo-ndk's -o copies shared libraries, not this crate's staticlib.
  mkdir -p "${output}/${abi}"
  cp "${archive}" "${output}/${abi}/liblyrics_renderer.a"
  printf 'Built %s\n' "${output}/${abi}/liblyrics_renderer.a"
done
