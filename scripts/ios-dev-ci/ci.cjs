// Device-only dev-client CI. No release, dispatch or signing operations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const config = require('./config.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options }).trim();

function digestInputs(root, inputs, ignored = new Set(['target', 'output', 'evidence', '.git', 'node_modules'])) {
  const entries = [];
  function visit(relative) {
    if (relative === path.join('ExpoLyrics', 'modules', 'kinesync-rust-lyrics', 'ios', 'Frameworks')) return;
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) { entries.push([relative, 'missing']); return; }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) { entries.push([relative, 'symlink', fs.readlinkSync(file)]); return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!ignored.has(name)) visit(path.join(relative, name));
      }
    } else { entries.push([relative, stat.mode & 0o777, hash(fs.readFileSync(file))]); }
  }
  inputs.forEach(visit);
  return hash(JSON.stringify(entries));
}
function rustIdentity(root, identity, buildConfig = config) {
  // Entire source directory includes WGSL, not only Rust modules. Include include_str! input.
  const source = digestInputs(root, ['native/lyrics-renderer/Cargo.toml', 'native/lyrics-renderer/Cargo.lock',
    'native/lyrics-renderer/src', 'native/lyrics-renderer/include', 'native/lyrics-renderer/build.rs', 'native/lyrics-renderer/.cargo',
    'native/lyrics-renderer/rust-toolchain.toml', '.cargo', 'rust-toolchain.toml',
    'scripts/ios-dev-ci', '.github/workflows/ios-development-build.yml',
    'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml']);
  return hash(JSON.stringify({ source, rust: buildConfig.rust, xcode: identity.xcode, sdk: identity.sdk, arch: buildConfig.arch, configuration: buildConfig.configuration }));
}
function resolvePaths(workspace, home, temp) {
  for (const input of [workspace, home, temp]) if (!path.isAbsolute(input)) throw new Error('runner paths must be absolute');
  const root = path.resolve(workspace, '..', 'kinesync-ios-dev-cache-v4');
  return {
    root, npm: path.join(root, 'npm'), derived: path.join(root, 'DerivedData'), ccache: path.join(root, 'ccache'),
    rustTarget: path.resolve(workspace, 'native/lyrics-renderer/target'), prebuilt: path.join(root, 'rust-device'),
    pods: path.resolve(workspace, 'ExpoLyrics/ios/Pods'),
    lock: path.resolve(workspace, 'ExpoLyrics/ios/Podfile.lock'),
    cocoapods: path.resolve(home, 'Library/Caches/CocoaPods'),
    evidence: path.resolve(temp, 'kinesync-ios-dev-evidence'), wrapper: path.resolve(temp, 'kinesync-ios-dev-compilers'),
    ipa: path.resolve(workspace, 'ExpoLyrics/ExpoLyrics-development.ipa'),
  };
}
function cacheKeys(root, identity, epoch, branch, buildConfig = config) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(epoch)) throw new Error('cache epoch must be 1..40 alphanumeric, dash or underscore characters');
  const env = hash(JSON.stringify({ identity, configuration: buildConfig.configuration, sdk: buildConfig.sdk, arch: buildConfig.arch })).slice(0, 24);
  const native = digestInputs(root, ['ExpoLyrics/package.json', 'ExpoLyrics/package-lock.json', 'ExpoLyrics/app.json',
    'ExpoLyrics/app.config.js', 'ExpoLyrics/plugins', 'ExpoLyrics/modules', 'ExpoLyrics/ios/Podfile',
    'ExpoLyrics/ios/Podfile.properties.json']);
  const rust = rustIdentity(root, identity, buildConfig);
  const lock = path.join(root, 'ExpoLyrics/ios/Podfile.lock');
  const podHash = fs.existsSync(lock) ? hash(fs.readFileSync(lock)) : null;
  const prefix = `ios-dev-v${buildConfig.schema}-${hash(branch).slice(0, 12)}-${epoch}-${env}`;
  return {
    npm: `${prefix}-npm-${digestInputs(root, ['ExpoLyrics/package-lock.json'])}`,
    lock: `${prefix}-lock-${native}`,
    pods: podHash ? `${prefix}-pods-${podHash}` : '',
    derived: podHash ? `${prefix}-derived-${hash(native + podHash + (buildConfig.rust.enabled ? rust : 'rust-disabled'))}` : '',
    ccache: podHash ? `${prefix}-ccache-${hash(native + podHash)}` : '',
    ccachePrefix: `${prefix}-ccache-`,
    prebuilt: `${prefix}-rust-device-${rust}`,
    rustShared: `${prefix}-cargo-${hash(JSON.stringify({ rust: buildConfig.rust, scripts: digestInputs(root, ['scripts/ios-dev-ci', '.github/workflows/ios-development-build.yml']) }))}`,
    native, rust, podHash,
  };
}
function output(values, file = process.env.GITHUB_OUTPUT) {
  if (!file) throw new Error('GITHUB_OUTPUT missing');
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(String(value))) throw new Error(`multiline output: ${key}`);
    fs.appendFileSync(file, `${key}=${value}\n`);
  }
}
function statePath() { return path.join(process.env.CI_EVIDENCE_DIR, 'state.json'); }
function state() { return json(statePath()); }
function stage(name, command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  const record = { stage: name, started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started, exit_code: result.status, signal: result.signal, error: result.error?.message };
  fs.appendFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'stages.jsonl'), JSON.stringify(record) + '\n');
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message || result.signal || result.status}`);
}
function initialize(env = process.env) {
  const paths = resolvePaths(env.GITHUB_WORKSPACE, env.HOME, env.RUNNER_TEMP);
  const mode = env.CACHE_MODE || 'normal';
  if (!['cold', 'warm', 'normal'].includes(mode)) throw new Error('invalid cache mode');
  const epoch = env.CACHE_EPOCH || 'routine';
  const identity = {
    xcode: run('xcodebuild', ['-version']), sdk: run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']),
    sdkBuild: run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-build-version']),
    developer: run('xcode-select', ['-p']), runner: env.RUNNER_OS, runnerArch: env.RUNNER_ARCH,
    node: process.version, pod: run('pod', ['--version']), ruby: run('ruby', ['--version']),
    ccache: run('ccache', ['--version']).split('\n')[0],
  };
  if (!identity.sdk.startsWith('27.')) throw new Error(`Expected iPhoneOS 27 SDK, got ${identity.sdk}`);
  // Do not delete runner/global resources. Cold means skip managed restores, not OS-cold.
  const preexisting = {};
  for (const [name, dir] of Object.entries(paths)) {
    if (['ipa', 'lock'].includes(name)) continue;
    preexisting[name] = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  }
  if (preexisting.evidence) throw new Error('Refusing to mix evidence from multiple runs. A fresh runner temp directory is required.');
  for (const name of ['npm', 'derived', 'ccache', 'rustTarget', 'prebuilt', 'evidence', 'wrapper', 'cocoapods']) fs.mkdirSync(paths[name], { recursive: true });
  if (mode !== 'normal' && ['npm', 'derived', 'ccache', 'rustTarget', 'prebuilt'].some(name => preexisting[name])) {
    throw new Error('Controlled cold/warm run requires an empty owned cache root before restore on a fresh runner. Refusing to delete existing data.');
  }
  const branch = env.GITHUB_REF || 'local';
  const keys = cacheKeys(env.GITHUB_WORKSPACE, identity, epoch, branch);
  writeJson(path.join(paths.evidence, 'state.json'), { schema: 1, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, ref: branch, mode, epoch, identity, config, paths, preexisting, keys, started_at: new Date().toISOString() });
  const vars = {
    CI_EVIDENCE_DIR: paths.evidence, DERIVED_DATA_PATH: paths.derived, CCACHE_DIR: paths.ccache,
    CCACHE_BASEDIR: env.GITHUB_WORKSPACE, CCACHE_MAXSIZE: '2G', CCACHE_COMPILERCHECK: 'content',
    npm_config_cache: paths.npm, CI: '1', COCOAPODS_DISABLE_STATS: 'true', RCT_NO_LAUNCH_PACKAGER: '1',
    RUSTUP_TOOLCHAIN: config.rust.toolchain, RUSTFLAGS: config.rust.rustflags,
    IPHONEOS_DEPLOYMENT_TARGET: config.rust.iosDeploymentTarget, CARGO_BUILD_JOBS: '2', CARGO_PROFILE_DEV_OPT_LEVEL: String(config.rust.optLevel), CARGO_PROFILE_DEV_DEBUG: String(config.rust.debugInfo),
    RUST_PREBUILT_DIR: paths.prebuilt, RUST_DEVICE_KEY: keys.prebuilt, CARGO_BUILD_TARGET: config.rust.target, CARGO_TARGET_DIR: paths.rustTarget,
  };
  output(vars, env.GITHUB_ENV);
  output({ ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [`path-${key}`, value])),
    'key-npm': keys.npm, 'key-prebuilt': keys.prebuilt, 'rust-shared': keys.rustShared,
    'rust-enabled': String(config.rust.enabled), 'rust-toolchain': config.rust.toolchain, 'rust-target': config.rust.target });
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [name, compiler] of [['clang', 'clang'], ['clang++', 'clang++']]) {
    const binary = run('xcrun', ['--sdk', 'iphoneos', '-f', compiler]);
    const file = path.join(paths.wrapper, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec ccache ${shellQuote(binary)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
}
function keysAfterPrebuild() {
  const current = state();
  const ios = path.join(process.env.GITHUB_WORKSPACE, 'ExpoLyrics/ios');
  const projects = fs.readdirSync(ios).filter(name => name.endsWith('.xcodeproj'));
  if (projects.length !== 1) throw new Error('Expected one generated app project');
  const generatedPlist = path.join(ios, path.basename(projects[0], '.xcodeproj'), 'Info.plist');
  run('python3', [path.join(__dirname, 'validate_ipa.py'), '--plist', generatedPlist,
    path.join(current.paths.evidence, 'generated-promotion.json')]);
  const keys = cacheKeys(process.env.GITHUB_WORKSPACE, current.identity, current.epoch, current.ref);
  const file = path.join(current.paths.evidence, 'keys.json');
  const previous = fs.existsSync(file) ? json(file) : null;
  if (previous?.podHash && keys.podHash !== previous.podHash) throw new Error('Podfile.lock changed after its restore identity was selected');
  writeJson(file, keys);
  if (keys.podHash) fs.copyFileSync(current.paths.lock, path.join(current.paths.evidence, 'Podfile.lock'));
  output({ 'key-lock': keys.lock, 'key-pods': keys.pods, 'key-derived': keys.derived, 'key-ccache': keys.ccache, 'ccache-prefix': keys.ccachePrefix, 'has-lock': String(Boolean(keys.podHash)) });
}
function buildArgs(ios, workspace, scheme, derived, wrapper) {
  return ['-workspace', path.join(ios, workspace), '-scheme', scheme, '-configuration', 'Debug', '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS', '-derivedDataPath', derived,
    'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'SUPPORTED_PLATFORMS=iphoneos',
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_STYLE=Manual', 'DEVELOPMENT_TEAM=',
    'PROVISIONING_PROFILE_SPECIFIER=', 'PROVISIONING_PROFILE=', 'EXPANDED_CODE_SIGN_IDENTITY=',
    'COMPILER_INDEX_STORE_ENABLE=NO', 'ENABLE_DEBUG_DYLIB=NO', 'STRIP_INSTALLED_PRODUCT=NO',
    'LD_GENERATE_MAP_FILE=YES', `LD_MAP_FILE_PATH=${path.join(derived, 'LinkMaps', '$(TARGET_NAME)-$(CURRENT_ARCH).txt')}`, `CC=${path.join(wrapper, 'clang')}`, `CXX=${path.join(wrapper, 'clang++')}`];
}
function build() {
  const current = state();
  const ios = path.join(process.env.GITHUB_WORKSPACE, 'ExpoLyrics/ios');
  const workspaces = fs.readdirSync(ios).filter(name => name.endsWith('.xcworkspace'));
  if (workspaces.length !== 1) throw new Error('Expected one generated workspace');
  const workspace = workspaces[0];
  const list = JSON.parse(run('xcodebuild', ['-workspace', path.join(ios, workspace), '-list', '-json'], { cwd: ios }));
  const project = fs.readdirSync(ios).find(name => name.endsWith('.xcodeproj'));
  const scheme = project && path.basename(project, '.xcodeproj');
  if (!scheme || !list.workspace.schemes.includes(scheme)) throw new Error('Generated app scheme not found');
  const args = buildArgs(ios, workspace, scheme, current.paths.derived, current.paths.wrapper);
  const settings = JSON.parse(run('xcodebuild', [...args, '-showBuildSettings', '-json'], { cwd: ios }));
  const appSettings = settings.find(entry => entry.target === scheme && entry.buildSettings.WRAPPER_EXTENSION === 'app')?.buildSettings;
  if (!appSettings || appSettings.CONFIGURATION !== 'Debug' || appSettings.ARCHS.trim() !== 'arm64') throw new Error('Unexpected app architecture/configuration');
  const app = path.join(appSettings.TARGET_BUILD_DIR, appSettings.FULL_PRODUCT_NAME);
  if (!app.startsWith(current.paths.derived + path.sep) || !app.endsWith('.app')) throw new Error('App must be in owned DerivedData');
  run('ccache', ['--zero-stats']);
  fs.mkdirSync(path.join(current.paths.derived, 'LinkMaps'), { recursive: true });
  stage('xcodebuild', 'xcodebuild', [...args, 'build']);
  // Always build. Never choose an arbitrary old .app or silently archive as a second build.
  if (!fs.existsSync(app)) throw new Error(`Expected built app missing: ${app}`);
  const plist = path.join(app, 'Info.plist');
  const platform = run('/usr/libexec/PlistBuddy', ['-c', 'Print :DTPlatformName', plist]);
  if (platform !== 'iphoneos') throw new Error(`Not an iPhoneOS app: ${platform}`);
  run('python3', [path.join(__dirname, 'validate_ipa.py'), '--plist', plist,
    path.join(current.paths.evidence, 'built-promotion.json')]);
  const architectures = [];
  function inspect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { inspect(file); continue; }
      const fd = fs.openSync(file, 'r');
      const bytes = Buffer.alloc(4);
      fs.readSync(fd, bytes, 0, 4, 0);
      fs.closeSync(fd);
      if (!['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.toString('hex'))) continue;
      const arch = run('xcrun', ['lipo', '-archs', file]).split(/\s+/);
      if (arch.length !== 1 || arch[0] !== 'arm64') throw new Error(`Non-device-arm64 Mach-O: ${file}: ${arch}`);
      architectures.push({ path: path.relative(app, file), architectures: arch });
    }
  }
  inspect(app);
  if (!architectures.length) throw new Error('No Mach-O binaries found');
  if (config.rust.enabled) require('./link-proof.cjs').prove({ app, executable: appSettings.EXECUTABLE_NAME, linkMap: path.join(current.paths.derived, 'LinkMaps', `${scheme}-arm64.txt`), ios, evidence: current.paths.evidence });
  writeJson(path.join(current.paths.evidence, 'built-app.json'), { app, configuration: appSettings.CONFIGURATION, platform, architectures });
  fs.writeFileSync(path.join(current.paths.evidence, 'ccache-stats.txt'), run('ccache', ['--show-stats', '--verbose']) + '\n');
  fs.writeFileSync(path.join(current.paths.evidence, 'app-path.txt'), app + '\n');
}
function summary() {
  const current = state();
  const stagesFile = path.join(current.paths.evidence, 'stages.jsonl');
  const stages = fs.existsSync(stagesFile) ? read(stagesFile).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const cache = JSON.parse(process.env.CACHE_RESULTS || '{}');
  const required = ['npm', 'lock', 'pods', 'derived', 'ccache'];
  const warmPass = current.mode !== 'warm' || (required.every(name => cache[name]?.hit === 'true') && (!config.rust.enabled || cache.rust?.prebuilt_hit === 'true'));
  const coldPass = current.mode !== 'cold' || (required.every(name => !cache[name]?.hit) && (!config.rust.enabled || !cache.rust?.prebuilt_hit));
  const verifyPass = current.mode === 'normal' || (required.every(name => cache[name]?.verified === 'true') && (!config.rust.enabled || cache.rust?.verified === 'true'));
  const result = { ...current, keys: fs.existsSync(path.join(current.paths.evidence, 'keys.json')) ? json(path.join(current.paths.evidence, 'keys.json')) : current.keys,
    stages, cache, job_status_before_summary: process.env.CI_JOB_STATUS, warm_exact_hits_pass: warmPass,
    cold_restores_skipped_pass: coldPass, controlled_cache_publication_pass: verifyPass,
    rust: { enabled: config.rust.enabled, action: config.rust.enabled ? (fs.existsSync(path.join(current.paths.evidence, 'rust-device-manifest.json')) ? (cache.rust?.prebuilt_hit === 'true' ? 'verified-prebuilt' : 'built-and-validated') : 'not-completed') : 'disabled', source_config_hash: current.keys.rust },
    elapsed_before_artifact_upload_ms: Date.now() - Date.parse(current.started_at),
    note: 'No speedup claim without both completed controlled runs. Cold skips managed restores, not runner/OS/tool caches. IPA is unsigned and not LiveContainer launch-tested. Cache/action stage spans include orchestration gaps. Upload/post-job overhead excluded.' };
  writeJson(path.join(current.paths.evidence, 'evidence.json'), result);
  const lines = ['## Device Debug CI evidence', '', `Commit: ${current.sha}`, `Mode: ${current.mode}, epoch: ${current.epoch}`,
    `Xcode: ${current.identity.xcode.replaceAll('\n', ', ')}, iPhoneOS ${current.identity.sdk}, arm64 only`,
    '', '| Cache | Exact restore | Server lookup |', '| --- | --- | --- |',
    ...required.map(name => `| ${name} | ${cache[name]?.hit || 'skipped/miss'} | ${cache[name]?.verified || 'not measured'} |`),
    ...(config.rust.enabled ? [`| Rust prebuilt | ${cache.rust?.prebuilt_hit || 'skipped/miss'} | ${cache.rust?.verified || 'not measured'} |`] : []),
    '', '| Stage | Seconds | Exit |', '| --- | ---: | ---: |', ...stages.map(s => `| ${s.stage} | ${(s.elapsed_ms / 1000).toFixed(3)} | ${s.exit_code ?? s.signal} |`),
    '', 'Rust device build/cache path enabled. Unsigned IPA, not LiveContainer launch-tested.', 'See evidence.json for exact paths, identities, matched keys and timing boundaries.', ''];
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  if (!warmPass || !coldPass || !verifyPass) throw new Error('Controlled cache evidence failed. Inspect evidence.json, do not report a warm-cache pass.');
}
function main(args) {
  switch (args[0]) {
    case 'init': return initialize();
    case 'keys': return keysAfterPrebuild();
    case 'time': return stage(args[1], args[2], args.slice(3));
    case 'mark': return fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, `${args[1]}.start`), String(Date.now()));
    case 'span': {
      const file = path.join(process.env.CI_EVIDENCE_DIR, `${args[1]}.start`);
      if (!fs.existsSync(file)) return console.log(`Stage not started: ${args[1]}`);
      const start = Number(read(file));
      return fs.appendFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'stages.jsonl'), JSON.stringify({ stage: args[1], elapsed_ms: Date.now() - start, exit_code: process.env.CI_JOB_STATUS === 'failure' ? 1 : 0, note: 'Actions stage span includes orchestration overhead' }) + '\n');
    }
    case 'rust-prepare':
      if (!config.rust.enabled) throw new Error('Rust device integration must be enabled');
      if (process.env.RUST_PREBUILT_HIT !== 'true') stage('cargo-device-and-xcframework', 'bash', [path.join(__dirname, 'build-rust-device.sh')]);
      return stage('validate-rust-device-framework', 'node', [path.join(__dirname, 'rust-device.cjs'), 'validate']);
    case 'build': return build();
    case 'package': {
      const current = state();
      const app = read(path.join(current.paths.evidence, 'app-path.txt')).trim();
      stage('repair-executable-modes', 'python3', [path.join(__dirname, 'repair_modes.py'), app, path.join(current.paths.evidence, 'executable-mode-repairs.json')]);
      stage('validate-source-executables', 'python3', [path.join(__dirname, 'validate_ipa.py'), '--app', app, path.join(current.paths.evidence, 'source-executables.json')]);
      return stage('package-and-verify-zip', 'python3', [path.join(__dirname, 'package.py'), read(path.join(current.paths.evidence, 'app-path.txt')).trim(), current.paths.ipa, path.join(current.paths.evidence, 'ipa-manifest.json')]);
    }
    case 'summary': return summary();
    default: throw new Error('Expected init, keys, time, mark, span, assert-rust-disabled, build, package, summary');
  }
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { digestInputs, rustIdentity, resolvePaths, cacheKeys, buildArgs, config };
