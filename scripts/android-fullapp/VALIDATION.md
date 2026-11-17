# Packaging and orientation-fix validation

The initial results below describe packaging commit `d66a046`. The follow-up
section records the current orientation dependency fix and supersedes the earlier
source hashes, source-comparison description and dependency-related blockers.

Base: `a02c9f868af5495b818197770a5a241762c3ab06`, matching the local
`origin/development` ref. Work was confined to this isolated worktree on
`t3/android-test-harness`. No remote fetch or push was performed.

Host: RA-WINDOWS, Windows PowerShell, Node 23.7.0, OpenJDK 22.0.2,
Android platform `android-37.0`, build tools `37.0.0`. Node 23.7.0 is outside
the app's declared engine ranges. No dependencies or toolchains were installed.

| Check | Result |
| --- | --- |
| Supplied patched source SHA256 | Both matched the supplied hashes |
| Packaged source comparison | Runner unchanged, JS only changes six relative imports |
| Original source retention | Both supplied originals preserved byte for byte before git line normalization |
| Fixture definition comparison | Seeds, lyrics, credits and state definitions match the original |
| `node --check ExpoLyrics/scripts/fixtures/fullapp-test-entry.js` | Passed |
| `node --check scripts/android-fullapp/build.mjs` | Passed |
| `bash -n scripts/android-fullapp/build.sh` | Passed |
| Harness documentation punctuation and local links | Passed |
| `node --test scripts/test/android-generic-compat-harness.test.cjs` | Passed |
| `node scripts/android-fullapp/build.mjs` | Java compile, JAR, D8, APK packaging and alignment passed |
| `node --test scripts/test/*.test.cjs` | 29 tests, 19 passed, 10 failed in the existing iOS CI test file |
| `node scripts/check-repository.cjs` | Passed, 43 documents plus action and credential-file checks |
| `node scripts/release-version.js` | Passed, version 1.3.0 |
| `npm run typecheck` from ExpoLyrics | Failed with missing app dependencies and missing `expo/tsconfig.base` |
| `npm test` from ExpoLyrics | Stopped at `check-bridge-lifetime.cjs`, missing `typescript` |
| `git diff --check` and staged diff check | Passed |

The unsigned runner APK was generated only under ignored `build/`. SHA256:

```text
a71ffa5165b02b08f60043020118b3f3c962a1188df045e98807343deeba6bce
```

Badging confirmed package `dev.kineticron.fullapp`, minimum SDK 26 and target SDK
35. AAPT2 manifest inspection confirmed the instrumentation target package.
Javac emitted three warnings for obsolete source and target 8. Signing and
certificate verification were not exercised because no signing key was used.

The ten failures are all in the unchanged `scripts/test/ios-dev-ci.test.cjs`:

| Test location | Observed failure |
| --- | --- |
| Line 30, normalized cache paths and flags | Expected compiler argument ending in `/clang` |
| Line 144, IPA ZIP metadata | Symlink creation rejected with EPERM |
| Line 186, runner initialization | `xcodebuild` unavailable |
| Line 225, executable validator | Expected file mode 0644, observed 0666 |
| Line 334, Rust cache verifier | `plutil` unavailable |
| Line 404, Rust producer arguments | `/bin/bash` unavailable |
| Line 484, producer sealing | `plutil` unavailable |
| Line 555, frame source contract | Extracted function raised `Unexpected token '}'` |
| Line 671, ABI layout and guards | Compiler subprocess returned null status instead of zero |
| Line 713, pod font resources | Existing resource-path assertion failed |

These failures were not repaired as part of harness packaging. The complete app,
Metro bundle and opt-in Gradle init script could not be built without installed
app dependencies and a generated Android app project. No physical execution,
installation, visual parity, native interaction or device cleanup was verified.
Rotation, lifecycle and settings steps are evidence-only, not success assertions.
The credits probe samples a grid, so `TARGET_MISSING` is not exhaustive. The AMLL
fixture covers a same-track style transition, not fresh AMLL playback.

## Orientation dependency fix

Removed the fixture's static `expo-screen-orientation` import and JS orientation
deep-link handler. No package manifest, lockfile or production dependency changed.
The runner now checks rotation acceptance and polls display geometry. For every
seek/link fixture it additionally requires request-scoped app-window dimensions
with the requested aspect and finite positive canvas dimensions before tapping.
Window evidence is emitted before target scanning, even if no target is found.
It cannot infer app-window orientation from the rotated display alone.

An app or tour orientation lock must yield for the interaction setup to pass.
Rejected rotation, missing window evidence and orientation mismatches are setup
failures. They enter the same hard-failure list as interaction failures, so inspect
`SETUP_` logs and request evidence before attributing failure to a renderer.
The final portrait request before settings is display-only and explicitly leaves
app-window orientation unverified. Settings and rotation screenshot steps remain
evidence-only. Credits sampling and same-track AMLL fixture limitations still apply.

The two original source fixtures remain hash-checked and unchanged. Runtime seed,
lyrics, credits and state definitions still match the original. The runnable
sources now differ from the reviewed scratch hashes listed in the README.
The import regression scans all static requires for lockfile package presence
and local source paths, and demonstrates rejection of the previously missing
module. It does not establish complete Metro resolution. The VM also checks
window evidence for landscape and a letterboxed portrait app independently from
canvas dimensions. Runner source checks guard rotation acceptance and app-window
aspect gates, but do not execute Android instrumentation behavior.

Dependencies were installed only in this worktree with
`npm ci --ignore-scripts --no-audit --no-fund`. It added 1014 ignored packages and
reported engine warnings under Node 23.7.0. No other worktree or device was used.

| Follow-up check | Result |
| --- | --- |
| Updated harness mock and fixture/import checks | Passed |
| Runner Java compile, D8, APK packaging and alignment | Passed with the same three Java 8 warnings |
| Offline Android Metro fixture bundle after final source edits | Passed, 2300 modules and 33 assets |
| `npm run typecheck` from ExpoLyrics | Passed |
| `npm test` from ExpoLyrics | Passed |
| Repository Node suite | 19 passed, same 10 existing iOS CI failures listed above |
| Repository and release-version checks | Passed, version 1.3.0 |
| Fixture syntax, documentation links and punctuation, diff checks | Passed |

Exact offline bundle command, from `ExpoLyrics`:

```sh
node node_modules/expo/bin/cli export:embed --entry-file scripts/fixtures/fullapp-test-entry.js --platform android --dev false --minify false --max-workers 2 --bundle-output ../scripts/android-fullapp/evidence/host-fix/fullapp.android.bundle --assets-dest ../scripts/android-fullapp/evidence/host-fix/assets
```

Expo logs say `Starting Metro Bundler`, but this export path uses
`mockServer: isExporting` and does not bind an HTTP listener. The drag thread's
sole normal-entry Metro and its reserved devices were not touched.

The rebuilt unsigned runner SHA256 is:

```text
270b8e9d2c1073cccf2468879ddd789e104446c623405a4d1bc6238b79d4e260
```

All generated packages, bundle assets and logs remain ignored. Signing, full app
compilation, Gradle init integration and physical behavior remain unverified.
No physical test, device command, billing change or push was performed.
