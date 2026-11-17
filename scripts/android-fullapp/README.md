# Android full-app physical-test harness

Test-only instrumentation for `dev.kineticron.KineSync`, paired with
[the fixture entry](../../ExpoLyrics/scripts/fixtures/fullapp-test-entry.js).
Production entry points and renderer sources are unchanged. Nothing here installs
or runs automatically. Use a disposable test app and device when executing later.

## Sources and preserved fixtures

`src/dev/kineticron/fullapp/FullAppRunner.java` is the reviewed patched runner,
unchanged from its supplied scratch source. The JS entry changes only relative
imports to work from its repository fixture location. The supplied originals are
preserved in `fixtures/original/` for comparison, not used as runnable entries.
The mock check compares seed values, lyrics, credits and fixture state definitions
with the original. It also checks measured targets, pixel conversion, exact seeks
with store state, matching links, stale tracks, orientation and failure gates.

Reviewed scratch SHA256 values before import relocation:

```text
FullAppRunner.java       82487444b8a01e8e037b97e9a191f02d9a090a0e706af9190cfc447d1fc9cbbc
fullapp-test-entry.js    fc7c6cec546ebbebb7ecf94d5b9a69c7227e2f672d28032108084e8f19a01cd2
```

Compared with the originals, the patched runner replaces blind seek/link tap
grids with real input taps at measured native hit-test targets. It requires exact
request acknowledgements, checks portrait and landscape geometry, recycles
screenshots and treats missing interaction evidence as a failure. The patched JS
wraps the real native view, forwards its commands, adds target probes and verifies
seek store anchors and fixture link URLs. Original fixture content is retained.

## Build the runner

From the repository root, set `JAVA_HOME` and `ANDROID_HOME` or `ANDROID_SDK_ROOT`
to an installed JDK and Android SDK. Defaults are platform `android-37.0` and build
tools `37.0.0`. Override with `ANDROID_API` and `ANDROID_BUILD_TOOLS` if needed.
Node and the SDK tools must already be installed.

```sh
node scripts/android-fullapp/build.mjs --compile-only
node scripts/android-fullapp/build.mjs
```

`build.sh` delegates to the same Node builder for Bash users. The builder replaces
only this harness's ignored `build/` directory, compiles Java 8 bytecode, runs D8,
packages the manifest and DEX, aligns the APK and writes badging, manifest and hash
reports. The default APK is unsigned. It cannot be installed until signed.

For an installable runner, set `FULLAPP_KEYSTORE` to an external local test key,
`FULLAPP_KEY_ALIAS` to its alias and `FULLAPP_KS_PASS` to its password. Optionally
set `FULLAPP_KEY_PASS` for a separate key password. Passwords are passed through
environment references rather than command arguments. Use the same signing
certificate as the target test app, as required for instrumentation.

```sh
node scripts/android-fullapp/build.mjs --sign
```

The signed output is `build/kinesync-fullapp-runner.apk`. Signature verification
also writes `build/signature.txt`. No keys or generated artifacts belong in git.

## Prepare a full-app test build

Install the app dependencies and generate its local Android project using the
normal Expo prebuild workflow in this worktree. Supply a local test signing
configuration. From `ExpoLyrics/android`, explicitly opt in to the fixture entry:

```sh
./gradlew assembleRelease -I ../../scripts/android-fullapp/test-entry.gradle
```

On Windows use `gradlew.bat`. The init script overrides only the selected build's
React entry and ensures it is bundled, including for debug variants. It does not
edit the app, package configuration or generated Gradle files. Keep the default
package `dev.kineticron.KineSync`. Omit the init script for normal app builds.
The harness needs a build with `KineSyncRustLyrics` and its native `hitTest`
command. The complete app build and this Gradle integration require verification
with installed project dependencies and the generated Android project.

## Execute later on an explicitly selected test device

These commands are documentation only. They were not executed during packaging.
Replace `DEVICE_SERIAL` and `TARGET_TEST_APK` with the intended test device and
locally built, signed fixture app. Both APKs must have matching certificates.

```sh
adb -s DEVICE_SERIAL install -r TARGET_TEST_APK
adb -s DEVICE_SERIAL install -r scripts/android-fullapp/build/kinesync-fullapp-runner.apk
adb -s DEVICE_SERIAL shell am force-stop dev.kineticron.KineSync
adb -s DEVICE_SERIAL shell am instrument -w dev.kineticron.fullapp/dev.kineticron.fullapp.FullAppRunner
adb -s DEVICE_SERIAL pull /sdcard/Android/data/dev.kineticron.KineSync/files/fullapp scripts/android-fullapp/evidence
```

The runner seeds onboarding and playback preferences, intercepts external links,
clears device log buffers, changes animation, font and rotation settings, and
attempts to restore the saved system settings at completion or failure. App
preferences remain seeded. A killed instrumentation process may prevent cleanup.
Use a fresh evidence directory and review `SUMMARY.txt`, `RUNNER-ERROR.txt` when
present, request logs, screenshots, accessibility trees, focus and crash reports.
Evidence may contain device details and logs. Keep it out of version control.

## Host verification and limits

```sh
node --check ExpoLyrics/scripts/fixtures/fullapp-test-entry.js
node --check scripts/android-fullapp/build.mjs
node --test scripts/test/android-generic-compat-harness.test.cjs
node --test scripts/test/*.test.cjs
node scripts/check-repository.cjs
node scripts/release-version.js
git diff --check
```

During packaging on RA-WINDOWS, JDK 22 and Android SDK platform and build tools
37.0 compiled, dexed, packaged and aligned the unsigned runner successfully.
Javac warned that source and target 8 are obsolete. No signing key was used.
Host mocks and compilation cannot prove native hit-test behavior, timing, actual
tap delivery, visual parity, orientation handling or cleanup on a physical device.
Several runner steps record evidence for manual review rather than assert visual
success. Rotation, lifecycle and settings steps are evidence-only and do not
assert success. The credits probe samples a grid of native hit-test coordinates,
so `TARGET_MISSING` does not exhaustively establish that a link is absent. The
AMLL fixture tests a same-track style transition, not fresh AMLL playback.
No physical test, installation, billing or API configuration change was
performed. Full app compilation, Metro bundling and Gradle init integration were
not run because this isolated checkout has no installed Expo dependencies or
generated Android app project.

See [VALIDATION.md](VALIDATION.md) for the exact host results and blockers.
