const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { test } = require('node:test');
const sim = require('../ios-sim-ci/ci.cjs');
const device = require('../ios-dev-ci/ci.cjs');
const simConfig = require('../ios-sim-ci/config.json');
const { withEmbeddedDevClient, DEV_CLIENT_OPTIONS } = require('../ios-sim-ci/prepare-app-config.cjs');
const { EXPECTED, MARKER, patch } = require('../ios-sim-ci/patch-dev-launcher.cjs');
const { matchesAbi } = require('../ios-sim-ci/rust-sim.cjs');
const { matchOnboarding } = require('../ios-sim-ci/simulator-smoke.cjs');
const repo = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/ios-simulator-build.yml'), 'utf8');
const identity = { xcode: 'Xcode 27.0\nBuild version 27A1', sdk: '27.0', sdkBuild: '27A1', runnerArch: 'ARM64', pod: '1.16.2', ccache: '4.13' };

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-sim-ci-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, file, data = 'original') {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), data);
}
function fixture(root) {
  for (const file of ['ExpoLyrics/package.json', 'ExpoLyrics/package-lock.json', 'ExpoLyrics/app.json',
    'ExpoLyrics/app.config.js', 'ExpoLyrics/plugins/native.js', 'ExpoLyrics/modules/example/ios/Shim.swift',
    'ExpoLyrics/ios/Podfile', 'ExpoLyrics/ios/Podfile.properties.json', 'ExpoLyrics/ios/Podfile.lock',
    'native/lyrics-renderer/Cargo.toml', 'native/lyrics-renderer/Cargo.lock', 'native/lyrics-renderer/src/lib.rs',
    'scripts/ios-sim-ci/config.json', 'scripts/ios-sim-ci/ci.cjs', 'scripts/ios-dev-ci/ci.cjs',
    '.github/workflows/ios-simulator-build.yml', '.github/workflows/ios-development-build.yml']) put(root, file);
}

test('simulator config and cache namespace are separate from the device workflow', t => {
  assert.equal(simConfig.configuration, 'Debug');
  assert.equal(simConfig.sdk, 'iphonesimulator');
  assert.equal(simConfig.rust.target, 'aarch64-apple-ios-sim');
  assert.equal(simConfig.rust.abi, 11);
  const root = temp(t); fixture(root);
  const simPaths = sim.resolvePaths(path.join(root, 'checkout'), path.join(root, 'home'), path.join(root, 'temp'));
  const devicePaths = device.resolvePaths(path.join(root, 'checkout'), path.join(root, 'home'), path.join(root, 'temp'));
  assert.match(simPaths.root, /kinesync-ios-sim-cache-v1$/);
  assert.match(devicePaths.root, /kinesync-ios-dev-cache-v4$/);
  const simKeys = sim.cacheKeys(root, identity, 'pair', 'refs/heads/development');
  const deviceKeys = device.cacheKeys(root, identity, 'pair', 'refs/heads/development');
  for (const key of ['npm', 'lock', 'pods', 'derived', 'ccache', 'prebuilt', 'rustShared']) {
    assert.match(simKeys[key], /^ios-sim-v1-/, key);
    assert.notEqual(simKeys[key], deviceKeys[key], key);
  }
  assert.notEqual(sim.rustIdentity(root, identity), device.rustIdentity(root, identity));
});

test('simulator build arguments override every target and never select the device SDK', () => {
  const args = sim.buildArgs('/space dir/ios', 'KineSync.xcworkspace', 'KineSync', '/space dir/derived', '/space dir/wrapper');
  for (const required of ['Debug', 'iphonesimulator', 'generic/platform=iOS Simulator', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'SUPPORTED_PLATFORMS=iphonesimulator', 'SDKROOT=iphonesimulator', 'CODE_SIGNING_ALLOWED=NO']) assert.ok(args.includes(required), required);
  assert.ok(args.some(arg => arg.startsWith('CC=') && arg.endsWith(`${path.sep}clang`)));
  assert.ok(args.some(arg => arg.startsWith('CXX=') && arg.endsWith(`${path.sep}clang++`)));
  assert.ok(!args.some(arg => /^iphoneos$|x86_64|Release/.test(arg)));
  const setting = target => ({ buildSettings: { TARGET_NAME: target, CONFIGURATION: 'Debug', SDKROOT: 'iphonesimulator', PLATFORM_NAME: 'iphonesimulator', SUPPORTED_PLATFORMS: '"iphoneos iphonesimulator"', ARCHS: 'arm64' } });
  assert.doesNotThrow(() => sim.assertSimulatorSettings([setting('KineSync'), setting('KineSyncLyricsWidget')], 'KineSync'));
  const widgetDevice = setting('KineSyncLyricsWidget'); widgetDevice.buildSettings.SDKROOT = 'iphoneos';
  assert.throws(() => sim.assertSimulatorSettings([setting('KineSync'), widgetDevice], 'KineSync'), /SDKROOT/);
});

test('CI-only app config enables embedded dev client without changing defaults', () => {
  const config = { plugins: ['expo-router', ['expo-dev-client', { embeddedBundle: false }], 'expo-video'] };
  const next = withEmbeddedDevClient(config);
  assert.deepEqual(next.plugins.at(-2), 'expo-video');
  assert.deepEqual(next.plugins.at(-1), ['expo-dev-client', DEV_CLIENT_OPTIONS]);
  assert.equal(next.plugins.filter(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-dev-client').length, 1);
  assert.equal(config.plugins.length, 3);
});

test('dev launcher patch is exact, idempotent and fails closed on context drift', () => {
  const source = `import SwiftUI\n\n${EXPECTED}\n\nprivate func other() {}\n`;
  const patched = patch(source);
  assert.ok(patched.includes(MARKER));
  assert.ok(patched.includes('if viewModel.hasEmbeddedBundle {'));
  assert.ok(patched.includes('self?.viewModel.loadLocalBundle()'));
  assert.equal(patch(patched), patched);
  assert.throws(() => patch('viewDidLoad() { somethingElse() }'), /context mismatch/);
});

test('onboarding matcher requires app-specific setup UI and rejects launcher text', () => {
  const ok = 'KineSync\nA modern, beautiful mobile app for rendering syllable-synced lyrics\nStart Setup\nSkip';
  assert.equal(matchOnboarding(ok).matched, true);
  assert.equal(matchOnboarding('KineSync\nStart Setup').matched, false);
  assert.equal(matchOnboarding('KineSync\nA modern, beautiful mobile app\nStart Setup\nDevelopment servers\nMetro').matched, false);
  assert.equal(matchOnboarding('Development servers\nStart Setup\nSkip').matched, false);
});

test('Rust ABI instruction matcher accepts ABI 11 and rejects other constants', () => {
  assert.equal(matchesAbi('_kr_abi_version:\n  mov w0, #0xb\n  ret'), true);
  assert.equal(matchesAbi('0000 <_kr_abi_version>:\n  0: mov w0, #0xb\n  4: ret'), true);
  assert.equal(matchesAbi('0000 <_kr_abi_version>:\n  0: mov w0, #0xb\n  4: ret\n0008 <_other>:'), true);
  assert.equal(matchesAbi('_kr_abi_version:\n  mov w0, #11\n  ret'), true);
  assert.equal(matchesAbi('_kr_abi_version:\n  mov w0, #0xa\n  ret'), false);
  assert.equal(matchesAbi('_other:\n  mov w0, #0xb\n  ret'), false);
});

test('source gates justify Debug and the ABI stays 11 everywhere', () => {
  const rust = fs.readFileSync(path.join(repo, 'native/lyrics-renderer/src/ffi.rs'), 'utf8');
  const swift = fs.readFileSync(path.join(repo, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8');
  const view = fs.readFileSync(path.join(repo, 'ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8');
  const moduleConfig = JSON.parse(fs.readFileSync(path.join(repo, 'ExpoLyrics/modules/kinesync-rust-lyrics/expo-module.config.json'), 'utf8'));
  assert.match(rust, /assert_eq!\(kr_abi_version\(\), 11\)/);
  assert.match(swift, /kr_abi_version\(\) == 11/);
  assert.equal(simConfig.rust.abi, 11);
  assert.equal(moduleConfig.apple.debugOnly, true);
  assert.match(view, /if \(!__DEV__\) return \{ api: null, view: null/);
  assert.equal(simConfig.configuration, 'Debug');
});

function fakeSimulatorApp(root) {
  const app = path.join(root, 'KineSync.app');
  const plist = (bundleId, executable) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>DTPlatformName</key><string>iphonesimulator</string>
<key>DTSDKName</key><string>iphonesimulator27.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>CADisableMinimumFrameDurationOnPhone</key><true/>
</dict></plist>`;
  put(app, 'Info.plist', plist('dev.kineticron.KineSync', 'KineSync'));
  put(app, 'KineSync', Buffer.from('cffaedfe00000000', 'hex'));
  put(app, 'PlugIns/KineSyncLyricsWidget.appex/Info.plist', plist('dev.kineticron.KineSync.KineSyncLyricsWidget', 'KineSyncLyricsWidget'));
  put(app, 'PlugIns/KineSyncLyricsWidget.appex/KineSyncLyricsWidget', Buffer.from('cffaedfe00000000', 'hex'));
  put(app, 'main.jsbundle', 'KineSync kinesync_use_rust_renderer Use experimental Rust lyrics renderer RustLyricsView ' + 'x'.repeat(100001));
  fs.chmodSync(path.join(app, 'KineSync'), 0o755);
  fs.chmodSync(path.join(app, 'PlugIns/KineSyncLyricsWidget.appex/KineSyncLyricsWidget'), 0o755);
  return app;
}
function fakeXcrun(root) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const script = `#!/usr/bin/env node\nconst args=process.argv.slice(2);\nif(args[0]==='lipo') process.stdout.write(process.env.TEST_ARCHS || 'arm64');\nelse if(args[0]==='vtool') process.stdout.write('platform ' + (process.env.TEST_PLATFORM || 'IOSSIMULATOR') + '\\n');\nelse process.exit(9);\n`;
  fs.writeFileSync(path.join(bin, 'xcrun'), script, { mode: 0o755 });
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'xcrun.cmd'), `@echo off
node "%~dp0xcrun" %*
`);
  return bin;
}

test('independent simulator verifier rejects device, thin-foreign or missing bundle evidence', t => {
  const root = temp(t), app = fakeSimulatorApp(root), bin = fakeXcrun(root);
  const python = process.platform === 'win32' ? process.env.PYTHON || 'python' : 'python3';
  const run = (extra = {}) => spawnSync(python, [path.join(repo, 'scripts/ios-sim-ci/verify_simulator.py'), '--app', app, '--bundle-id', 'dev.kineticron.KineSync'], { encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...extra } });
  const ok = run(); assert.equal(ok.status, 0, ok.stderr);
  const result = JSON.parse(ok.stdout);
  assert.equal(result.architectures.length, 2);
  assert.equal(result.js_bundles[0].bytes > 100000, true);
  const device = run({ TEST_PLATFORM: 'IOS' }); assert.equal(device.status, 1); assert.match(device.stderr, /IOSSIMULATOR/);
  const foreign = run({ TEST_ARCHS: 'x86_64' }); assert.equal(foreign.status, 1); assert.match(foreign.stderr, /Non-arm64/);
  fs.unlinkSync(path.join(app, 'main.jsbundle'));
  const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /No embedded .jsbundle/);
});

test('simulator app ZIP preserves executable modes and refuses overwrite', t => {
  const root = temp(t), app = fakeSimulatorApp(root), zip = path.join(root, 'KineSync.app.zip'), manifest = path.join(root, 'manifest.json');
  execFileSync('python3', [path.join(repo, 'scripts/ios-sim-ci/package_app.py'), app, zip, manifest]);
  const report = JSON.parse(fs.readFileSync(manifest));
  if (process.platform !== 'win32') assert.equal(report.entries.find(entry => entry.path.endsWith('/KineSync')).mode, 0o755);
  assert.equal(report.entries.find(entry => entry.path.endsWith('/KineSync')).type, 'file');
  assert.equal(report.app_root, 'KineSync.app');
  const again = spawnSync('python3', [path.join(repo, 'scripts/ios-sim-ci/package_app.py'), app, zip, manifest]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr.toString(), /Refusing to overwrite/);
});

test('workflow has pinned actions, isolated caches and a mandatory offline UI smoke', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches: \[development\]/);
  assert.match(workflow, /runs-on: xcode-27/);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/cache\/restore@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /Swatinem\/rust-cache@[a-f0-9]{40}/);
  assert.match(workflow, /aarch64-apple-ios-sim/);
  assert.match(workflow, /node scripts\/ios-sim-ci\/prepare-app-config\.cjs/);
  assert.match(workflow, /node scripts\/ios-sim-ci\/patch-dev-launcher\.cjs/);
  assert.match(workflow, /simulator-smoke\.cjs/);
  assert.match(workflow, /Compression|compression-level: 0/);
  assert.match(workflow, /name: KineSync-simulator-arm64-app/);
  assert.match(workflow, /if: always\(\) && steps\.plan\.outcome == 'success'/);
  assert.ok(!workflow.includes('ios-development-build.yml'));
  assert.ok(!workflow.match(/SDKROOT=iphoneos|SUPPORTED_PLATFORMS=iphoneos|SKIP_BUNDLING: '0'/));
  assert.match(fs.readFileSync(path.join(repo, 'scripts/ios-sim-ci/ci.cjs'), 'utf8'), /FORCE_BUNDLING: '1'[\s\S]*SKIP_BUNDLING: ''/);
  assert.ok(workflow.indexOf('setup-node') < workflow.indexOf('npm --prefix ExpoLyrics ci'));
  assert.ok(workflow.indexOf('name: Install JS dependencies') < workflow.indexOf('name: Patch pinned dev launcher for embedded auto-load'));
  assert.ok(workflow.indexOf('rust-prepare') < workflow.indexOf('expo prebuild'));
  assert.ok(workflow.indexOf('name: Build and verify Debug arm64 iPhoneSimulator app') < workflow.indexOf('name: Smoke test rendered onboarding without a local Metro listener'));
});

test('workflow shell blocks pass bash syntax checks', () => {
  const blocks = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)].map(match => match[1].replace(/^          /gm, ''));
  const inline = [...workflow.matchAll(/^        run: (?!\|)(.+)$/gm)].map(match => match[1]);
  assert.ok(blocks.length > 0 && inline.length > 0);
  for (const command of [...blocks, ...inline]) {
    const result = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
