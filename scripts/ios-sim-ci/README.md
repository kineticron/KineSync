# Isolated simulator CI

The `iOS simulator build` workflow runs on dispatch and path-filtered pushes to
`development`. It builds an unsigned Debug arm64 `iphonesimulator` app ZIP.
The device workflow and its cache namespace are unchanged. No Revyl credentials,
upload, or workflow dispatch are part of these scripts.

Debug is intentional. The Rust view is gated by `__DEV__` and its Expo module
uses `debugOnly` registration. CI forces React Native bundling with an empty
`SKIP_BUNDLING` value. A simulator-only patch to the installed, locked
`expo-dev-launcher` 58.0.12 controller checks `viewModel.hasEmbeddedBundle` and
calls `loadLocalBundle`. The patch fails on version or context drift.

Validation covers the current Rust ABI 11 using the pinned Rust LLVM tools,
source-exact linked archive bytes, final exported symbols, module registration,
font bytes, and markers in the actual packaged JavaScript or Hermes bytecode.
Every nested Mach-O must contain only arm64 simulator code. Main app and widget
executables must both be inspected. ZIP validation preserves bytes, types,
executable modes, and internal symlinks.

Smoke testing creates and deletes its own fresh compatible iPhone simulator.
It requires OCR of both `KineSync` and `Start Setup`, plus onboarding context,
and rejects launcher or bundle error text. It checks for local Metro listeners
before and after startup and saves screenshots and OCR attempts. This proves
onboarding startup without a local Metro listener. It does not establish full
network isolation or Rust renderer runtime behavior.

## Cache measurement

Use the same commit, branch, toolchain, and new `cache_epoch` for a controlled
`cold` then `warm` pair on fresh runners. Cold skips managed restores and seeds
caches after a successful build and smoke. Warm requires exact restores. Both
require exact server publication lookups. Existing owned cache data causes a
controlled run to fail rather than delete it. CocoaPods downloads use an
isolated `CP_CACHE_DIR`. Compiler caches, DerivedData, Rust simulator output,
npm downloads, and native dependencies use simulator-specific keys.

Evidence records actual cache outcomes, stage timings, build settings, Rust
archive identity, embedded bundle hashes, ZIP contents, and smoke results.
Failure summaries do not claim successful smoke. Cache measurements and all
macOS runtime behavior still require real CI runs.

## Local verification

Run the repository checks from `AGENTS.md` and validate workflow syntax with
`actionlint`. The existing device fixture mode test assumes umask `022`.

The simulator suite also has real tool integration tests. Enable them after
installing the pinned Rust toolchain with `llvm-tools-preview` and target
`aarch64-apple-ios-sim`, and installing the locked Expo dependencies:

```sh
KINESYNC_SIM_NATIVE_TOOLS_TEST=1 node --test scripts/test/ios-sim-ci.test.cjs
```

The integration tests compile real thin-LTO simulator static archives for ABI
11 and a rejected ABI 10, then inspect the extracted ABI object with matching
Rust LLVM tools. They compile real Hermes bytecode with ASCII and UTF-16 strings
and pass those bytes through both bundle scanners. The workflow runs these
tests before building the app. Linux tool tests do not establish Xcode build
success, simulator boot success, onboarding OCR success, or renderer parity.

Artifact format follows the [Revyl artifact requirements](https://docs.revyl.com/builds/artifact-requirements).
