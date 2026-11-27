const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflows = path.resolve(__dirname, '../../.github/workflows');
const read = name => fs.readFileSync(path.join(workflows, name + '.yml'), 'utf8');
const android = read('android-apk');
const ios = read('ios-unsigned-ipa');
const iosDev = read('ios-development-build');
const windows = read('build-native-binaries');

function findStep(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing workflow step "${name}"`);
  const end = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, end < 0 ? undefined : end).split('\n  publish')[0];
}

function cachePaths(step) {
  const match = step.match(/\n          path: ([\s\S]*?)\n          key:/);
  assert.ok(match, 'Cache must declare its path and key');
  return match[1];
}

function assertSave(workflow, restoreName, saveName, uploadName) {
  const restore = findStep(workflow, restoreName);
  const save = findStep(workflow, saveName);
  assert.match(restore, /uses: actions\/cache\/restore@0057852bfaa89a56745cba8c7296529d2fc39830/);
  assert.match(save, /uses: actions\/cache\/save@0057852bfaa89a56745cba8c7296529d2fc39830/);
  assert.match(save, /if: success\(\) && .*\.outcome == 'success'.*\.outputs\.key != ''/);
  assert.match(save, /continue-on-error: true/);
  assert.equal(cachePaths(restore), cachePaths(save));
  assert.ok(workflow.indexOf(save) > workflow.indexOf(findStep(workflow, uploadName)));
}

test('Android cold and warm share native cache identities and account for every restore', () => {
  assert.match(android, /options: \[normal, cold, warm\]/);
  assert.match(android, /cold\|warm\)[\s\S]*?\$CACHE_EPOCH.*routine/);
  assert.match(findStep(android, 'Setup Node'), /CACHE_MODE == 'normal' && 'npm'/);

  const cargoNdk = findStep(android, 'Restore cargo-ndk binaries');
  const gradle = findStep(android, 'Restore Gradle downloads');
  for (const restore of [cargoNdk, gradle]) {
    assert.match(restore, /if: env\.CACHE_MODE != 'cold'/);
    assert.doesNotMatch(restore, /fail-on-cache-miss:/);
  }
  assert.doesNotMatch(cargoNdk, /restore-keys:/);
  assert.match(gradle, /restore-keys: \$\{\{ steps\.gradle_key\.outputs\.prefix \}\}/);
  assert.match(findStep(android, 'Identify Gradle downloads'),
    /prefix="android-gradle-downloads-v2-\$\{RUNNER_OS\}-\$\{RUNNER_ARCH\}-\$\{CACHE_EPOCH\}-\$\{java_identity\}-\$\{RUST_ANDROID_NDK_ID\}-\$\{wrapper\}-"/);
  const ndkInstall = findStep(android, 'Install or verify cargo-ndk');
  assert.match(android, /RUST_ANDROID_CARGO_NDK: "4\.1\.2"/);
  assert.match(ndkInstall, /install cargo-ndk --version "\$RUST_ANDROID_CARGO_NDK" --locked/);
  assert.match(ndkInstall, /env -u CARGO_TARGET_DIR/);
  const gradleSetup = findStep(android, 'Setup Gradle');
  assert.match(gradleSetup, /gradle\/actions\/setup-gradle@8da46b539cd8fe6ab27ca75128919a18d757604c/);
  assert.match(gradleSetup, /cache-provider: external/);
  assert.match(cachePaths(gradle), /caches\/modules-2\n[^\n]+wrapper\/dists$/);
  assert.match(findStep(android, 'Bound Gradle download cache'), /1048576/);
  const summary = findStep(android, 'Summarize Android cache evidence');
  for (const cache of ['npm', 'Rust registry and targets', 'cargo-ndk binaries', 'Gradle downloads']) {
    assert.ok(summary.includes(cache));
  }
  assertSave(android, 'Restore cargo-ndk binaries', 'Save cargo-ndk binaries', 'Upload APK artifact');
  assertSave(android, 'Restore Gradle downloads', 'Save Gradle downloads', 'Upload APK artifact');
});

test('Rust caches keep target mappings and publish after successful builds within their size limits', () => {
  const androidRust = findStep(android, 'Cache Android Rust dependencies and target work');
  const iosRust = findStep(ios, 'Cache iOS Release Rust dependencies and target work');
  for (const step of [androidRust, iosRust]) {
    assert.match(step, /Swatinem\/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0/);
    for (const input of ['cache-targets', 'cache-all-crates', 'cache-workspace-crates']) {
      assert.ok(step.includes(`${input}: true`));
    }
    assert.match(step, /cache-bin: false/);
    assert.match(step, /cache-on-failure: false/);
    assert.match(step, /save-if: \$\{\{ env\.RUST_CACHE_WITHIN_BUDGET == 'true' \}\}/);
  }
  assert.match(androidRust, /workspaces: native\/lyrics-renderer -> target/);
  assert.match(androidRust, /lookup-only: \$\{\{ env\.CACHE_MODE == 'cold' \}\}/);
  assert.match(androidRust, /prefix-key: \$\{\{ steps\.native\.outputs\.rust_prefix \}\}/);
  assert.match(findStep(android, 'Identify Android Rust caches'), /rust_prefix=android-rust-v1-\$\{CACHE_EPOCH\}/);
  const iosIdentity = findStep(ios, 'Set up the iOS Release Rust toolchain');
  assert.match(iosIdentity, /target_dir="\$RUNNER_TEMP\/kinesync-release-cargo"/);
  assert.match(findStep(ios, 'Identify iOS Release compiler caches'), /relative\("native\/lyrics-renderer", process\.argv\[1\]\)/);
  assert.match(iosRust, /workspaces: native\/lyrics-renderer -> \$\{\{ steps\.compiler_key\.outputs\.relative_target_dir \}\}/);
  const iosBuild = findStep(ios, 'Prepare Rust lyrics framework for iOS Release');
  for (const envVar of ['CARGO_TARGET_DIR', 'IPHONEOS_DEPLOYMENT_TARGET', 'RUSTFLAGS',
    'CARGO_PROFILE_RELEASE_OPT_LEVEL', 'CARGO_PROFILE_RELEASE_DEBUG',
    'CARGO_PROFILE_RELEASE_LTO', 'CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS']) {
    const envLine = iosRust.split('\n').find(line => line.trimStart().startsWith(`${envVar}:`));
    assert.ok(envLine && iosBuild.includes(envLine), `Rust key and build disagree on ${envVar}`);
  }
  assert.match(findStep(android, 'Bound Android Rust and cargo-ndk caches'), /2621440.*RUST_CACHE_WITHIN_BUDGET=true/);
  assert.match(findStep(ios, 'Bound iOS Release Rust cache'), /1572864.*RUST_CACHE_WITHIN_BUDGET=true/);
  const devCache = findStep(iosDev, 'Cache Rust registry and device target work on a prebuilt miss');
  assert.match(devCache, /cache-on-failure: false/);
  assert.match(devCache, /save-if: true/);
});

test('iOS Release and Windows cache download inputs without caching generated artifacts', () => {
  assertSave(ios, 'Restore CocoaPods release downloads', 'Save CocoaPods release downloads', 'Upload IPA artifact');
  assertSave(windows, 'Restore Windows native downloads', 'Save Windows native downloads', 'Upload native artifacts for publisher');
  const pods = findStep(ios, 'Restore CocoaPods release downloads');
  assert.ok(ios.indexOf(pods) < ios.indexOf(findStep(ios, 'Expo prebuild (iOS)')));
  assert.doesNotMatch(ios, /ios-caches-|uses: actions\/cache@/);
  assert.match(cachePaths(pods), /Pods\/Release[\s\S]*Pods\/Specs\/Release/);
  assert.match(pods, /key: \$\{\{ steps\.pod_key\.outputs\.key \}\}/);
  assert.match(pods, /restore-keys: \$\{\{ steps\.pod_key\.outputs\.prefix \}\}/);
  assert.match(cachePaths(pods), /env\.CP_CACHE_DIR/);
  const podKey = findStep(ios, 'Identify CocoaPods release downloads');
  assert.match(podKey, /CP_CACHE_DIR=\$RUNNER_TEMP\/kinesync-release-cocoapods/);
  assert.match(podKey, /ExpoLyrics\/app\.json/);
  assert.ok(ios.indexOf(podKey) < ios.indexOf(findStep(ios, 'Set shared release version')));
  assert.match(findStep(ios, 'Build Release and locate .app'), /runBuild\("build", \[\]\)/);

  const windowsRestore = findStep(windows, 'Restore Windows native downloads');
  assert.match(windowsRestore, /restore-keys: \$\{\{ steps\.downloads_key\.outputs\.prefix \}\}/);
  assert.match(findStep(windows, 'Identify Windows native downloads'), /windows-native-downloads-v1-.*NODE_VERSION-\$dotnetVersion-/);
  const windowsPaths = cachePaths(windowsRestore);
  assert.match(windowsPaths, /NUGET_PACKAGES[\s\S]*outputs\.electron[\s\S]*outputs\.node_gyp/);
  assert.doesNotMatch(windowsPaths, /node_modules|\.pfx|dist-native/);
  assert.match(findStep(windows, 'Bound Windows native download cache'), /\$bytes -le 768MB/);
});

test('iOS Release DerivedData reuses only compiler caches with exact build inputs', () => {
  const restore = findStep(ios, 'Restore Release DerivedData compiler caches');
  assertSave(ios, 'Restore Release DerivedData compiler caches',
    'Save Release DerivedData compiler caches', 'Upload IPA artifact');
  const key = findStep(ios, 'Identify Release DerivedData compiler cache');
  assert.match(key, /steps\.compiler_key\.outputs\.compiler/);
  assert.match(key, /ExpoLyrics\/ios\/Podfile\.lock/);
  assert.match(key, /COMPILER.*GITHUB_SHA.*pod_inputs/);
  assert.doesNotMatch(restore, /restore-keys:/);
  const paths = cachePaths(restore);
  assert.match(paths, /ModuleCache\.noindex[\s\S]*SDKStatCaches\.noindex/);
  assert.doesNotMatch(paths, /Build\/|\.app/);
  assert.match(findStep(ios, 'Bound Release DerivedData compiler caches'), /262144/);
  assert.ok(ios.indexOf(restore) < ios.indexOf(findStep(ios, 'Build Release and locate .app')));
});

test('cache bookkeeping is nonfatal while build and artifact gates stay strict', () => {
  for (const [workflow, optional, required] of [
    [android, ['Select Android cache namespace', 'Identify Android Rust caches', 'Identify Gradle downloads',
      'Bound Android Rust and cargo-ndk caches', 'Bound Gradle download cache', 'Summarize Android cache evidence'],
    ['Setup Android NDK and Rust', 'Install or verify cargo-ndk', 'Build Android Rust static libraries',
      'Configure release signing and version', 'Upload APK artifact']],
    [ios, ['Identify CocoaPods release downloads', 'Identify iOS Release compiler caches',
      'Identify Release DerivedData compiler cache', 'Bound iOS Release Rust cache',
      'Bound CocoaPods download cache', 'Bound Release DerivedData compiler caches', 'Summarize iOS Release cache evidence'],
    ['Set up the iOS Release Rust toolchain', 'Prepare Rust lyrics framework for iOS Release',
      'Build Release and locate .app', 'Verify Release Rust lyrics registration and linkage', 'Upload IPA artifact']],
    [windows, ['Identify Windows native downloads', 'Bound Windows native download cache', 'Summarize Windows cache evidence'],
    ['Setup .NET 9', 'Build C++ media-session addon', 'Build .NET seek helper', 'Prepare optional Windows signing certificate',
      'Upload native artifacts for publisher']],
  ]) {
    for (const name of optional) assert.match(findStep(workflow, name), /continue-on-error: true/);
    for (const name of required) assert.doesNotMatch(findStep(workflow, name), /continue-on-error:/);
  }
});

test('unconfirmed restores clear only cache paths before the consumer runs', () => {
  for (const [workflow, restore, cleanup, consumer, restored, paths] of [
    [android, 'Restore cargo-ndk binaries', 'Clear incomplete cargo-ndk restore', 'Install or verify cargo-ndk',
      'cache-matched-key', ['/bin/cargo-ndk*']],
    [android, 'Cache Android Rust dependencies and target work', 'Clear unconfirmed Android Rust restore',
      'Build Android Rust static libraries', 'cache-hit', ['CARGO_TARGET_DIR', '/registry', '/git']],
    [android, 'Restore Gradle downloads', 'Clear incomplete Gradle restore', 'Configure release signing and version',
      'cache-matched-key', ['/caches/modules-2', '/wrapper/dists']],
    [ios, 'Cache iOS Release Rust dependencies and target work', 'Clear unconfirmed iOS Release Rust restore',
      'Prepare Rust lyrics framework for iOS Release', 'cache-hit', ['CARGO_TARGET_DIR', '/registry', '/git']],
    [ios, 'Restore CocoaPods release downloads', 'Clear incomplete CocoaPods restore', 'Expo prebuild (iOS)',
      'cache-matched-key', ['CP_CACHE_DIR', '/Pods']],
    [ios, 'Restore Release DerivedData compiler caches', 'Clear incomplete Release DerivedData restore',
      'Build Release and locate .app', 'cache-matched-key', ['/ModuleCache.noindex', '/SDKStatCaches.noindex']],
    [windows, 'Restore Windows native downloads', 'Clear incomplete Windows download restore', 'Install root DesktopBridge deps',
      'cache-matched-key', ['NUGET_PACKAGES', 'ELECTRON_DOWNLOADS', 'NODE_GYP_DOWNLOADS']],
  ]) {
    const attempt = findStep(workflow, restore);
    const retry = findStep(workflow, cleanup);
    assert.match(attempt, /continue-on-error: true/);
    assert.match(retry, /outcome != 'skipped'.*outcome != 'success'/);
    assert.ok(retry.includes(restored));
    assert.doesNotMatch(retry, /continue-on-error:/);
    assert.match(retry, /run: rm -r?f --|Remove-Item -LiteralPath .* -ErrorAction Stop/);
    for (const cachePath of paths) assert.ok(retry.includes(cachePath), cleanup + ' misses ' + cachePath);
    assert.ok(workflow.indexOf(attempt) < workflow.indexOf(retry));
    assert.ok(workflow.indexOf(retry) < workflow.indexOf(findStep(workflow, consumer)));
  }
});
