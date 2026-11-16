The Android renderer uses the existing Rust staticlib and an Expo Kotlin/JNI module. Build Rust before Expo prebuild or Gradle. The Android runtime loads the JNI shared library, not the Rust .a archive directly. The module's CMake build links that archive into the JNI library.

From the repository root, run `bash scripts/build-rust-lyrics-android.sh`. This defaults to arm64-v8a and x86_64. Pass one ABI, a comma-separated ABI list, or `universal` to select architectures. Universal explicitly builds armeabi-v7a, arm64-v8a, x86, and x86_64 to match React Native's four-ABI APK. Unsupported ABI names fail immediately. A failed Rust build stops the workflow before Gradle, rather than producing an APK missing a requested renderer library.

Use Rust 1.97.0 and cargo-ndk 4.1.2. Install Java 17, Android SDK command-line tools, the platform and build tools required by the generated Expo project, and the NDK version from `ExpoLyrics/node_modules/react-native/gradle/libs.versions.toml`. Set ANDROID_HOME to the SDK and ANDROID_NDK_HOME to that NDK installation. The APK workflow installs the matching NDK and pinned Rust tooling. The build script installs only the requested Rust target standard libraries. It builds release-optimized, locked dependencies against Android API 24 even for development APKs.

Each archive is copied from Cargo's target directory into `ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/jniLibs/ABI/liblyrics_renderer.a`. The script respects CARGO_TARGET_DIR and removes requested destination archives before rebuilding so an unsuccessful rebuild cannot be mistaken for a fresh one. cargo-ndk's output-directory option copies shared libraries, so the script copies static archives explicitly. Generated archives are not source files and must not be committed.

The Android APK workflow is `.github/workflows/android-apk.yml`. It builds Rust before Expo prebuild, then passes the exact same ABI list through `-PreactNativeArchitectures` to Gradle. A manual x86 dispatch still targets the existing 32-bit BlueStacks instance. All four architectures need real build verification before claiming universal support. Host Rust tests and shell mocks do not establish Android cross-compilation or JNI link success.

To verify unpushed code locally, use a disposable checkout containing the current source and local module, with installed Expo dependencies. With SDK, NDK, and Java configured, run these commands from that checkout's root. A single ABI is useful for the first native compile check.

```sh
cargo +1.97.0 install cargo-ndk --version 4.1.2 --locked
bash scripts/build-rust-lyrics-android.sh arm64-v8a
cd ExpoLyrics
npx --no-install expo prebuild --clean --platform android --no-install
cd android
./gradlew --no-daemon --stacktrace --max-workers=2 '-Dorg.gradle.jvmargs=-Xmx3g' -PreactNativeArchitectures=arm64-v8a :app:assembleDebug
```

Use a disposable checkout because prebuild cleans the generated Android project. Debug assembly can use the local debug keystore and does not require production signing secrets. This validates Kotlin, CMake, JNI, Rust linking, and packaging. It does not validate touch behavior, GPU rendering, device compatibility, or a production release signature. Inspect the resulting APK's native library entries, then run it on an Android device or emulator. Repeat the Rust build and Gradle assembly for the full universal ABI set before publishing a universal APK.

At implementation time, rescue has only about 3.2 GB free, Java 25, and no configured SDK or NDK. That is not a safe place to install a complete Android toolchain plus native build outputs. Verification was staged separately on default at `/home/kit/android-port-verify/repo`, with SDK, NDK, full JDK 17, Cargo output and Gradle caches under the parent verification directory. The preinstalled Java 21 there is a JRE without a Java compiler. The verification SDK platform package is named Android 37.0, not Android 37. Both arm64-v8a and x86_64 Rust release cross-builds passed using the staged current source. The module's Gradle debug assembly passed, including the JNI shared-library link. Full-app Gradle assembly encountered memory-cgroup OOM kills during Skia compilation and dex merging. Local verification uses one Gradle worker, a 1200 MB Java heap, 512 MB maximum metaspace, in-process Kotlin compilation and CMAKE_BUILD_PARALLEL_LEVEL set to 1. The full arm64 debug APK subsequently assembled successfully. ZIP and ELF inspection confirmed the packaged AArch64 JNI library with all 15 JNI exports, both font assets, only the requested ABI, and no static archives. This is build and packaging proof, not a device runtime test or full universal build proof. A dispatch of an existing remote workflow cannot verify unpushed edits.

There is a separate iOS production gap. `.github/workflows/ios-unsigned-ipa.yml` does not build the Rust XCFramework required by the local module's podspec. The iOS development workflow has Rust framework tooling, but that does not establish production support. This Android change does not fix that gap, remove Skia, or remove the existing iOS development-only runtime gate.

The cargo-ndk command and environment behavior were checked against https://github.com/bbqsrc/cargo-ndk. The local documentation catalog had no cargo-ndk entry.
