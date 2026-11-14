# Device Debug CI checkpoint for the Rust renderer spike

The phase-1 CI checkpoint at `37026fe` was reviewed before this phase-2 work.
The current implementation enables the real shared Rust static library and
Debug-only Expo Metal module, while keeping default production renderer
selection, versions, signing and release workflows unchanged. Final independent
review precedes the coordinator's **one integrated CI build**. The agent does
not push, dispatch, or operate Metro.

No macOS compile/link, remote cache publication, cold/warm speedup, device launch
or LiveContainer compatibility is validated by Linux checks. See the
[live integration guide](../native/lyrics-renderer/INTEGRATION.md).

## What changed

The workflow still builds an unsigned **Debug development client**, using
`-sdk iphoneos`, `generic/platform=iOS`, `ARCHS=arm64`,
`ONLY_ACTIVE_ARCH=YES` and `SUPPORTED_PLATFORMS=iphoneos`. It does not build a
simulator, x86_64 slice, Android target, archive fallback or Release app.
C and C++ use separate executable clang/clang++ wrappers through ccache.
Swift incremental work may benefit from DerivedData, but is not routed through
ccache. Signing and index-store work are disabled. `RCT_NO_LAUNCH_PACKAGER=1`
prevents the build from starting Metro.

After a successful build the helper reads the selected app's build settings,
checks its platform and inspects every regular Mach-O file in the bundle with
`lipo -archs`. Non-arm64 binaries fail the job. It always runs xcodebuild and
uses that app target's output path, never an arbitrary cached `.app`.

Expo prebuild uses `--clean --platform ios --no-install`. Native dependency
installation is separate, so caches can be restored before `pod install`.
The existing generated project has no tracked Podfile.lock. A small cache holds
the resolver's generated lockfile, keyed by native inputs. Warm runs restore it
first, then restore Pods and downloads by its actual SHA-256, then use
`pod install --deployment`. A first cold run resolves the lock normally. The
helper fails if a selected lockfile changes between restore and save. The actual
lockfile is also copied into the evidence artifact.

Only this workflow and its new helpers/tests are changed. No simulator harness
or large ci-sim changes were cherry-picked. The historical report at
`/home/kit/ci-speed-report.md` informed two specific fixes:

- Cache destinations are normalized to absolute runner paths once. Restore and
  save consume the same `steps.plan.outputs.path-*` values. No action receives a
  sibling `../...` pattern or an unresolved `env.HOME` expression.
- The `.app` is packaged before upload, preserving POSIX executable modes and
  symlinks in an inner IPA ZIP. Uploading loose app files can lose mode bits.

## Cache identities

All keys include schema version, branch hash, a controlled epoch and an
identity hash containing exact Xcode version/build, SDK version/build, selected
Developer directory, runner OS/arch, Node, Ruby, CocoaPods and ccache versions.
Debug, iphoneos and arm64 are explicit identity inputs.

| Cache | Identity and destination |
| --- | --- |
| npm downloads | package-lock.json and environment, owned absolute npm cache |
| Generated Podfile.lock | package.json/lock, app config, plugins, local modules, generated Podfile/properties and environment |
| Installed Pods and downloads | actual Podfile.lock SHA plus environment, absolute generated `ios/Pods` and resolved `~/Library/Caches/CocoaPods` |
| DerivedData | native inputs and actual Podfile.lock plus environment, Debug-only owned sibling directory |
| ccache | same native dependencies and environment, owned absolute directory |
| Rust prebuilt, disabled | crate source/config hash plus environment, owned `rust-device` directory |
| Rust registry and target, disabled | pinned Swatinem/rust-cache environment/lock identity and branch/epoch prefix |

DerivedData has no broad fallback. ccache can restore a compatible environment
prefix after a native-input miss, because its compiler results are content
addressed. Warm measurement still requires an exact key match for ccache.
`CCACHE_COMPILERCHECK=content`, a 2 GB limit and the checkout base directory are
set. No permissive ccache sloppiness flags are added. Xcode can still rebuild
work after restore due to source mtimes or generated project changes. Cache hits
do not themselves establish a speedup.

Actions caches are immutable. Source/native identity changes produce new keys.
A routine JS-only edit preserves native cache identities, but xcodebuild still
runs. Runner path or toolchain changes can cause misses and must not be described
as a successful controlled warm run. Required caches are saved after a successful
build/package. Controlled runs then do exact server lookups to detect failed
publication, including the historical invalid-path failure mode.

### Enabled source-exact Rust device caching

`scripts/ios-dev-ci/config.json` now enables the producer. It fixes toolchain
1.97.0, aarch64-apple-ios, Cargo dev profile, opt-level 1, debug-info 1, unwind
panics, iOS deployment 16.4 and explicit features/RUSTFLAGS. The app is Debug.
The producer builds the static library before prebuild/Pod installation, checks
arm64, creates one device-only XCFramework and verifies ABI symbols and hashes.

The key covers Cargo.toml/lock, Rust/WGSL source, C headers, build.rs, root/crate
Cargo and toolchain configuration, the included fixture and producer/validator
scripts. Swift/JS changes do not invalidate the Rust prebuilt key. Generated
module Frameworks are excluded from native-input hashing. Rust source/header
changes invalidate the app's DerivedData identity.

An exact prebuilt hit must pass source/config manifest, file hash, platform,
architecture, module-map and ABI-symbol validation before use. A miss installs
the pinned toolchain and uses Swatinem/rust-cache for registry and target work.
The action uses its supported standard target layout with absolute workspace
and the matching CARGO_TARGET_DIR. No simulator/x86_64 slice is built.

Controlled warm mode now also requires an exact Rust prebuilt hit and server
lookup. Current integration acceptance is one normal build, not an authorized
new cold/warm pair. Existing pair controls remain for separately approved work.

## Triggers and coordinator commands

The existing workflow path already has workflow_dispatch in the tracked
`origin/main` revision. GitHub requires the workflow to exist on the default
branch to accept dispatches, with `--ref` selecting the spike's version. This
change does not modify main or add a new default-branch workflow.

A spike push is filtered to the workflow/helpers/tests, Expo app, Rust crate,
fixture and Rust configuration paths. It runs only the lightweight Ubuntu
contract-validation job. It does not start an extra macOS build. The device job
requires explicit workflow_dispatch on `refs/heads/rust-renderer-spike` and a
successful contract job. Concurrency cancellation is scoped to workflow plus
ref. Wait for a run to finish before dispatching the next one.

The agent has not pushed or dispatched. After final independent review, the
coordinator transfers this branch by the approved git bundle route and pushes
only `rust-renderer-spike` from DEFAULT `/home/kit/kinesync-dev`. The rescue
proxy route is not used. Do not run these commands from the implementation
agent or push any other branch.

Current authorized coordinator validation after review and the approved branch
push is one integrated build, not both reference measurements below:

```bash
gh workflow run ios-development-build.yml \
  --repo kineticron/KineSync --ref rust-renderer-spike \
  -f cache_mode=normal -f cache_epoch=rust-phase2-integration
```

The following cold/warm commands are reference controls only and require separate
authorization. Use a new epoch shared by the pair and identical source commits:

```bash
gh workflow run ios-development-build.yml \
  --repo kineticron/KineSync --ref rust-renderer-spike \
  -f cache_mode=cold -f cache_epoch=rust-ci-pair-20261111
```

Wait for completion and inspect the cold artifact and all active server lookups.
Only then dispatch the second run:

```bash
gh workflow run ios-development-build.yml \
  --repo kineticron/KineSync --ref rust-renderer-spike \
  -f cache_mode=warm -f cache_epoch=rust-ci-pair-20261111
```

Do not reuse this example epoch if it already has an earlier pair. Allowed epoch
characters are letters, numbers, dash and underscore, length 1 through 40.
`cache_mode=normal` is supported for later routine manual builds without strict
hit requirements. It is not a replacement for the controlled pair.

Cold skips all managed restores and seeds new entries. Controlled cold and warm
runs require fresh owned directories before restore, without deleting existing
runner data. Preexisting CocoaPods/global/OS caches are recorded, not erased.
This is an Actions-managed cold/warm comparison, not a claim of cold hardware,
cold OS caches or dedicated-host isolation. Warm requires exact restores of
npm, lockfile, Pods, DerivedData, ccache and the enabled Rust prebuilt. A miss, partial hit or failed server
lookup fails the evidence gate while preserving evidence. Stop and investigate
instead of silently relabeling a miss as warm or dispatching extra builds.

## Evidence and artifact handling

The job publishes `ios-development-ci-evidence` even after a later stage failure
when initialization succeeded. Files from stages not reached are absent. It contains:

- `evidence.json` with SHA/ref/run/attempt, mode/epoch, exact tool identities,
  resolved paths, preexisting-directory flags, final cache keys, action outcomes,
  exact hits, matched keys, server lookups, gate results and stage timings.
- `stages.jsonl` for npm, prebuild, Pods, build, package and cache spans.
- The resolved Podfile.lock, selected-app architecture report, ccache statistics
  and the IPA manifest with every entry's mode, type and content hash.

Integrated builds additionally require the final host Mach-O `kr_*` symbol
inventory, app link map with Rust archive/render symbol, generated Expo provider
registration, compiled development JS bundle/source-map selection path and
source-exact XCFramework manifest. These are uploaded as `rust-link-proof.json`
and companion evidence files. A cached archive alone is not integration proof.
The export/mock-server bundler path does not listen on a Metro port.

Before packaging, Mach-O and CFBundleExecutable files are repaired to 0755.
The independent validator rejects any non-executable or missing code in the
source app and inner IPA, including equal-bad 0644 source/archive modes.

A matching table is appended to the Actions step summary. `xcodebuild` timing is
nested inside `build-and-validate`, so do not add those durations together.
Cache spans include action orchestration gaps. Checkout, Node/ccache setup,
artifact uploads and post-job cleanup are outside the measured helper spans.
Use the Actions job/workflow timestamps for the end-to-end comparison.
Report actual cold/warm durations and cache-hit evidence, not just proposed
savings. A successful pipeline and cache restores still do not test app launch.

`ExpoLyrics-development-ipa` contains the opaque `.ipa`, uploaded with artifact
compression level zero. `package.py` verifies ZIP CRC plus source/ZIP content,
file type, symlink target and POSIX mode equality before upload, addressing
framework executable permission loss. The manifest includes the IPA SHA-256.
After download, verify that hash, inspect the inner ZIP and use an extractor
that restores Unix permissions. Do not upload/extract/re-upload the loose app
and assume modes survived. Re-sign with a suitable device setup before trying
installation. **The unsigned IPA is not LiveContainer launch-tested.** No signing
credentials, provisioning profile or Apple account is used by this workflow.

## Local validation at this checkpoint

Run from `/home/kit/rust-renderer-spike`:

```bash
node --check scripts/ios-dev-ci/ci.cjs
node --test scripts/test/ios-dev-ci.test.cjs
node --test scripts/test/*.test.cjs
node scripts/check-repository.cjs
/tmp/rust-spike-actionlint/actionlint -shellcheck='' -pyflakes=''
git diff --check
```

The focused tests exercise cache invalidation, unchanged Rust keys after
JS/Swift edits, absolute cache destinations, restore/save contracts, lockfile
mutation rejection, a fake-toolchain runner initialization, stage failure and
warm-miss evidence, arm64 Debug build arguments, shell syntax, and a real ZIP
round trip preserving 0755 framework binaries and symlinks. They do not compile
an iOS app. The shared engine and app integration now also receive Rust and TypeScript
checks, documented in the integration guide. Swift/macOS linking and the one
real integrated CI build remain pending coordinator action.

Actionlint 1.7.12 was downloaded from its official release with SHA-256
`8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`.
Shellcheck and pyflakes integrations are disabled in that invocation. The Node
tests separately run `bash -n` on workflow shell commands and execute the Python
packaging helper against fixture directories.

## API sources checked

Chub searches did not provide relevant Actions cache entries. The implementation
uses these official docs and pinned action sources instead:

- [Manual workflow dispatch rules](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Expo prebuild CLI](https://docs.expo.dev/more/expo-cli/#prebuild)
- [Actions cache restore inputs](https://github.com/actions/cache/blob/0057852bfaa89a56745cba8c7296529d2fc39830/restore/action.yml)
- [Pinned Rust cache action](https://github.com/Swatinem/rust-cache/blob/d1527c8f67ef9af357290475d4af4b0fab8f12e0/action.yml)
- [Pinned Rust cache path parser](https://github.com/Swatinem/rust-cache/blob/d1527c8f67ef9af357290475d4af4b0fab8f12e0/src/config.ts)
- [Artifact permission limitations](https://github.com/actions/upload-artifact#permission-loss)
