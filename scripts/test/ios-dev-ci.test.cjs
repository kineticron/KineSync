const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { resolvePaths, cacheKeys, rustIdentity, buildArgs, config } = require('../ios-dev-ci/ci.cjs');
const repo = path.resolve(__dirname, '../..');
const cli = path.join(repo, 'scripts/ios-dev-ci/ci.cjs');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/ios-development-build.yml'), 'utf8');
const release = fs.readFileSync(path.join(repo, '.github/workflows/ios-unsigned-ipa.yml'), 'utf8');
const identity = { xcode: 'Xcode 27.0\nBuild version 27A1', sdk: '27.0', sdkBuild: '27A1', runnerArch: 'ARM64', pod: '1.16.2', ccache: '4.13' };
test('iOS Release prepares the validated device framework before CocoaPods', () => {
  const build = release.indexOf('bash scripts/ios-dev-ci/build-rust-device.sh');
  const validate = release.indexOf('node scripts/ios-dev-ci/rust-device.cjs validate');
  const prebuild = release.indexOf('expo prebuild --clean --platform ios');
  assert.ok(build >= 0 && validate > build && prebuild > validate);
  assert.match(release, /target=\$\(config target\)/);
  assert.match(release, /rustup toolchain install "\$toolchain" --profile minimal --target "\$target"/);
});
test('iOS Release registers Rust lyrics and verifies the packaged app linkage', () => {
  const { apple } = JSON.parse(fs.readFileSync(path.join(repo,
    'ExpoLyrics/modules/kinesync-rust-lyrics/expo-module.config.json'), 'utf8'));
  assert.ok(apple.modules.includes('KineSyncRustLyricsModule'));
  assert.ok(!apple.debugOnly, 'Rust lyrics must be registered in Release');

  const build = release.indexOf('- name: Build Release and locate .app');
  const verify = release.indexOf('- name: Verify Release Rust lyrics registration and linkage');
  const packaging = release.indexOf('- name: Package IPA');
  assert.ok(build >= 0 && verify > build && packaging > verify);
  const proof = release.slice(verify, packaging);
  assert.match(proof, /\.ci_built_app/);
  assert.match(proof, /ExpoModulesProvider\.swift/);
  assert.match(proof, /branches\.every[\s\S]*KineSyncRustLyricsModule/);
  assert.match(proof, /\['nm', [^\n]*image\]/);
  assert.match(proof, /Swift or Objective-C identity/);
  assert.match(proof, /for \(const symbol of releaseSymbols\)/);
  const { symbols, releaseSymbols } = require('../ios-dev-ci/rust-device.cjs');
  const debugOnlySymbols = ['kr_copy_layout_json', 'kr_copy_error'];
  assert.ok(debugOnlySymbols.every(symbol => symbols.includes(symbol)));
  assert.deepEqual(releaseSymbols, symbols.filter(symbol => !debugOnlySymbols.includes(symbol)));
  assert.match(proof, /\['otool', [^\n]*'-l', loader\]/);
  assert.match(proof, /verifyLoads\(image\)/);
  assert.match(proof, /throw new Error\(`Missing dylib dependency/);
  assert.match(release, /- name: Upload IPA artifact[\s\S]*?ExpoLyrics\/ios-release-evidence\//);
});
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-dev-ci-test-'));
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
    'native/lyrics-renderer/src/blur.wgsl', 'native/lyrics-renderer/vendor/vello_shaders/shader/fine.wgsl', 'native/lyrics-renderer/include/KineSyncLyrics.h',
    'scripts/ios-dev-ci/rust-device.cjs', 'scripts/ios-dev-ci/build-rust-device.sh', 'scripts/ios-dev-ci/ci.cjs',
    '.github/workflows/ios-development-build.yml', 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml']) put(root, file);
}
test('absolute normalized cache paths and build flags survive runner paths with spaces', t => {
  const root = temp(t);
  const paths = resolvePaths(path.join(root, 'checkout path'), path.join(root, 'home path'), path.join(root, 'temp path'));
  for (const value of Object.values(paths)) {
    assert.ok(path.isAbsolute(value));
    assert.equal(value, path.normalize(value));
    assert.ok(!value.split(path.sep).includes('..'));
  }
  assert.equal(paths.cocoapods, path.join(root, 'home path/Library/Caches/CocoaPods'));
  const args = buildArgs('/space dir/ios', 'KineSync.xcworkspace', 'KineSync', paths.derived, paths.wrapper);
  for (const required of ['Debug', 'iphoneos', 'generic/platform=iOS', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'SUPPORTED_PLATFORMS=iphoneos', 'CODE_SIGNING_ALLOWED=NO']) assert.ok(args.includes(required));
  assert.ok(args.some(arg => arg.startsWith('CC=') && arg.endsWith('/clang')));
  assert.ok(args.some(arg => arg.startsWith('CXX=') && arg.endsWith('/clang++')));
  assert.ok(!args.some(arg => /simulator|x86_64|Release/.test(arg)));
  assert.throws(() => resolvePaths('../relative', '/home', '/tmp'), /absolute/);
});
test('Rust prebuilt is source-exact, and independent of JS or Swift shims', t => {
  const root = temp(t); fixture(root);
  const initial = rustIdentity(root, identity);
  put(root, 'ExpoLyrics/app/screen.tsx', 'JS changed');
  put(root, 'ExpoLyrics/modules/example/ios/Shim.swift', 'Swift changed');
  put(root, 'native/lyrics-renderer/target/out', 'build output');
  put(root, 'native/lyrics-renderer/evidence/report.json', 'evidence');
  assert.equal(rustIdentity(root, identity), initial);
  for (const file of ['native/lyrics-renderer/src/lib.rs', 'native/lyrics-renderer/src/blur.wgsl', 'native/lyrics-renderer/vendor/vello_shaders/shader/fine.wgsl', 'native/lyrics-renderer/include/KineSyncLyrics.h', 'native/lyrics-renderer/Cargo.lock', 'native/lyrics-renderer/Cargo.toml', 'scripts/ios-dev-ci/rust-device.cjs', 'scripts/ios-dev-ci/build-rust-device.sh',
    'scripts/ios-dev-ci/ci.cjs', '.github/workflows/ios-development-build.yml', 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml']) {
    put(root, file, 'changed'); assert.notEqual(rustIdentity(root, identity), initial, file); put(root, file);
  }
  for (const [field, value] of [['toolchain', '1.98.0'], ['target', 'other-target'], ['profile', 'dev'], ['features', ['new-feature']]]) {
    const changed = structuredClone(config); changed.rust[field] = value;
    assert.notEqual(rustIdentity(root, identity, changed), initial, field);
  }
  assert.notEqual(rustIdentity(root, { ...identity, xcode: 'Xcode 27.1' }), initial);
});
test('Podfile.lock and native/SDK identities invalidate native caches without JS-only churn', t => {
  const root = temp(t); fixture(root);
  const keys = () => cacheKeys(root, identity, 'pair-1', 'refs/heads/rust-renderer-spike');
  const initial = keys();
  put(root, 'ExpoLyrics/app/new-screen.tsx', 'JS');
  put(root, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/Frameworks/KineSyncLyrics.xcframework/binary', 'generated output');
  assert.deepEqual(keys(), initial);
  put(root, 'ExpoLyrics/ios/Podfile.lock', 'updated lock');
  const locked = keys();
  assert.notEqual(locked.pods, initial.pods);
  assert.notEqual(locked.derived, initial.derived);
  assert.equal(locked.lock, initial.lock);
  put(root, 'ExpoLyrics/modules/example/ios/Shim.swift', 'updated Swift');
  assert.notEqual(keys().derived, locked.derived);
  assert.notEqual(keys().lock, locked.lock);
  assert.equal(keys().prebuilt, locked.prebuilt);
  assert.notEqual(cacheKeys(root, { ...identity, sdkBuild: '27A2' }, 'pair-1', 'refs/heads/rust-renderer-spike').pods, keys().pods);
  assert.notEqual(cacheKeys(root, identity, 'pair-2', 'refs/heads/rust-renderer-spike').pods, keys().pods);
  assert.notEqual(cacheKeys(root, identity, 'pair-1', 'refs/heads/other').pods, keys().pods);
  assert.throws(() => cacheKeys(root, identity, 'bad\nvalue', 'branch'), /epoch/);
  fs.unlinkSync(path.join(root, 'ExpoLyrics/ios/Podfile.lock'));
  assert.equal(keys().pods, '');
  assert.equal(keys().derived, '');
});
test('workflow restore/save paths and identities match exactly, all are resolved once', () => {
  const steps = workflow.split(/^      - name: /m).slice(1);
  const find = name => steps.find(step => step.startsWith(name + '\n'));
  for (const [name, restore] of [['npm', 'Restore npm download cache'], ['lock', 'Restore generated Podfile.lock'], ['pods', 'Restore Pods and CocoaPods downloads'], ['derived', 'Restore Debug device DerivedData'], ['ccache', 'Restore content-addressed C and C++ compiler cache'], ['prebuilt', 'Restore source-exact device-only Rust XCFramework']]) {
    const a = find(restore), b = find(`Save ${name} cache`);
    for (const property of ['path', 'key']) {
      const extract = step => step.match(new RegExp(`          ${property}: ([\\s\\S]*?)(?=\\n          [a-z-]+:|\\n\\s*#|$)`))[1].trim();
      if (name === 'pods' && property === 'key') {
        assert.equal(extract(a), '${{ steps.locked.outputs.key-pods }}');
        assert.equal(extract(b), '${{ steps.final.outputs.key-pods }}');
      } else assert.equal(extract(a), extract(b), `${name} ${property}`);
    }
    assert.match(a, /env.CACHE_MODE != 'cold'/);
    assert.match(a, /steps.plan.outputs.path-/);
    assert.ok(!a.includes('env.HOME') && !a.includes('/../'));
  }
  assert.ok(workflow.indexOf('expo prebuild --clean --platform ios --no-install') < workflow.indexOf('Restore generated Podfile.lock'));
  assert.ok(workflow.indexOf('Restore Pods and CocoaPods downloads') < workflow.indexOf('time pod-install'));
  assert.match(workflow, /branches: \[rust-renderer-spike\]/);
  assert.match(workflow, /group: \$\{\{ github.workflow \}\}-\$\{\{ github.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /Swatinem\/rust-cache@[a-f0-9]{40}/);
  assert.match(workflow, /compression-level: 0/);
  const setup = find('Setup pinned device Rust toolchain and archive reader');
  assert.match(setup, /if: steps.plan.outputs.rust-enabled == 'true'\n/);
  assert.ok(!setup.includes('cache-hit'));
  assert.match(setup, /--component llvm-tools-preview/);
  assert.ok(workflow.indexOf(setup) < workflow.indexOf('ci.cjs rust-prepare'));
  assert.equal(config.rust.enabled, true);
  assert.ok(!/stamp.*version|publish-production/.test(workflow));
  assert.ok(workflow.indexOf('ci.cjs rust-prepare') < workflow.indexOf('expo prebuild'));
  assert.ok(!workflow.includes('assert-rust-disabled'));
  assert.ok(workflow.includes('Compile JS path proof without a listening Metro server'));
});
test('stage failure and warm-cache failure still produce machine-readable evidence', t => {
  const root = temp(t), evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  const env = { ...process.env, CI_EVIDENCE_DIR: evidence };
  let result = spawnSync(process.execPath, [cli, 'time', 'deliberate-failure', process.execPath, '-e', 'process.exit(7)'], { env });
  assert.equal(result.status, 1);
  const stage = JSON.parse(fs.readFileSync(path.join(evidence, 'stages.jsonl'), 'utf8'));
  assert.equal(stage.exit_code, 7);
  assert.ok(stage.elapsed_ms >= 0);
  const keys = cacheKeys(repo, identity, 'test', 'branch');
  fs.writeFileSync(path.join(evidence, 'state.json'), JSON.stringify({ mode: 'warm', keys, identity, paths: { evidence }, started_at: new Date().toISOString() }));
  result = spawnSync(process.execPath, [cli, 'summary'], { env: { ...env, CACHE_RESULTS: '{}', CI_JOB_STATUS: 'failure' } });
  assert.equal(result.status, 1);
  const report = JSON.parse(fs.readFileSync(path.join(evidence, 'evidence.json')));
  assert.equal(report.warm_exact_hits_pass, false);
  assert.equal(report.rust.enabled, true);
  assert.equal(report.stages[0].exit_code, 7);
  const hits = Object.fromEntries(['npm', 'lock', 'pods', 'derived', 'ccache'].map(name => [name, { hit: 'true', verified: 'true' }]));
  hits.rust = { prebuilt_hit: 'true', verified: 'true' };
  result = spawnSync(process.execPath, [cli, 'summary'], { env: { ...env, CACHE_RESULTS: JSON.stringify(hits), CI_JOB_STATUS: 'success' } });
  assert.equal(result.status, 0, result.stderr.toString());
});
test('IPA inner ZIP preserves framework executable modes, symlinks, and bytes', t => {
  const root = temp(t), app = path.join(root, 'App with spaces.app');
  put(app, 'Frameworks/Foo.framework/Foo', Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('framework bytes')]));
  put(app, 'AppExecutable', 'host executable');
  put(app, 'Info.plist', '<plist version="1.0"><dict><key>CADisableMinimumFrameDurationOnPhone</key><true/><key>CFBundleExecutable</key><string>AppExecutable</string></dict></plist>');
  fs.chmodSync(path.join(app, 'Frameworks/Foo.framework/Foo'), 0o755);
  fs.chmodSync(path.join(app, 'AppExecutable'), 0o755);
  fs.symlinkSync('Foo', path.join(app, 'Frameworks/Foo.framework/Current'));
  const ipa = path.join(root, 'test.ipa'), manifest = path.join(root, 'manifest.json');
  execFileSync('python3', [path.join(repo, 'scripts/ios-dev-ci/package.py'), app, ipa, manifest]);
  const report = JSON.parse(fs.readFileSync(manifest));
  assert.equal(report.livecontainer_launch_tested, false);
  assert.equal(report.entries.find(e => e.path.endsWith('/Foo')).mode, 0o755);
  const checked = execFileSync('python3', ['-c', `import sys,zipfile,stat
with zipfile.ZipFile(sys.argv[1]) as z:
 p='Payload/App with spaces.app/'
 assert z.read(p+'Frameworks/Foo.framework/Foo').endswith(b'framework bytes')
 assert stat.S_IMODE(z.getinfo(p+'Frameworks/Foo.framework/Foo').external_attr >> 16)==0o755
 assert stat.S_ISLNK(z.getinfo(p+'Frameworks/Foo.framework/Current').external_attr >> 16)
 assert z.read(p+'Frameworks/Foo.framework/Current') == b'Foo'
 print('ok')`, ipa], { encoding: 'utf8' });
  assert.equal(checked.trim(), 'ok');
});

test('restored Podfile.lock cannot silently change between restore and save', t => {
  const root = temp(t); fixture(root);
  put(root, 'ExpoLyrics/ios/App.xcodeproj/project.pbxproj');
  put(root, 'ExpoLyrics/ios/App/Info.plist', '<plist version="1.0"><dict><key>CADisableMinimumFrameDurationOnPhone</key><true/></dict></plist>');
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(evidence, 'state.json'), JSON.stringify({ identity, epoch: 'pair', ref: 'branch', paths: { evidence, lock: path.join(root, 'ExpoLyrics/ios/Podfile.lock') } }));
  const env = { ...process.env, GITHUB_WORKSPACE: root, CI_EVIDENCE_DIR: evidence, GITHUB_OUTPUT: path.join(root, 'outputs') };
  let result = spawnSync(process.execPath, [cli, 'keys'], { env });
  assert.equal(result.status, 0, result.stderr.toString());
  put(root, 'ExpoLyrics/ios/App/Info.plist', '<plist version="1.0"><dict/></plist>');
  result = spawnSync(process.execPath, [cli, 'keys'], { env });
  assert.equal(result.status, 1); assert.match(result.stderr.toString(), /CADisableMinimumFrameDurationOnPhone/);
  put(root, 'ExpoLyrics/ios/App/Info.plist', '<plist version="1.0"><dict><key>CADisableMinimumFrameDurationOnPhone</key><true/></dict></plist>');
  put(root, 'ExpoLyrics/ios/Podfile.lock', 'unexpected mutation');
  result = spawnSync(process.execPath, [cli, 'keys'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /Podfile.lock changed/);
});
test('runner initialization emits actual paths, pinned Cargo target and no Rust build', t => {
  const root = temp(t), workspace = path.join(root, 'checkout path'), home = path.join(root, 'home'), runnerTemp = path.join(root, 'temp');
  fs.mkdirSync(workspace); fs.mkdirSync(home); fs.mkdirSync(runnerTemp);
  fixture(workspace);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const script = `#!/usr/bin/env node
const command = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const values = { xcodebuild: 'Xcode 27.0\\nBuild version 27A1', 'xcode-select': '/Applications/Xcode.app/Contents/Developer', pod: '1.16.2', ruby: 'ruby 3.3', ccache: 'ccache version 4.13' };
if (command === 'xcrun') console.log(args.includes('--show-sdk-version') ? '27.0' : args.includes('--show-sdk-build-version') ? '27A1' : '/Applications/Xcode.app/Contents/Developer/Toolchains/clang');
else console.log(values[command]);
`;
  for (const name of ['xcodebuild', 'xcode-select', 'xcrun', 'pod', 'ruby', 'ccache']) {
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace, HOME: home, RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: path.join(root, 'outputs'), GITHUB_ENV: path.join(root, 'env'), CACHE_MODE: 'cold', CACHE_EPOCH: 'test-pair', GITHUB_REF: 'refs/heads/rust-renderer-spike' };
  const result = spawnSync(process.execPath, [cli, 'init'], { env });
  assert.equal(result.status, 0, result.stderr.toString());
  const outputs = Object.fromEntries(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  assert.equal(outputs['rust-enabled'], 'true');
  assert.equal(outputs['path-rustTarget'], path.join(workspace, 'native/lyrics-renderer/target'));
  const vars = fs.readFileSync(env.GITHUB_ENV, 'utf8');
  assert.ok(vars.includes(`CARGO_TARGET_DIR=${outputs['path-rustTarget']}\n`));
  const state = JSON.parse(fs.readFileSync(path.join(outputs['path-evidence'], 'state.json')));
  assert.equal(state.mode, 'cold');
  assert.equal(state.identity.sdkBuild, '27A1');
  assert.equal(fs.statSync(path.join(runnerTemp, 'kinesync-ios-dev-compilers/clang++')).mode & 0o777, 0o755);
  assert.ok(!fs.existsSync(path.join(outputs['path-rustTarget'], 'aarch64-apple-ios')));
});
test('workflow shell commands pass bash syntax checks', () => {
  const blocks = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)].map(match => match[1].replace(/^          /gm, ''));
  const inline = [...workflow.matchAll(/^        run: (?!\|)(.+)$/gm)].map(match => match[1]);
  assert.ok(blocks.length > 0 && inline.length > 0);
  for (const command of [...blocks, ...inline]) {
    const result = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
test('independent executable validator rejects equal 0644 source and archive, repair fixes only code', t => {
  const root = temp(t), app = path.join(root, 'Bad.app');
  put(app, 'Bad', Buffer.from('cffaedfe00000000', 'hex'));
  put(app, 'Frameworks/Foo.framework/Foo', Buffer.from('cffaedfe00000000', 'hex'));
  put(app, 'Info.plist', '<plist version="1.0"><dict><key>CADisableMinimumFrameDurationOnPhone</key><true/><key>CFBundleExecutable</key><string>Bad</string></dict></plist>');
  fs.chmodSync(path.join(app, 'Bad'), 0o644);
  fs.chmodSync(path.join(app, 'Frameworks/Foo.framework/Foo'), 0o644);
  put(app, 'resource.txt', 'not code');
  const validator = path.join(repo, 'scripts/ios-dev-ci/validate_ipa.py');
  const source = spawnSync('python3', [validator, '--app', app]);
  assert.equal(source.status, 1);
  assert.match(source.stderr.toString(), /Non-executable/);
  const ipa = path.join(root, 'equal-0644.ipa');
  execFileSync('python3', ['-c', `import zipfile,sys,stat
from pathlib import Path
app=Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w') as z:
 for f in app.rglob('*'):
  if f.is_file():
   i=zipfile.ZipInfo('Payload/Bad.app/'+str(f.relative_to(app)))
   i.create_system=3
   i.external_attr=(stat.S_IFREG|0o644)<<16
   z.writestr(i,f.read_bytes())`, app, ipa]);
  const archived = spawnSync('python3', [validator, '--ipa', ipa]);
  assert.equal(archived.status, 1);
  assert.match(archived.stderr.toString(), /Non-executable/);
  const pack = spawnSync('python3', [path.join(repo, 'scripts/ios-dev-ci/package.py'), app, path.join(root, 'must-not-pass.ipa'), path.join(root, 'bad-manifest.json')]);
  assert.equal(pack.status, 1, 'packaging itself must also reject equal-bad modes');
  execFileSync('python3', [path.join(repo, 'scripts/ios-dev-ci/repair_modes.py'), app, path.join(root, 'repairs.json')]);
  const repaired = JSON.parse(fs.readFileSync(path.join(root, 'repairs.json')));
  assert.equal(repaired.repaired.length, 2);
  assert.equal(fs.statSync(path.join(app, 'resource.txt')).mode & 0o777, 0o644);
  execFileSync('python3', [validator, '--app', app]);
  execFileSync('python3', [path.join(repo, 'scripts/ios-dev-ci/package.py'), app, path.join(root, 'good.ipa'), path.join(root, 'good-manifest.json')]);
  execFileSync('python3', [validator, '--ipa', path.join(root, 'good.ipa')]);
});
test('live Rust track protocol preserves source atoms and sends anchors only for actual anchor changes', () => {
  const { buildRustTrack, anchorChanged, projectPosition } = require('../../ExpoLyrics/lib/rust-lyrics-protocol.js');
  const lyrics = [{ lineStartTime: 10, lineEndTime: 30, backgroundSyllables: [{ text: 'x', startTime: 20, endTime: 45 }], syllables: [{ text: '뒤', startTime: 10, endTime: 20, isPartOfWord: true }, { text: '죽', startTime: 20, endTime: 30 }] },
    { lineStartTime: 50, lineEndTime: 70, syllables: [{ text: 'a', startTime: 50, endTime: 70 }] }];
  const packet = JSON.parse(buildRustTrack('current-song', 7, lyrics));
  assert.equal(packet.generation, 7); assert.equal(packet.track_id, 'current-song');
  assert.equal(packet.lines[0].atoms.map(a => a.text).join(''), '뒤죽');
  // Background voice tails keep the row active past the lead end (Skia getBackgroundEndTime).
  assert.equal(packet.lines[0].background_end, 45);
  assert.equal('background_end' in packet.lines[1], false);
  const previous = { anchorPositionMs: 50, anchorMonotonicMs: 100, isPlaying: true, currentTrack: { id: 'current-song', durationMs: 1000 }, positionMs: 70 };
  assert.equal(anchorChanged({ ...previous, positionMs: 80 }, previous), false);
  assert.equal(anchorChanged({ ...previous, anchorMonotonicMs: 120 }, previous), true);
  assert.equal(projectPosition(previous, 150), 100);
  assert.equal(projectPosition({ ...previous, isPlaying: false }, 150), 50);
  // Prepared tracks carry source background voices under their parent line, and
  // the producer refuses a voice whose own timing is unusable.
  const voice = (start, end, text) => ({ start, end, text, words: [{ text, offset: 0, start, end }], cjk_breaks: [], opposite: false, duet: true });
  const prepared = { settings: { style: 'spicy', font_scale: 1, landscape: false },
    paints: lyrics.map(line => voice(line.lineStartTime, line.lineEndTime, 'x')),
    backgrounds: [[voice(20, 45, 'bg')], []] };
  const withBackgrounds = JSON.parse(buildRustTrack('current-song', 8, lyrics, prepared));
  assert.equal(withBackgrounds.lines[0].backgrounds.length, 1);
  assert.equal(withBackgrounds.lines[0].backgrounds[0].end, 45);
  assert.equal(withBackgrounds.lines[0].paint.start, 10);
  assert.equal('backgrounds' in withBackgrounds.lines[1], false);
  assert.equal(withBackgrounds.lines[0].background_end, 45);
  assert.throws(() => buildRustTrack('current-song', 9, lyrics, { ...prepared,
    backgrounds: [[{ start: 20, end: 10, text: 'bg', words: [] }], []] }), /background vocal timing/);
});
test('native lifecycle source harness flushes inactive updates and bounds paused surface retries', () => {
  // Explicit source-level harness: executes the simple Swift activation body after
  // syntax translation, and checks asynchronous scheduling contracts. Not an iOS runtime test.
  const swift = fs.readFileSync(path.join(repo, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8');
  function body(name) {
    const start = swift.indexOf(`func ${name}(`, swift.indexOf('final class KineSyncRustLyricsView'));  assert.ok(start >= 0, name);
    const open = swift.indexOf('{', start); let depth = 1, at = open + 1;
    while (depth && at < swift.length) { if (swift[at] === '{') depth++; if (swift[at] === '}') depth--; at++; }
    return swift.slice(open + 1, at - 1);
  }
  const activation = body('setActive').replace(/if value \{/g, 'if (value) {');
  for (const firstAttach of [false, true]) {
    const calls = [];
    const state = { enabled: false, dirty: false, viewGeneration: 9, nativeGeneration: firstAttach ? 0 : 8, nativeAnchor: null,
      latestSize: [430, 932], latestAnchor: { generation: 9, sequence: 1 },
      markDirty() { state.dirty = true; calls.push('dirty'); },
      refresh() { if (state.enabled) { state.nativeGeneration = state.viewGeneration; state.nativeAnchor = state.latestAnchor; calls.push('refresh'); } },
      lifecycle() { calls.push('lifecycle'); } };
    // No layout or foreground callback is provided, just active true.
    new Function('state', 'value', `with (state) { ${activation} }`)(state, true);
    assert.equal(state.nativeGeneration, 9); assert.equal(state.nativeAnchor.generation, 9);
    assert.equal(state.dirty, true); assert.deepEqual(calls, ['dirty', 'refresh', 'lifecycle']);
  }
  const tick = body('tick'), retry = body('scheduleRetry'), mark = body('markDirty'), lifecycle = body('lifecycle');
  assert.match(tick, /owner\.draw\(targetMs: display\.targetTimestamp \* 1000, resumeStepMs: resumeStepMs, request: request\) \{ \[weak self\] result, renderedGeneration, settling, nextCue/);
  assert.match(tick, /#if DEBUG\s+let request = recordTrace\(display, start, \.request\)\s+#else\s+let request: FrameRequest\? = nil\s+#endif/);
  assert.match(swift, /#if DEBUG\s+private struct FrameRequest: Sendable \{[^}]+\}\s+private struct TraceCapture: Sendable \{[^}]+\}\s+#else\s+private typealias FrameRequest = Void\s+#endif/);
  assert.match(swift, /#if DEBUG\s+Prop\("traceSession"\)[^\n]+\s+Prop\("tracePanelVisible"\)/);
  assert.match(swift, /#if DEBUG\s+if let request, let capture = self\.traceCapture, capture\.token == request\.token,\s+capture\.generation == self\.currentGeneration \{\s+result = kr_frame_trace_render\(self\.handle, frameTarget, sampled, resumeStepMs, request\.id, request\.segment\)\s+\} else \{\s+result = kr_render\(self\.handle, frameTarget, sampled, resumeStepMs\)\s+\}\s+#else\s+result = kr_render\(self\.handle, frameTarget, sampled, resumeStepMs\)\s+#endif/);
  assert.match(body('syncTraceTimer'), /if tracePanelVisible, frameTrace != nil[\s\S]*?traceTimer\?\.invalidate\(\)/);
  assert.match(swift, /#if DEBUG\s+Events\("onStatus", "onFrameTrace", "onFrameTraceReset"\)\s+#else\s+Events\("onStatus"\)/);
  const attach = swift.slice(swift.indexOf('  override func didMoveToWindow()'), swift.indexOf('  override func layoutSubviews()'));
  assert.match(attach, /if window == nil \{[\s\S]*?owner\?\.dispose\(\); owner = nil[\s\S]*?syncFrameTrace\(\)/);
  const syncTrace = body('syncFrameTrace');
  assert.match(syncTrace, /owner\.setFrameTrace\(capture\)\s+emitTraceReset\(capture, token: capture\.token, active: true\)/);
  assert.match(syncTrace, /frameTrace = nil\s+owner\?\.setFrameTrace\(nil\)\s+CallbackTrace\.nextToken &\+= 1\s+emitTraceReset\(previous\.capture, token: CallbackTrace\.nextToken, active: false\)/);
  assert.doesNotMatch(body('emitTraceReset'), /tracePanelVisible|tracePulse/);
  assert.match(tick, /self\.frameRevision == requestedRevision, renderedGeneration == self\.generation/);
  assert.match(tick, /if result == 2 \{\s*self\.scheduleRetry/);
  assert.match(tick, /else if result == 1[\s\S]*?self\.retryBlocked = true/);
  assert.match(retry, /guard retryCount < Self\.retryDelays\.count else/);
  assert.match(retry, /retryBlocked = true/);
  assert.match(retry, /DispatchQueue\.main\.asyncAfter/);
  assert.match(retry, /self\.session == epoch, self\.frameRevision == revision/);
  assert.match(retry, /self\.window != nil, self\.foreground, self\.enabled, !self\.failed/);
  assert.match(mark, /retryWork\?\.cancel\(\)/);
  assert.match(lifecycle, /retryWork == nil && !retryBlocked/);
  const delays = JSON.parse(swift.match(/retryDelays: \[TimeInterval\] = (\[[^\n]+\])/)[1]);
  assert.equal(delays.length, 4); assert.ok(delays.every(delay => delay >= 0.1 && delay <= 0.8));
  // One initial attempt + four delayed retries, then no scheduling until a new input/lifecycle event.
  const attempts = [0, ...delays.reduce((times, delay) => [...times, (times.at(-1) || 0) + delay], [])];
  assert.equal(attempts.length, 5); assert.ok(attempts.at(-1) >= 1.5);
  const rust = fs.readFileSync(path.join(repo, 'native/lyrics-renderer/src/ffi.rs'), 'utf8');
  assert.match(rust, /surface\.acquire\(\)[\s\S]*?else \{\s*return Ok\(2\);/);
});
test('Rust cache verifier rejects simulator slices and final proof rejects archive-only integration', t => {
  const root = temp(t), bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const { symbols, inspect } = require('../ios-dev-ci/rust-device.cjs');
  const { prove } = require('../ios-dev-ci/link-proof.cjs');
  const tool = `#!/usr/bin/env node
const fs=require('node:fs');
if(require('node:path').basename(process.argv[1])==='plutil') process.stdout.write(fs.readFileSync(process.argv.at(-1)));
else if(process.argv.includes('lipo')) console.log('arm64');
else if(process.argv.includes('nm')) console.log(process.env.TEST_NM || '');
`;
  for (const name of ['plutil', 'xcrun']) fs.writeFileSync(path.join(bin, name), tool, { mode: 0o755 });
  const previousPath = process.env.PATH, previousNm = process.env.TEST_NM;
  process.env.PATH = bin + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; if (previousNm == null) delete process.env.TEST_NM; else process.env.TEST_NM = previousNm; });
  const framework = path.join(root, 'KineSyncLyrics.xcframework');
  put(framework, 'ios-arm64/liblyrics_renderer.a');
  put(framework, 'ios-arm64/Headers/KineSyncLyrics.h');
  put(framework, 'ios-arm64/Headers/module.modulemap', 'module KineSyncLyrics { export * }');
  const slice = { LibraryIdentifier: 'ios-arm64', LibraryPath: 'liblyrics_renderer.a', HeadersPath: 'Headers', SupportedPlatform: 'ios', SupportedArchitectures: ['arm64'] };
  put(framework, 'Info.plist', JSON.stringify({ AvailableLibraries: [{ ...slice, SupportedPlatformVariant: 'simulator' }] }));
  assert.throws(() => inspect(framework), /simulator/);
  put(framework, 'Info.plist', JSON.stringify({ AvailableLibraries: [slice] }));
  assert.equal(inspect(framework).slice.SupportedPlatform, 'ios');
  const app = path.join(root, 'Final.app'), evidence = path.join(root, 'evidence'), ios = path.join(root, 'ios');
  fs.mkdirSync(evidence);
  put(app, 'Final', 'final Mach-O mock');
  const map = path.join(root, 'App-LinkMap.txt'); put(root, 'App-LinkMap.txt', 'liblyrics_renderer.a _kr_render');
  put(ios, 'Pods/Target Support Files/Pods-App/ExpoModulesProvider.swift', 'KineSyncRustLyricsModule.self');
  put(evidence, 'rust-js-path.jsbundle', 'KineSyncRustLyrics Lyrics renderer unavailable.');
  put(evidence, 'rust-js-path.map', JSON.stringify({ version: 3, sources: ['app/(tabs)/index.tsx', 'components/onboarding/renderer-preview.tsx', 'store/playback-store.ts', 'components/lyrics/rust/rust-lyrics-view.tsx'], names: [], mappings: '' }));
  // The archive exists and its metadata passes, but the actual app lacks Rust.
  process.env.TEST_NM = '0000 T _unrelated';
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), /Final app Mach-O/);
  process.env.TEST_NM = symbols.map(symbol => `0000 T _${symbol}`).join('\n');
  for (const name of ['SF-Pro-Display-Regular.otf', 'SF-Pro-Display-Bold.otf']) put(app, 'KineSyncLyricsFonts.bundle/' + name, fs.readFileSync(path.join(repo, 'ExpoLyrics/assets/fonts', name)));
  const report = prove({ app, executable: 'Final', linkMap: map, ios, evidence });
  assert.equal(Object.keys(report.symbols).length, symbols.length);
  const flat = sources => ({ version: 3, sources, names: [], mappings: '' });
  const indexed = maps => ({ version: 3, sections: maps.map((map, line) => ({ offset: { line, column: 0 }, map })) });
  // Metro's indexed output has no top-level sources and can contain empty sections.
  for (const sourcemap of [
    indexed([flat([]), flat(['app/(tabs)/index.tsx', 'components/onboarding/renderer-preview.tsx', 'store/playback-store.ts', 'components/lyrics/rust/rust-lyrics-view.tsx'])]),
    indexed([flat([]), indexed([flat(['app/(tabs)/index.tsx', 'components/onboarding/renderer-preview.tsx', 'store/playback-store.ts', 'components/lyrics/rust/rust-lyrics-view.tsx'])])]),
  ]) {
    put(evidence, 'rust-js-path.map', JSON.stringify(sourcemap));
    assert.equal(Object.keys(prove({ app, executable: 'Final', linkMap: map, ios, evidence }).symbols).length, symbols.length);
  }
  fs.unlinkSync(path.join(evidence, 'rust-link-proof.json'));
  fs.unlinkSync(path.join(evidence, 'app-rust-LinkMap.txt'));
  fs.unlinkSync(path.join(evidence, 'ExpoModulesProvider-0.swift'));
  put(evidence, 'rust-js-path.map', JSON.stringify(indexed([flat(['app/(tabs)/index.tsx'])])));
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), /Compiled development JS/);
  assert.equal(fs.readFileSync(path.join(evidence, 'app-rust-LinkMap.txt'), 'utf8'), fs.readFileSync(map, 'utf8'));
  assert.match(fs.readFileSync(path.join(evidence, 'ExpoModulesProvider-0.swift'), 'utf8'), /KineSyncRustLyricsModule/);
  assert.ok(!fs.existsSync(path.join(evidence, 'rust-link-proof.json')));
  // Removing any wiring marker must fail the proof.
  put(evidence, 'rust-js-path.map', JSON.stringify(flat(['app/(tabs)/index.tsx', 'components/lyrics/rust/rust-lyrics-view.tsx'])));
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), /Compiled development JS/);
  put(evidence, 'rust-js-path.map', JSON.stringify(flat(['app/(tabs)/index.tsx', 'components/onboarding/renderer-preview.tsx', 'store/playback-store.ts', 'components/lyrics/rust/rust-lyrics-view.tsx'])));
  put(evidence, 'rust-js-path.jsbundle', 'KineSyncRustLyrics');
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), /Compiled development JS/);
  put(evidence, 'rust-js-path.jsbundle', 'KineSyncRustLyrics Lyrics renderer unavailable.');
  put(evidence, 'rust-js-path.map', '{invalid JSON');
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), SyntaxError);
  put(evidence, 'rust-js-path.map', JSON.stringify(flat(['app/(tabs)/index.tsx', 'components/onboarding/renderer-preview.tsx', 'store/playback-store.ts', 'components/lyrics/rust/rust-lyrics-view.tsx'])));
  put(evidence, 'rust-js-path.jsbundle', 'Lyrics renderer unavailable.');
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), /Compiled development JS/);
  put(evidence, 'rust-js-path.jsbundle', 'KineSyncRustLyrics Lyrics renderer unavailable.');
  put(evidence, 'rust-js-path.map', JSON.stringify(flat(['app/(tabs)/index.tsx', 'components/onboarding/renderer-preview.tsx',
    'components/lyrics/rust/rust-lyrics-view.tsx', 'components/lyrics/amll-webview-bundle.ts'])));
  assert.throws(() => prove({ app, executable: 'Final', linkMap: map, ios, evidence }), /Rust-only player/);
});

for (const shell of new Set([process.env.BASH32 || '/bin/bash', '/bin/bash'])) {
  test(`real Rust producer preserves empty/nonempty feature arguments under ${shell}`, t => {
    const version = execFileSync(shell, ['--version'], { encoding: 'utf8' }).split('\n')[0];
    t.diagnostic(version);
    if (shell === process.env.BASH32) assert.match(version, /version 3\.2\./, 'BASH32 must name a real Bash 3.2 interpreter');
    for (const [kind, features] of [['release', []], ['development', ['metal-surface', 'metrics/trace', 'dev-frame-trace', 'dev-render-metrics']]]) {
      const root = temp(t), workspace = path.join(root, 'workspace with spaces'), bin = path.join(root, 'tools');
      fs.mkdirSync(workspace); fs.mkdirSync(bin);
      const buildConfig = structuredClone(config);
      buildConfig.rust.features = features.filter(feature => !config.developmentRustFeatures.includes(feature));
      put(workspace, 'scripts/ios-dev-ci/config.json', JSON.stringify(buildConfig));
      put(workspace, 'scripts/ios-dev-ci/rust-device.cjs', fs.readFileSync(path.join(repo, 'scripts/ios-dev-ci/rust-device.cjs')));
      put(workspace, 'native/lyrics-renderer/include/KineSyncLyrics.h', '/* fixture ABI header */');
      const tool = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify({name,args,sdk:process.env.SDKROOT})+'\\n');
const check = (value) => { if (!value) throw new Error('Unexpected '+name+' invocation: '+JSON.stringify(args)); };
if (name === 'node') {
 if (args[0] === '-p') {
  if (args[1].includes('.effectiveRust()')) {
   console.log(require(path.resolve('scripts/ios-dev-ci/rust-device.cjs')).effectiveRust().features.join(','));
  } else {
   const rust = JSON.parse(fs.readFileSync('scripts/ios-dev-ci/config.json')).rust;
   const field = args[1].match(/\\.rust\\.(toolchain|target|profile)/)?.[1];
   check(field); console.log(rust[field]);
  }
 } else {
  check(args[0] === 'scripts/ios-dev-ci/rust-device.cjs' && args[1] === 'seal');
  check(fs.existsSync(path.join(process.env.RUST_PREBUILT_DIR,'KineSyncLyrics.xcframework')));
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR,'sealed'),'yes');
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR,'rust-static-nm.txt'),'0000 T _kr_abi_version');
 }
} else if (name === 'cargo') {
 const library=path.join(process.env.CARGO_TARGET_DIR,'aarch64-apple-ios/release/liblyrics_renderer.a');
 fs.mkdirSync(path.dirname(library),{recursive:true}); fs.writeFileSync(library,'fake arm64 archive');
} else if (name === 'xcrun') {
 if (args.join(' ') === '--sdk iphoneos --show-sdk-path') console.log('/fake iPhoneOS SDK');
 else {
  check(fs.existsSync(args.at(-1)));
  if(args[0]==='lipo') console.log('arm64');
  else { throw new Error('Apple nm must not read Rust archives'); }
 }
} else {
 check(name==='xcodebuild' && args[0]==='-create-xcframework');
 check(fs.existsSync(args[args.indexOf('-library')+1]));
 const headers=args[args.indexOf('-headers')+1];
 check(fs.readFileSync(path.join(headers,'KineSyncLyrics.h'),'utf8')==='/* fixture ABI header */');
 check(fs.readFileSync(path.join(headers,'module.modulemap'),'utf8').includes('module KineSyncLyrics'));
 fs.mkdirSync(args[args.indexOf('-output')+1],{recursive:true});
}
`;
      for (const name of ['cargo', 'node', 'xcrun', 'xcodebuild']) fs.writeFileSync(path.join(bin, name), tool, { mode: 0o755 });
      const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
      const env = { ...process.env, KINESYNC_IOS_BUILD_KIND: kind, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace,
        CI_EVIDENCE_DIR: evidence, RUST_PREBUILT_DIR: path.join(root, 'prebuilt with spaces'),
        RUST_DEVICE_KEY: 'fixture-key', CARGO_TARGET_DIR: path.join(root, 'target with spaces'),
        RUNNER_TEMP: path.join(root, 'runner temp'), TOOL_LOG: path.join(root, 'tools.jsonl') };
      const result = spawnSync(shell, [path.join(repo, 'scripts/ios-dev-ci/build-rust-device.sh')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${version}, features=${JSON.stringify(features)}\n${result.stderr}`);
      const calls = fs.readFileSync(env.TOOL_LOG, 'utf8').trim().split('\n').map(JSON.parse);
      const cargo = calls.filter(call => call.name === 'cargo');
      assert.equal(cargo.length, 1);
      assert.deepEqual(cargo[0].args, [`+${buildConfig.rust.toolchain}`, 'build', '--locked', '--lib', '--manifest-path',
        'native/lyrics-renderer/Cargo.toml', '--target', 'aarch64-apple-ios', '--profile', 'release',
        ...(features.length ? ['--features', features.join(',')] : [])]);
      assert.equal(cargo[0].sdk, '/fake iPhoneOS SDK');
      assert.equal(fs.readFileSync(path.join(evidence, 'sealed'), 'utf8'), 'yes');
      assert.match(fs.readFileSync(path.join(evidence, 'rust-static-nm.txt'), 'utf8'), /_kr_abi_version/);
    }
  });
}

test('Cargo cache identity covers the toolchain and archive check scripts', t => {
  const root = temp(t); fixture(root);
  const initial = cacheKeys(root, identity, 'test', 'branch');
  for (const file of ['scripts/ios-dev-ci/rust-device.cjs', 'scripts/ios-dev-ci/build-rust-device.sh', 'scripts/ios-dev-ci/ci.cjs', '.github/workflows/ios-development-build.yml']) {
    put(root, file, 'changed');
    const updated = cacheKeys(root, identity, 'test', 'branch');
    assert.notEqual(updated.rustShared, initial.rustShared, file);
    assert.notEqual(updated.prebuilt, initial.prebuilt, file);
    put(root, file);
  }
  const changed = structuredClone(config); changed.rust.toolchain = '1.98.0';
  assert.notEqual(cacheKeys(root, identity, 'test', 'branch', changed).rustShared, initial.rustShared);
});

test('producer sealing and cache-hit validation use pinned llvm-nm and reject failed or incomplete inventories', t => {
  const root = temp(t), bin = path.join(root, 'bin'), sysroot = path.join(root, 'pinned sysroot');
  const { symbols } = require('../ios-dev-ci/rust-device.cjs');
  const reader = path.join(sysroot, 'lib/rustlib/test-host/bin/llvm-nm');
  fs.mkdirSync(bin); fs.mkdirSync(path.dirname(reader), { recursive: true });
  const tool = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
if (name === 'rustc') {
 assert.equal(args[0], '+${config.rust.toolchain}');
 console.log(args.includes('sysroot') ? process.env.TEST_SYSROOT : 'host: test-host');
} else if (name === 'plutil') process.stdout.write(fs.readFileSync(args.at(-1)));
else if (name === 'xcrun') { assert.equal(args[0], 'lipo'); console.log('arm64'); }
else {
 assert.equal(name, 'llvm-nm');
 assert.deepEqual(args.slice(0, 2), ['--extern-only', '--defined-only']);
 assert.ok(fs.existsSync(args[2]));
 process.stdout.write(process.env.TEST_NM);
 if (process.env.TEST_NM_FAIL === 'true') { console.error('reader rejected archive'); process.exit(7); }
}
`;
  for (const file of [...['rustc', 'plutil', 'xcrun'].map(name => path.join(bin, name)), reader]) fs.writeFileSync(file, tool, { mode: 0o755 });
  const framework = path.join(root, config.rust.framework);
  put(framework, 'ios-arm64/liblyrics_renderer.a');
  put(framework, 'ios-arm64/Headers/KineSyncLyrics.h');
  put(framework, 'ios-arm64/Headers/module.modulemap', 'module KineSyncLyrics { export * }');
  put(framework, 'Info.plist', JSON.stringify({ AvailableLibraries: [{ LibraryIdentifier: 'ios-arm64', LibraryPath: 'liblyrics_renderer.a', HeadersPath: 'Headers', SupportedPlatform: 'ios', SupportedArchitectures: ['arm64'] }] }));
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  const destination = path.join(root, 'workspace/ExpoLyrics/modules/kinesync-rust-lyrics/ios/Frameworks');
  const env = { ...process.env, KINESYNC_IOS_BUILD_KIND: 'release', PATH: bin + path.delimiter + process.env.PATH, TEST_SYSROOT: sysroot,
    TEST_NM: symbols.map(symbol => `0000 T _${symbol}`).join('\n'),
    CI_EVIDENCE_DIR: evidence, RUST_PREBUILT_DIR: root, RUST_DEVICE_KEY: 'key', GITHUB_WORKSPACE: path.join(root, 'workspace') };
  const run = (command, overrides = {}) => spawnSync(process.execPath, [path.join(repo, 'scripts/ios-dev-ci/rust-device.cjs'), command], { env: { ...env, ...overrides }, encoding: 'utf8' });
  for (const command of ['seal', 'validate']) {
    const failed = run(command, { TEST_NM_FAIL: 'true' });
    // validate needs a sealed manifest, created only after the seal rejection checks below.
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /reader rejected archive/);
    const missing = run(command, { TEST_NM: '0000 T _kr_abi_version' });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /missing kr_create/);
    assert.ok(!fs.existsSync(command === 'seal' ? path.join(root, 'manifest.json') : destination));
    const valid = run(command); assert.equal(valid.status, 0, valid.stderr);
    assert.equal(fs.readFileSync(path.join(evidence, 'rust-static-nm.txt'), 'utf8'), env.TEST_NM);
  }
  assert.ok(fs.existsSync(path.join(destination, config.rust.framework)));
  const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.deepEqual(manifest().rust.features, []);
  const traceMarker = '\n0000 T _kr_frame_trace_build_marker';
  const metricsMarker = '\n0000 T _kr_render_metrics_build_marker';
  const dev = { KINESYNC_IOS_BUILD_KIND: 'development',
    TEST_NM: env.TEST_NM + traceMarker + metricsMarker };
  assert.match(run('validate', dev).stderr, /source\/config identity mismatch/);
  assert.match(run('seal', { TEST_NM: dev.TEST_NM }).stderr, /trace feature mismatch/);
  assert.match(run('seal', { ...dev, TEST_NM: env.TEST_NM }).stderr, /trace feature mismatch/);
  assert.match(run('seal', { TEST_NM: env.TEST_NM + metricsMarker }).stderr, /metrics feature mismatch/);
  assert.match(run('seal', { ...dev, TEST_NM: env.TEST_NM + traceMarker }).stderr, /metrics feature mismatch/);
  const sealed = run('seal', dev);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.deepEqual(manifest().rust.features, ['dev-frame-trace', 'dev-render-metrics']);
  assert.match(run('validate').stderr, /source\/config identity mismatch/);
  const validated = run('validate', dev);
  assert.equal(validated.status, 0, validated.stderr);
  fs.unlinkSync(reader);
  const absent = run('validate', dev); assert.notEqual(absent.status, 0); assert.match(absent.stderr, /ENOENT/);
});

test('SourceMap v3 source collection accepts flat and nested Metro sections and fails closed on malformed maps', () => {
  const { sourceMapSources } = require('../ios-dev-ci/link-proof.cjs');
  const flat = { version: 3, sources: ['app/(tabs)/index.tsx'], names: [], mappings: 'AAAA' };
  const section = map => ({ offset: { line: 0, column: 0 }, map });
  const indexed = { version: 3, sections: [section(flat)] };
  assert.deepEqual(sourceMapSources(flat), flat.sources);
  assert.deepEqual(sourceMapSources({ version: 3, sections: [section(indexed)] }), flat.sources);
  for (const malformed of [null, [], {}, { ...flat, version: 2 }, { ...flat, sources: 'path' },
    { ...flat, sources: [null] }, { ...flat, mappings: null }, { ...flat, names: null },
    { version: 3, sections: {} }, { ...indexed, sources: [] },
    { version: 3, sections: [null] }, { version: 3, sections: [{ offset: { line: 0, column: 0 }, url: 'remote.map' }] },
    { version: 3, sections: [{ ...section(flat), offset: { line: -1, column: 0 } }] },
    { version: 3, sections: [section({})] },
    // A valid target section must not hide a malformed sibling.
    { version: 3, sections: [section(flat), section({})] },
  ]) assert.throws(() => sourceMapSources(malformed), /Malformed/);
  for (const empty of [{ ...flat, sources: [] }, { ...flat, sources: [''] }, { version: 3, sections: [] },
    { version: 3, sections: [section({ ...flat, sources: [] })] }]) {
    assert.throws(() => sourceMapSources(empty), /no sources/);
  }
});

test('native frame source contract uses display targets, one draw and asynchronous retirement', () => {
  // Normalize Windows CRLF once so body slicing and closing-brace extraction
  // operate on the same LF layout as the reviewed checkout.
  const swift = fs.readFileSync(path.join(repo, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8')
    .replace(/\r\n/g, '\n');
  const predicate = swift.match(/guard (dirty \|\| animating) else/)[1];
  const needsFrame = new Function('dirty', 'animating', `return ${predicate}`);
  // ABI 9: playback alone no longer arms continuous drawing. Settled playback
  // arms one cancellable cue wakeup, so only input or reported motion draws.
  assert.equal(needsFrame(false, false), false);
  assert.equal(needsFrame(false, true), true);
  assert.equal(needsFrame(true, false), true);
  const busy = swift.search(/if busy \{\s+#if DEBUG\s+_ = recordTrace\(display, start, \.busy\)\s+#endif\s+return\s+\}/);
  const draw = swift.indexOf('owner.draw(targetMs:');
  assert.ok(busy >= 0 && draw > busy);
  assert.match(swift, /busy = true; dirty = false\s+let epoch = session\s+let requestedRevision = frameRevision/);
  assert.match(swift, /result = kr_render\(self.handle, frameTarget, sampled, resumeStepMs\)/);
  assert.match(swift, /let sampled = CACurrentMediaTime\(\) \* 1000/);
  assert.match(swift, /preferredFrameRateRange = CAFrameRateRange/);
  assert.match(swift, /min\(120, window\?\.screen.maximumFramesPerSecond \?\? 60\)/);
  assert.ok(!swift.includes('queue.sync'));
  assert.match(swift, /private static let worker = DispatchQueue/);
  assert.match(swift, /if kr_metrics\(self\.handle, &m\) < 0 \{ self\.failure\(\); return \}\s+animating = m\.animating != 0\s+nextCue = m\.next_cue_native_ms/);
  assert.match(swift, /queue.async \{\s*if self.handle != 0 \{ _ = kr_destroy/);
  // Execute the actual coalescing body with only Swift syntax/queue primitives
  // translated. 10,000 input bursts must occupy one pending worker task.
  const enqueue = swift.slice(swift.indexOf('    gate.lock()', swift.indexOf('private func enqueue(')), swift.indexOf('  private func drainInput()'))
    .replace(/\n  \}\n$/, '')
    .replaceAll('gate.lock()', '').replaceAll('gate.unlock()', '')
    .replace('guard !retired else { ; return }', 'if (retired) { return }')
    .replace('if let update {', 'if (update) {').replace('if let anchor {', 'if (anchor) {')
    .replace('let schedule =', 'const schedule =')
    .replace('guard schedule else { return }', 'if (!schedule) { return }')
    .replace('queue.async { self.drainInput() }', 'tasks.push(() => self.drainInput())');
  const pending = { retired: false, inputScheduled: false, pendingUpdate: null, pendingAnchor: null, pendingSnap: false, tasks: [], self: { drainInput() {} } };
  const offer = new Function('state', 'update', 'anchor', `with (state) { ${enqueue} }`);
  for (let i = 0; i < 10000; i++) offer(pending, { generation: i }, { sequence: i, snap: i === 1 });
  assert.equal(pending.tasks.length, 1);
  assert.equal(pending.pendingUpdate.generation, 9999); assert.equal(pending.pendingAnchor.sequence, 9999);
  assert.equal(pending.pendingSnap, true); // coalescing must retain an explicit seek's snap intent
  pending.retired = true; offer(pending, { generation: 10000 }, null);
  assert.equal(pending.pendingUpdate.generation, 9999);
  assert.doesNotMatch(swift, /onMetrics|lastMetrics|windowCallbacks|"state": "metrics"/);
  assert.match(swift, /guard foreground, tracePanelVisible, let owner, let trace = frameTrace[\s\S]*?now - trace\.lastSummaryDeliveryMs >= 500 else \{ return \}/);
  assert.match(swift, /guard self\.foreground, self\.tracePanelVisible, self\.traceSummaryRevision == summaryRevision/);
  const gpu = fs.readFileSync(path.join(repo, 'native/lyrics-renderer/src/gpu.rs'), 'utf8');
  assert.match(gpu, /render_frame_with_overlay\(scene, overlay, band, blur, false, appearance, glow\)/);
  const metricsOnly = String.raw`#\[cfg\(any\(test, feature = "dev-render-metrics"\)\)\]\s+`;
  assert.match(gpu, new RegExp(metricsOnly + String.raw`timestamps: Option<Timestamps>,`));
  assert.match(gpu, new RegExp(metricsOnly + String.raw`let \(adapter_name, capabilities, required_features\) = \{\s+let adapter_name = [^\n]+;\s+println!\([^\n]+\);\s+let wanted = Features::TIMESTAMP_QUERY \| Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;`));
  assert.match(gpu, /#\[cfg\(not\(any\(test, feature = "dev-render-metrics"\)\)\)\]\s+let \(adapter_name, capabilities, required_features\) = \(String::new\(\), 3, Features::empty\(\)\);/);
  assert.match(gpu, /\.request_device\(&DeviceDescriptor \{\s+label: Some\("lyrics-renderer"\),\s+required_features,/);
  assert.match(gpu, new RegExp(metricsOnly + String.raw`let timestamps = \(!required_features\.is_empty\(\) && surface\.is_none\(\)\)\.then\(\|\| Timestamps \{\s+queries: device\.create_query_set\(`));
  assert.match(gpu, new RegExp(metricsOnly + String.raw`let timestamps = self\.timestamps\.as_ref\(\)\.filter\(\|_\| wait_for_completion\);`));
  const gatedTimestampWrite = String.raw`if let Some\(ts\) = timestamps \{[^}]*?encoder\.write_timestamp\(&ts\.queries, [01]\);`;
  const timestampWrites = gpu.match(/\.write_timestamp\(/g) ?? [];
  assert.equal(timestampWrites.length, 2);
  assert.equal(gpu.match(new RegExp(metricsOnly + gatedTimestampWrite, 'g'))?.length, timestampWrites.length);
  assert.match(gpu, new RegExp(metricsOnly + String.raw`let gpu_interval_ms = if let Some\(ts\) = timestamps \{\s+let data = read_buffer\(&self\.device, &ts\.readback\)\?;`));
  assert.match(gpu, /device.poll\(PollType::Poll\)/);
  assert.match(gpu, /on_submitted_work_done/);
  assert.match(swift, /frameTarget = max\(targetMs, sampled\)/);
  assert.match(swift, /if result == 3 \{ self.dirty = true/);
});

test('visual anchor clock preserves rate/pause/resume and snaps scrub/track/discontinuities', () => {
  const { nextVisualAnchor } = require('../../ExpoLyrics/lib/rust-lyrics-protocol.js');
  const state = { currentTrack: { id: 'a', durationMs: 60000 }, anchorPositionMs: 1000, anchorMonotonicMs: 0, isPlaying: true };
  let a = nextVisualAnchor(state, 0, 10000, 1, null);
  assert.equal(a.positionMs, 1000); assert.equal(a.snap, true);
  a = nextVisualAnchor(state, 1000, 11000, 0.5, a);
  assert.equal(a.positionMs, 2000); assert.equal(a.snap, false);
  a = nextVisualAnchor(state, 2000, 12000, 1.5, a);
  assert.equal(a.positionMs, 2500); // changing rate must not jump to store's 3000
  const paused = { ...state, isPlaying: false, anchorPositionMs: 4000, anchorMonotonicMs: 3000 };
  a = nextVisualAnchor(paused, 3000, 13000, 1.5, a);
  assert.equal(a.positionMs, 4000); assert.equal(a.playing, false); assert.equal(a.snap, false);
  a = nextVisualAnchor(paused, 6000, 16000, 1.5, a);
  assert.equal(a.positionMs, 4000);
  const resumed = { ...paused, isPlaying: true, anchorMonotonicMs: 6000 };
  a = nextVisualAnchor(resumed, 6000, 16000, 1.5, a);
  assert.equal(a.positionMs, 4000); assert.equal(a.snap, false);
  a = nextVisualAnchor(resumed, 6100, 16100, 1.5, a, 100);
  assert.equal(a.positionMs, 100); assert.equal(a.snap, true); assert.equal(a.playing, false);
  a = nextVisualAnchor(resumed, 6200, 16200, 1.5, a);
  assert.equal(a.positionMs, 4200); assert.equal(a.snap, true);
  a = nextVisualAnchor({ ...resumed, anchorPositionMs: 20000 }, 6300, 16300, 1.5, a);
  assert.equal(a.positionMs, 20300); assert.equal(a.snap, true);
  a = nextVisualAnchor({ ...state, currentTrack: { id: 'b', durationMs: 60000 } }, 0, 16400, 1, a);
  assert.equal(a.positionMs, 1000); assert.equal(a.snap, true);
});

test('Rust lyric surface keeps a full-size viewport, soft moving edge and real dock background', () => {
  const player = fs.readFileSync(path.join(repo, 'ExpoLyrics/app/(tabs)/index.tsx'), 'utf8');
  // The renderer viewport stays pinned to the full lyric area. No moving height
  // and no dock-measured surface returns, so the native view never resizes.
  assert.match(player, /style=\{\[styles\.lyricsWrap, lyricsViewportStyle\]\}/);
  assert.ok(!player.includes('foregroundClipStyle'));
  assert.ok(!player.includes('rustLyricsViewport'));
  assert.ok(!player.includes('setRustDockBounds'));
  assert.ok(!player.includes('rustDockBounds'));
  assert.doesNotMatch(player, /bottom: 0,\s*overflow: "hidden" as const/);
  // The moving edge is an alpha mask. The opaque band and the transparent
  // gradient fade meet at the dock edge so glyphs never end on a hard cut.
  // Android's native TextureView requires hardware composition.
  assert.match(player, /<MaskedView\b[^<>]*\bandroidRenderingMode="hardware"\s+maskElement=/);
  assert.doesNotMatch(player, /\bandroidRenderingMode\s*=\s*\{?\s*["']software["']/);
  assert.match(player, /const lyricsEdgeMaskSolidStyle = useAnimatedStyle\(\(\) => \{[\s\S]*?LYRICS_EDGE_FADE_HEIGHT \* Math\.max\(0, Math\.min\(1, controlsOpacity\.value\)\)[\s\S]*?height: Math\.max\(0, edge - fade\)/);
  assert.match(player, /const lyricsEdgeMaskFadeStyle = useAnimatedStyle\(\(\) => \{[\s\S]*?transform: \[\{ translateY: Math\.max\(0, edge - fade\) \}\],[\s\S]*?height: fade/);
  // The fade scales with controlsOpacity, so the hidden end state is fully opaque.
  assert.match(player, /LYRICS_EDGE_FADE_HEIGHT \* Math\.max\(0, Math\.min\(1, controlsOpacity\.value\)\)/);
  assert.match(player, /colors=\{_stableMaskColors9\}/);
  assert.match(player, /_stableMaskColors9 = \["rgba\(0,0,0,1\)", "rgba\(0,0,0,0\)"\]/);
  assert.match(player, /LYRICS_EDGE_FADE_HEIGHT,/);
  // The real animated artwork background remains mounted behind the lyrics.
  assert.equal((player.match(/<ArtworkBackground\s/g) || []).length, 1);
  assert.match(player, /<ArtworkBackground[\s\S]*?uri=\{resolvedArtworkUrl\}[\s\S]*?playing=\{isPlaying && !showEmptyState\}/);
  // The mask fades lyrics into the real dynamic background without a black
  // overlay. Keep the moving dock boundary independent of the row stagger.
  assert.doesNotMatch(player, /lyricsBottomBlurWrap|lyricsBottomBlurOpacityStyle|styles\.lyricsBottomBlur|_stableColors7/);
  assert.doesNotMatch(player, /rgba\(0,0,0,0\.85\)/);
  assert.match(player, /const fillTouchStyle = useAnimatedStyle\(\(\) => \(\{\s*top: screenHeight - Math\.max\(0, screenHeight - dockTop\.value\) \* controlsOpacity\.value/);
  assert.match(player, /style=\{\[styles\.fillTouchBlocker, fillTouchStyle\]\}/);
  assert.ok(!player.includes('!(__DEV__ && rustRenderer && !tour.active) && <Reanimated.View'));
  const view = fs.readFileSync(path.join(repo, 'ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8');
  const overlay = fs.readFileSync(path.join(repo, 'ExpoLyrics/components/lyrics/rust/rust-fps-overlay.tsx'), 'utf8');
  assert.match(view, /<NativeView\b[\s\S]*?\{\.\.\.frameProps\} \/> : null\}\s*<\/View>\s*\{overlay\}/,
    'The overlay remains a sibling outside the native gesture wrapper');
  assert.match(view, /const \{ frameProps, overlay \}: Diagnostics = __DEV__ \? useRendererDiagnostics\(\{[\s\S]*?\}\) : \{\};/,
    'Release must skip the diagnostics hook and supply no overlay or native trace props');
  const diagnostics = view.match(/const useRendererDiagnostics:[^\n]+ = __DEV__\s*\? function useDebugDiagnostics\(([\s\S]*?)^  : \(\) => \(\{\}\);/m)?.[1];
  assert.ok(diagnostics, 'The diagnostics implementation and its dependencies must live in a development-only branch');
  assert.match(diagnostics, /const \{ RustFpsOverlay \} = require\('\.\/rust-fps-overlay'\)/);
  assert.match(diagnostics, /require\('@\/lib\/rust-frame-trace'\)/);
  assert.match(diagnostics, /overlay: showRustDebugOverlay && !unavailable \? <RustFpsOverlay/);
  assert.doesNotMatch(view, /^import\s+(?!type\b)[^\n]+from ['"][^'"]*(?:rust-fps-overlay|rust-frame-trace)['"]/m);
  for (const module of ["require('./rust-fps-overlay')", "require('@/lib/rust-frame-trace')"]) {
    assert.equal(view.split(module).length, 2, `${module} must appear only inside the guarded implementation`);
  }
  assert.doesNotMatch(view, /<ScrollView|fpsStrip/);
  assert.match(overlay, /<View pointerEvents="box-none" style=\{\[styles\.position,[^\n]+\]\} onLayout=\{measureBounds\}/);
  assert.match(overlay, /position: \{ position: 'absolute'/);
  assert.doesNotMatch(overlay, /<ScrollView|Show FPS/);
  assert.match(overlay, /const scalarText = <Text[^>]*numberOfLines=\{1\} adjustsFontSizeToFit/);
  assert.match(overlay, /showScalar \? <View pointerEvents="none">\{scalarText\}/);
  assert.match(overlay, /inlineScalar && <View pointerEvents="none" style=\{styles\.inlineScalar\}>\{scalarText\}/);
  assert.match(overlay, /page === 1 && showTable && stats/);
  assert.match(overlay, /if \(update\.kind === 'reset'\) setSample\(null\)/);
  assert.match(view, /root: \{ flex: 1, minHeight: 0, overflow: 'hidden' \}/);
  assert.ok(!view.includes("position: 'absolute'"));
  assert.ok(!view.includes('GPU Vello+blur'));
});

test('generated, built and packaged app ProMotion key must be Boolean true', t => {
  const root = temp(t), plist = path.join(root, 'Info.plist');
  const validator = path.join(repo, 'scripts/ios-dev-ci/validate_ipa.py');
  for (const [value, status] of [['<true/>', 0], ['<false/>', 1], ['<string>true</string>', 1], ['<integer>1</integer>', 1]]) {
    put(root, 'Info.plist', `<plist version="1.0"><dict><key>CADisableMinimumFrameDurationOnPhone</key>${value}</dict></plist>`);
    assert.equal(spawnSync('python3', [validator, '--plist', plist]).status, status);
  }
  put(root, 'Info.plist', '<plist version="1.0"><dict/></plist>');
  assert.equal(spawnSync('python3', [validator, '--plist', plist]).status, 1);
  const ipa = path.join(root, 'bad-promotion.ipa');
  execFileSync('python3', ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('Payload/App.app/Info.plist', '<plist version="1.0"><dict><key>CADisableMinimumFrameDurationOnPhone</key><false/></dict></plist>')`, ipa]);
  const bad = spawnSync('python3', [validator, '--ipa', ipa], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /CADisableMinimumFrameDurationOnPhone/);
  const app = path.join(root, 'Bad.app');
  put(app, 'Info.plist', '<plist version="1.0"><dict/></plist>');
  const badApp = spawnSync('python3', [validator, '--app', app], { encoding: 'utf8' });
  assert.equal(badApp.status, 1); assert.match(badApp.stderr, /CADisableMinimumFrameDurationOnPhone/);
  const ci = fs.readFileSync(path.join(repo, 'scripts/ios-dev-ci/ci.cjs'), 'utf8');
  assert.match(ci, /'--plist', generatedPlist/); assert.match(ci, /'--plist', plist/);
  const header = fs.readFileSync(path.join(repo, 'native/lyrics-renderer/include/KineSyncLyrics.h'), 'utf8');
  assert.match(header, /uint32_t capabilities, animating/);
});

test('ABI 11 C layout and both native-client guards reject incompatible clients', () => {
  const view = fs.readFileSync(path.join(repo, 'ExpoLyrics/components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8');
  const condition = view.match(/if \((!api \|\| api.abiVersion\(\) !== \d+)\)/)[1];
  const rejects = new Function('api', `return ${condition}`);
  assert.equal(rejects(null), true);
  for (const version of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.equal(rejects({ abiVersion: () => version }), true);
  assert.equal(rejects({ abiVersion: () => 11 }), false);
  const swift = fs.readFileSync(path.join(repo, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8');
  assert.match(swift, /guard kr_abi_version\(\) == 11 else/);
  assert.match(swift, /AsyncFunction\("scrollBy"\)/);
  assert.match(swift, /AsyncFunction\("hitTest"\)/);
  assert.match(swift, /kr_scroll_by\(self\.handle, dy\)/);
  assert.match(swift, /UIPanGestureRecognizer\(target: self/);
  assert.match(swift, /pan\.velocity\(in: self\)\.y/);
  assert.match(swift, /kr_fling\(self\.handle, velocity, nativeMs\)/);
  assert.match(swift, /kr_hit_test\(self\.handle, x, y\)/);
  const androidOwner = fs.readFileSync(path.join(repo, 'ExpoLyrics/modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/RustOwner.kt'), 'utf8');
  assert.match(androidOwner, /RustBridge.abiVersion\(\) != 11/);
  assert.match(androidOwner, /RustBridge.hitTest\(handle, x, y\)/);
  const result = spawnSync('cc', ['-std=c11', '-x', 'c', '-fsyntax-only', '-I', path.join(repo, 'native/lyrics-renderer/include'), '-'], {
    encoding: 'utf8', input: `#include "KineSyncLyrics.h"
_Static_assert(sizeof(KRMetrics) == 168, "ABI 11 metrics size");
_Static_assert(offsetof(KRMetrics, capabilities) == 80, "capability offset");
_Static_assert(offsetof(KRMetrics, acquire_ms) == 88, "acquire offset");
_Static_assert(offsetof(KRMetrics, completed) == 120, "completion offset");
_Static_assert(offsetof(KRMetrics, target_native_ms) == 144, "clock offset");
_Static_assert(offsetof(KRMetrics, next_cue_native_ms) == 152, "cue offset");
_Static_assert(offsetof(KRMetrics, visible_changes) == 160, "visible change offset");
int32_t (*render_signature)(uint64_t, double, double, double) = kr_render;
int32_t (*fonts_signature)(uint64_t, const uint8_t *, size_t, const uint8_t *, size_t) = kr_set_fonts;
size_t (*layout_signature)(uint64_t, uint8_t *, size_t) = kr_copy_layout_json;
int32_t (*follow_signature)(uint64_t, bool) = kr_set_following;
int32_t (*scroll_signature)(uint64_t, double) = kr_scroll_by;
int32_t (*fling_signature)(uint64_t, double, double) = kr_fling;
int32_t (*hit_signature)(uint64_t, double, double) = kr_hit_test;
` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!swift.includes('presentedFps'));
  assert.ok(!view.includes('presentedFps'));
});


test('local pod font resources match CocoaPods descendant inventory and resolve tracked assets', t => {
  const relativePod = 'ExpoLyrics/modules/kinesync-rust-lyrics/ios';
  const pod = path.join(repo, relativePod);
  const spec = fs.readFileSync(path.join(pod, 'KineSyncRustLyrics.podspec'), 'utf8');
  const declaration = spec.match(/s\.resource_bundles\s*=\s*\{\s*'KineSyncLyricsFonts'\s*=>\s*\[([^\]]+)\]/);
  assert.ok(declaration, 'expected an explicit font resource bundle');
  const resources = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const fonts = [
    // The two SF faces remain relative symlinks to the tracked app assets.
    { name: 'SF-Pro-Display-Regular.otf', symlink: true },
    { name: 'SF-Pro-Display-Bold.otf', symlink: true },
    // The bundled CJK fallback and its license are new regular files in the pod.
    {
      name: 'NotoSansCJKsc-Regular.otf',
      symlink: false,
      bytes: 16_437_364,
      sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
    },
    {
      name: 'NotoSansCJKsc-Bold.otf',
      symlink: false,
      bytes: 17_002_248,
      sha256: 'b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a',
    },
    { name: 'NotoSansCJK-LICENSE.txt', symlink: false, license: true },
  ];
  assert.deepEqual(resources, fonts.map(font => 'Fonts/' + font.name));
  // CocoaPods 1.16.2 Sandbox::PathList enumerates descendants first, then
  // matches patterns against that inventory (not unrestricted Dir.glob).
  // File symlinks are entries; symlink directories need not be traversed.
  const inventory = new Set();
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'Frameworks') continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative + '/');
      else inventory.add(relative);
    }
  }
  walk(pod);
  // Run from an unrelated checkout path with spaces as well: links must be
  // relative to the local pod, not the process cwd or the rescue host path.
  const checkout = path.join(temp(t), 'checkout with spaces');
  for (const [i, resource] of resources.entries()) {
    const font = fonts[i];
    assert.ok(inventory.has(resource), `CocoaPods cannot select ${resource}`);
    const file = path.join(pod, resource);
    if (font.symlink) {
      const original = '../../../assets/fonts/' + font.name;
      assert.ok(fs.existsSync(path.resolve(pod, original)), 'original asset exists');
      assert.ok(!inventory.has(original), 'original escaping pattern matches nothing');
      assert.ok(fs.lstatSync(file).isSymbolicLink(), 'reuse assets without copying binaries');
      const target = fs.readlinkSync(file);
      assert.ok(!path.isAbsolute(target));
      const asset = path.join(repo, 'ExpoLyrics/assets/fonts', font.name);
      assert.equal(fs.realpathSync(file), fs.realpathSync(asset));
      put(checkout, 'ExpoLyrics/assets/fonts/' + font.name, fs.readFileSync(asset));
      const relocated = path.join(checkout, relativePod, resource);
      fs.mkdirSync(path.dirname(relocated), { recursive: true });
      fs.symlinkSync(target, relocated);
      assert.deepEqual(fs.readFileSync(relocated), fs.readFileSync(asset));
    } else {
      // New bundled files must stay inside the pod as regular tracked files.
      assert.ok(path.dirname(resource) === 'Fonts', `${resource} must stay in the pod Fonts directory`);
      assert.ok(fs.lstatSync(file).isFile(), `${resource} must be a regular file`);
      assert.ok(!fs.lstatSync(file).isSymbolicLink(), `${resource} must not be a symlink`);
      const bytes = fs.readFileSync(file);
      if (font.sha256) {
        assert.equal(bytes.length, font.bytes, `${resource} byte size`);
        assert.equal(
          crypto.createHash('sha256').update(bytes).digest('hex'),
          font.sha256,
          `${resource} digest`
        );
        assert.equal(bytes.subarray(0, 4).toString('latin1'), 'OTTO', `${resource} CFF signature`);
      } else {
        assert.match(bytes.toString('utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
      }
    }
  }
});

test('font resources invalidate native caches and packaged bytes fail closed', t => {
  const root=temp(t);fixture(root);const keys=()=>cacheKeys(root,identity,'fonts','refs/heads/rust-renderer-spike');
  const before=keys();put(root,'ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf','changed');
  const after=keys();assert.notEqual(before.derived,after.derived);assert.notEqual(before.lock,after.lock);assert.equal(before.prebuilt,after.prebuilt);
  const {inspectFonts}=require('../ios-dev-ci/rust-device.cjs');const app=path.join(root,'App.app');fs.mkdirSync(app);
  assert.throws(()=>inspectFonts(app),/exactly one/);
  for(const name of ['SF-Pro-Display-Regular.otf','SF-Pro-Display-Bold.otf'])put(app,'KineSyncLyricsFonts.bundle/'+name,fs.readFileSync(path.join(repo,'ExpoLyrics/assets/fonts',name)));
  assert.equal(Object.keys(inspectFonts(app)).length,2);
  put(app,'KineSyncLyricsFonts.bundle/SF-Pro-Display-Bold.otf','bad');assert.throws(()=>inspectFonts(app),/digest mismatch/);
  fs.unlinkSync(path.join(app,'KineSyncLyricsFonts.bundle/SF-Pro-Display-Bold.otf'));assert.throws(()=>inspectFonts(app),/Missing packaged/);
  fs.mkdirSync(path.join(app,'Duplicate/KineSyncLyricsFonts.bundle'),{recursive:true});assert.throws(()=>inspectFonts(app),/exactly one/);
});

test('device Rust uses release optimization without changing host dev profile', () => {
  assert.equal(config.rust.profile, 'release');
  assert.equal(config.rust.optLevel, 3);
  assert.equal(config.rust.lto, 'thin');
  assert.equal(config.rust.debugAssertions, false);
  const source = fs.readFileSync(path.join(repo, 'scripts/ios-dev-ci/ci.cjs'), 'utf8');
  assert.match(source, /CARGO_PROFILE_RELEASE_OPT_LEVEL/);
  assert.match(source, /CARGO_PROFILE_RELEASE_LTO/);
  assert.match(source, /CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS/);
  assert.doesNotMatch(source, /CARGO_PROFILE_DEV_OPT_LEVEL/);
});

test('only iOS development selects trace and its source, artifact and Cargo keys differ', t => {
  const { effectiveRust } = require('../ios-dev-ci/rust-device.cjs');
  assert.deepEqual(config.rust.features, []);
  assert.deepEqual(effectiveRust(config, 'release').features, []);
  assert.deepEqual(effectiveRust(config, 'development').features, ['dev-frame-trace', 'dev-render-metrics']);
  assert.throws(() => effectiveRust(config, 'debug'), /Invalid KINESYNC_IOS_BUILD_KIND/);
  for (const feature of ['dev-frame-trace', 'dev-render-metrics']) {
    const bad = structuredClone(config);
    bad.rust.features.push(feature);
    assert.throws(() => effectiveRust(bad, 'release'), /development-only/);
  }
  assert.match(workflow, /KINESYNC_IOS_BUILD_KIND: development/);
  assert.match(release, /KINESYNC_IOS_BUILD_KIND: release/);
  assert.doesNotMatch(release, /KINESYNC_IOS_BUILD_KIND: development/);
  const root = temp(t);
  put(root, 'ExpoLyrics/ios/Podfile.lock');
  const releaseKeys = cacheKeys(root, identity, 'test', 'branch', config, 'release');
  const devKeys = cacheKeys(root, identity, 'test', 'branch', config, 'development');
  for (const key of ['prebuilt', 'rust', 'rustShared', 'derived']) assert.notEqual(releaseKeys[key], devKeys[key], key);
});
