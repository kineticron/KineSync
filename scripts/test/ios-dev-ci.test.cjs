const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { resolvePaths, cacheKeys, rustIdentity, buildArgs, config } = require('../ios-dev-ci/ci.cjs');
const repo = path.resolve(__dirname, '../..');
const cli = path.join(repo, 'scripts/ios-dev-ci/ci.cjs');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/ios-development-build.yml'), 'utf8');
const identity = { xcode: 'Xcode 27.0\nBuild version 27A1', sdk: '27.0', sdkBuild: '27A1', runnerArch: 'ARM64', pod: '1.16.2', ccache: '4.13' };
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
    'native/lyrics-renderer/src/blur.wgsl', 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml']) put(root, file);
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
  for (const file of ['native/lyrics-renderer/src/lib.rs', 'native/lyrics-renderer/src/blur.wgsl', 'native/lyrics-renderer/Cargo.lock', 'native/lyrics-renderer/Cargo.toml', 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml']) {
    put(root, file, 'changed'); assert.notEqual(rustIdentity(root, identity), initial, file); put(root, file);
  }
  for (const [field, value] of [['toolchain', '1.98.0'], ['target', 'other-target'], ['profile', 'release'], ['features', ['new-feature']]]) {
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
  assert.equal(config.rust.enabled, false);
  assert.ok(!/cargo (build|rustc)|create-xcframework|stamp.*version|publish-production/.test(workflow));
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
  assert.equal(report.rust.enabled, false);
  assert.equal(report.stages[0].exit_code, 7);
  const hits = Object.fromEntries(['npm', 'lock', 'pods', 'derived', 'ccache'].map(name => [name, { hit: 'true', verified: 'true' }]));
  result = spawnSync(process.execPath, [cli, 'summary'], { env: { ...env, CACHE_RESULTS: JSON.stringify(hits), CI_JOB_STATUS: 'success' } });
  assert.equal(result.status, 0, result.stderr.toString());
});
test('IPA inner ZIP preserves framework executable modes, symlinks, and bytes', t => {
  const root = temp(t), app = path.join(root, 'App with spaces.app');
  put(app, 'Frameworks/Foo.framework/Foo', 'framework bytes');
  put(app, 'AppExecutable', 'host executable');
  put(app, 'Info.plist', 'metadata');
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
 assert z.read(p+'Frameworks/Foo.framework/Foo') == b'framework bytes'
 assert stat.S_IMODE(z.getinfo(p+'Frameworks/Foo.framework/Foo').external_attr >> 16)==0o755
 assert stat.S_ISLNK(z.getinfo(p+'Frameworks/Foo.framework/Current').external_attr >> 16)
 assert z.read(p+'Frameworks/Foo.framework/Current') == b'Foo'
 print('ok')`, ipa], { encoding: 'utf8' });
  assert.equal(checked.trim(), 'ok');
});

test('restored Podfile.lock cannot silently change between restore and save', t => {
  const root = temp(t); fixture(root);
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(evidence, 'state.json'), JSON.stringify({ identity, epoch: 'pair', ref: 'branch', paths: { evidence, lock: path.join(root, 'ExpoLyrics/ios/Podfile.lock') } }));
  const env = { ...process.env, GITHUB_WORKSPACE: root, CI_EVIDENCE_DIR: evidence, GITHUB_OUTPUT: path.join(root, 'outputs') };
  let result = spawnSync(process.execPath, [cli, 'keys'], { env });
  assert.equal(result.status, 0, result.stderr.toString());
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
  assert.equal(outputs['rust-enabled'], 'false');
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
