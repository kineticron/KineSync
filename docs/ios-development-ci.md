# Device Debug CI checkpoint for the Rust renderer spike

This change optimizes the existing `iOS development build` workflow on
`rust-renderer-spike`. It does not implement an Expo module, build a Rust client,
change the production renderer, bump a version, sign an app or touch release
workflows. Stop here for coordinator independent review, branch transfer/push,
and two controlled macOS runs. Resume module work only after the coordinator
accepts this checkpoint.

No macOS build, remote cache publication, cold/warm speedup or LiveContainer
launch is validated by the Linux checks below. Real CI remains mandatory.

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

### Rust caching is provisioned, deliberately not enabled

`scripts/ios-dev-ci/config.json` fixes toolchain `1.97.0`, target
`aarch64-apple-ios`, Cargo `dev` profile, explicit features/RUSTFLAGS and Debug
configuration, with `rust.enabled=false`. There is no cargo build or
XCFramework producer in this checkpoint. An explicit guard fails if the switch
is enabled without replacing that guard in the next reviewed phase.

The prebuilt key covers Cargo.toml, Cargo.lock, the entire `src` directory
including WGSL, build.rs, crate/root Cargo configuration and toolchain files,
the existing included TTML fixture and the future producer path
`scripts/ios-dev-ci/build-rust-device.sh`. Missing files have explicit markers,
so adding one invalidates the key. Swift shims and JS are outside this hash.
The future producer must output and validate exactly the device-only
`KineSyncLyrics.xcframework` and its source/config manifest in the prebuilt
directory before the configured save step can be enabled.

The workflow orders source-exact prebuilt lookup before toolchain setup and
Swatinem/rust-cache. Thus a future verified prebuilt hit can skip Cargo entirely
for JS/shim-only edits. A miss will use the pinned Rust toolchain and cache the
registry and conventional crate `target/`. The action resolves that target to
the same absolute `CARGO_TARGET_DIR` supplied by the plan. We inspected the
pinned action source: its `workspace -> target` parser joins the target to the
workspace, so an absolute right-hand side is deliberately avoided.

Rust action steps, restores and saves are skipped at this checkpoint. The cold
lookup-only setting in the provisioned Rust action prevents downloading prior
entries, but the enabled Rust path still needs separate validation when its
producer exists. Current cold/warm evidence requirements cover the five active
caches, not nonexistent Rust artifacts. No Rust client cache hit is claimed.

## Triggers and the coordinator's controlled pair

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

The agent has not pushed or dispatched. After independent review, the
coordinator transfers this branch by the approved git bundle route and pushes
only `rust-renderer-spike` from DEFAULT `/home/kit/kinesync-dev`. The rescue
proxy route is not used. Do not run these commands from the implementation
agent or push any other branch.

Coordinator commands after the approved push, with a new epoch shared by both
runs and exactly the same source commit:

```bash
gh workflow run ios-development-build.yml \
  --repo kineticron/KineSync --ref rust-renderer-spike \
  -f cache_mode=cold -f cache_epoch=rust-ci-pair-20261111
```

Wait for completion and inspect the cold artifact and all five server lookups.
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
npm, lockfile, Pods, DerivedData and ccache. A miss, partial hit or failed server
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
an iOS app. No app runtime or Cargo source changed, so no Expo/npm/Cargo build is
claimed locally. The real macOS pair remains the next acceptance step.

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
