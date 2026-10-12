# Dependency maintenance

Reviewed on 2026-10-11. Install from the committed lockfiles with `npm ci`.
Use Node 22.13 or newer in the 22.x line (the repository default), or a supported
24.x/26.x runtime. Node 23 is outside Expo/React Native's supported engine ranges.

## Version constraints

DesktopBridge uses Electron 44.7.0 and Forge 8.0.1. Its Docker runtime shares the
same runtime dependency versions. The Windows media addon build reads the
Electron version from DesktopBridge/package.json, so future upgrades also update
the native build target automatically. The addon depends only on node-addon-api,
it must not link back to DesktopBridge and create a circular packaging tree.
Electron 44 requires macOS 13 or newer and no longer ships Windows ia32 or
Linux armv7l binaries, the existing Windows x64 release target is supported.
See [Electron's breaking changes](https://www.electronjs.org/docs/latest/breaking-changes/).

ExpoLyrics stays on its existing SDK 58 line. React Native 0.88.0-rc.4 matches
that SDK's current dependency recommendations. Keep AsyncStorage, FlashList,
Skia, gesture-handler, Reanimated, safe-area-context, screens, Worklets and
TypeScript on the SDK's coordinated versions, even when npm lists a newer
standalone release. `npm outdated` also lists SDK 57 packages as `latest`, those
are older than the installed SDK 58 packages.

Follow [Expo's upgrade instructions](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)
and run `npx expo install --check` and `npx expo-doctor` after updating. The
dependency manifests record the current compatible minimum versions.

## AMLL integration

AMLL 0.6 replaces the previous scroll handler with ScrollInteractionEngine and
changes calcLayout to accept LayoutReason. KineSync uses its upstream inertia
cancellation and frozen manual focus, with guarded build-time patches for
coalesced drag layouts, explicit Auto scroll, stale touch/wheel suppression and
the WebView animation wakeup event. Run the cluster and scrolling regressions
and rebuild both tracked WebView bundles after dependency changes.

## Security audit

DesktopBridge, its Docker runtime and the native addon have no npm audit findings
after this update. ExpoLyrics reports 24 findings (14 high, 10 moderate), stemming
from braces, node-forge and old uuid versions in Expo/Metro/ngrok/Xcode tooling.
The published braces and node-forge releases are still affected. Some audit
suggestions downgrade Expo to SDK 44 or React Native to 0.72, those are not valid
fixes for this SDK 58 application. Recheck upstream fixes before the next release.

## Validation notes

Desktop syntax checks, all 72 desktop tests, the Windows media addon build,
Windows Forge packaging and Squirrel installer creation, and an Electron smoke test of the addon, SQLite,
electron-store and a sandboxed renderer pass. Mobile typechecking, deterministic
tests, native lyric/motion checks, Android compatibility checks, Android/iOS
production JavaScript exports and the Android arm64 debug APK build pass.
Expo Doctor passes all 18 checks. Mobile lint
has no errors and two existing warnings.

Release notes are maintained directly on GitHub. iOS compilation and
physical-device playback are not verified on this Windows host. Validation used
the supported Node 24.19.0 runtime rather than the host's default Node 23.7.0.

The Android SDK's bundled Ninja 1.10.2 hits Windows long-path errors while
building Reanimated. [Reanimated's Windows build guide](https://docs.swmansion.com/react-native-reanimated/docs/guides/building-on-windows/)
requires Ninja 1.12 or newer. Native validation uses a SHA-256-verified Ninja
1.13.2 in `.cache/dependency-ninja` with a local Gradle init script selecting it:

```powershell
cd ExpoLyrics/android
./gradlew.bat :app:assembleDebug -PreactNativeArchitectures=arm64-v8a --init-script ../../.cache/dependency-ninja/init.gradle
```

This toolchain selection is local and does not change generated Android sources
or globally installed tools. Other developers should configure a current Ninja
according to the upstream build guide.
