// Inspect the shipped JS or Hermes bundle and native artifacts without launching the app.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const bundleMarkers = [
  'Rust diagnostics', 'Show Rust debug overlay', 'kinesync_rust_debug_overlay',
  'onFrameTraceReset', 'tracePanelVisible', 'Frame trace export is unavailable.',
  'Simulated Latency', 'Packet Drop Rate', 'Raw GSMTC position', 'Spotify Bearer Token',
  'Run Spotify browser diagnostics', 'Spotify timing diagnostics', 'safeWindowGlobals',
  'timingProvenance', '[LaunchTransition] Native splash',
  '[Spotify timing bootstrap]', '[Spotify delivery experiment]', '[NativeClockTrace]',
  '[spicy-debug]', '[spicy-profile]', '[lyrics-translate]', '[bridge-lyrics] per-source cache hit',
  'KINESYNC_ARRIVAL_CHUNK', 'KINESYNC_NATIVE_PROFILE', 'rust-packet-prepared',
];
const renderMetricsSymbol = 'kr_render_metrics_build_marker';
const rustProfilingMarkers = [
  'KineSync Rust renderer adapter:', 'GPU timestamp brackets:', 'whole frame GPU interval',
  'Layout diagnostics failed:', 'requested_attributes',
];
const nativeMarkers = [
  'onFrameTraceReset', 'tracePanelVisible', 'ERR_RUST_TRACE', 'ERR_RUST_LAYOUT',
  'kr_frame_trace_', 'EXDevMenuShowFloatingActionButton',
  renderMetricsSymbol, ...rustProfilingMarkers,
];
const androidDexMarkers = [
  'Ldev/kineticron/rustlyrics/FrameObserver;',
  'Lexpo/modules/devmenu/', 'Lexpo/modules/devlauncher/',
  'profilerReason', 'missedObservedIntervalsEstimate', 'presentCallRate',
];
const devClientSchemeMarkers = ['exp+kinesync', 'expo-dev-launcher'];
const androidManifestMarkers = [...devClientSchemeMarkers, 'expo.modules.devlauncher.', 'expo.modules.devmenu.'];
const androidJniPrefix = 'Java_dev_kineticron_rustlyrics_FrameSample_';

function contains(bytes, marker) {
  return bytes.includes(Buffer.from(marker)) || bytes.includes(Buffer.from(marker, 'utf16le'));
}

function verify(bytes, label, absent, present = []) {
  assert.ok(bytes.length > 0, `${label} is empty`);
  const leaks = absent.filter(marker => contains(bytes, marker));
  assert.equal(leaks.length, 0, `${label} contains development code: ${leaks.join(', ')}`);
  for (const marker of present) assert.ok(contains(bytes, marker), `${label} is missing ${marker}`);
}

function verifyAndroid(apk) {
  const read = name => execFileSync('unzip', ['-p', apk, name], { maxBuffer: 128 * 1024 * 1024 });
  const entries = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8' }).trim().split('\n');
  verify(read('assets/index.android.bundle'), 'Android app bundle', bundleMarkers, ['KineSyncRustLyrics']);
  verify(read('AndroidManifest.xml'), 'Android manifest', androidManifestMarkers);
  const dex = entries.filter(name => /^classes(?:\d+)?\.dex$/.test(name));
  assert.ok(dex.length, 'APK is missing DEX files');
  for (const file of dex) verify(read(file), file, [...nativeMarkers, ...androidDexMarkers]);
  const libraries = entries.filter(name => /^lib\/[^/]+\/libkinesync_rust_lyrics\.so$/.test(name));
  assert.ok(libraries.length, 'APK is missing the Rust renderer JNI library');
  for (const file of libraries) {
    verify(read(file), file, [...nativeMarkers, ...['fillMetrics', 'copyLayout', 'lastError'].map(name => androidJniPrefix + name)],
      [androidJniPrefix + 'fillFrameState']);
  }
}

function verifyIos(app, executable) {
  verify(fs.readFileSync(path.join(app, 'main.jsbundle')), 'iOS app bundle', bundleMarkers, ['KineSyncRustLyrics']);
  verify(fs.readFileSync(executable), 'iOS app executable', nativeMarkers);
  const schemes = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', path.join(app, 'Info.plist')]);
  verify(schemes, 'iOS Info.plist', devClientSchemeMarkers);
}

function verifyRustArchive(file, kind) {
  assert.ok(kind === 'release' || kind === 'development', 'Invalid Rust archive build kind');
  const archive = fs.readFileSync(file);
  assert.equal(archive.subarray(0, 8).toString('ascii'), '!<arch>\n', 'Expected a Rust static archive');
  // An archive retains its C export names before the platform linker strips symbols.
  assert.ok(archive.includes(Buffer.from('kr_abi_version\0')), 'Rust archive is missing its ABI export');
  const metrics = archive.includes(Buffer.from(renderMetricsSymbol + '\0'));
  assert.equal(metrics, kind === 'development',
    `Rust archive metrics feature mismatch: ${file}. Rebuild with KINESYNC_BUILD_KIND=${kind}.`);
  if (kind === 'release') {
    verify(archive, file, ['kr_frame_trace_build_marker', ...rustProfilingMarkers]);
  }
}

const [platform, artifact, executable] = process.argv.slice(2);
if (platform === 'android' && artifact && !executable) verifyAndroid(artifact);
else if (platform === 'ios' && artifact && executable) verifyIos(artifact, executable);
else if (platform === 'rust-archive' && artifact && executable) verifyRustArchive(artifact, executable);
else throw new Error('Usage: check-release-diagnostics.cjs android APK | ios APP EXECUTABLE | rust-archive ARCHIVE KIND');
console.log(`Diagnostics markers match the expected build configuration for ${platform}.`);
