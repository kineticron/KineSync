// Build at most one native shell when fingerprints agree; always export each exact variant.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSimulatorApp } from './build-simulator-app.mjs';
import { mayShareNative, validateNativeCache, saveNativeCache, treeManifest, digest, readJson, writeJson, verifyVariantApp, materializeVariantResources, buildVariantPair } from './simulator-app-reuse.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stateDir = path.join(root, 'ExpoLyrics/.expo/pair');
const { variants, context } = readJson(path.join(stateDir, 'plan.json'));
for (const [name, value] of Object.entries(context.env)) {
  // This is a runtime build contract, not Expo's JS inlining syntax.
  if (process.env[name] !== value) throw new Error(`Harness environment mismatch: ${name}`);
}
const cache = path.resolve(root, '../kinesync-native-cache');
const nativeWork = path.resolve(root, '../kinesync-native-work');
const output = path.join(stateDir, 'apps');
fs.mkdirSync(output, { recursive: true });
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const capture = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60000 }).trim();
const evidence = { shared: mayShareNative(variants.baseline.identity, variants.candidate.identity), context, variants: {}, timings: [] };
function timed(label, action) {
  const started = Date.now();
  try { return action(); } finally { evidence.timings.push({ label, started, seconds: (Date.now() - started) / 1000 }); }
}
function exportFresh(v) {
  const destination = path.join(stateDir, `bundle-${v.variant}`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const identity = { sourceSha: v.sourceSha, harnessSha: v.harnessSha, variant: v.variant, nativeKey: v.identity.key,
    // Exact overlaid tree and build flags are bound to the runtime marker.
    sourceTree: capture('git', ['rev-parse', 'HEAD^{tree}'], v.directory), harness: context.harness, env: context.env };
  const runtimeId = digest(identity);
  const entry = capture(process.execPath, ['-e', "require('expo/scripts/resolveAppEntry')", v.project, 'ios', 'absolute'], v.project);
  if (!path.isAbsolute(entry) || !fs.statSync(entry).isFile()) throw new Error('Invalid resolved bundle entry');
  const wrapper = path.join(v.project, '.expo/ci-provenance-entry.js');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, `console.info(${JSON.stringify(`[KINESYNC_PROVENANCE] ${runtimeId}`)});\nrequire(${JSON.stringify(entry)});\n`);
  const log = fs.openSync(path.join(stateDir, `${v.variant}-bundle.log`), 'w');
  const timingFile = path.join(stateDir, `${v.variant}-bundle-timing.json`);
  fs.rmSync(timingFile, { force: true });
  // Export in a new Metro process and new destination, never copy a cache's JS/assets.
  const child = spawn(process.execPath, [path.join(root, 'ExpoLyrics/scripts/export-simulator-bundle.mjs'),
    v.project, wrapper, destination, timingFile],
  { cwd: v.project, env: process.env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  // Catch immediately while the synchronous native build owns this process.
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve(code === 0 ? {} : { error: new Error(`Fresh ${v.variant} export failed: ${code ?? signal}`) }));
  });
  return { destination, identity, runtimeId, async finish() {
    const result = await completion;
    if (result.error) throw result.error;
    evidence.timings.push({ label: `${v.variant}:fresh-export`, ...readJson(timingFile) });
    if (!fs.statSync(path.join(destination, 'main.jsbundle')).size) throw new Error('Missing fresh bundle');
  }, stop() { child.kill('SIGTERM'); } };
}

function nativeShell(v) {
  const key = v.identity.key || `unshared-${v.variant}-${v.sourceSha}`;
  const directory = path.join(cache, key);
  if (validateNativeCache(directory, v.identity)) {
    console.log(`[NATIVE] ${v.variant}: verified cached native shell ${key}`);
    return { directory, cacheHit: true };
  }
  console.log(`[NATIVE] ${v.variant}: cache miss, invalid cache, or ineligible fingerprint; building separately`);
  fs.rmSync(directory, { recursive: true, force: true });
  // Prebuild first; restore Pods afterwards so --clean cannot erase a restored cache.
  timed(`${v.variant}:prebuild`, () => run(process.execPath, ['node_modules/expo/bin/cli', 'prebuild', '--clean', '--platform', 'ios', '--no-install'], v.project));
  const ios = path.join(v.project, 'ios');
  const podfile = fs.readFileSync(path.join(ios, 'Podfile'), 'utf8');
  if (!podfile.includes(':ccache_enabled => ccache_enabled?(podfile_properties)') || !podfile.includes("return ENV['USE_CCACHE'] == '1'")) throw new Error('Installed template no longer passes ccache_enabled=true to RN');
  const podCache = path.join(nativeWork, `${v.variant}-pods`);
  const podKey = digest({ native: key, project: v.project, toolchain: context.toolchain, podfile });
  const podStamp = path.join(podCache, 'stamp.json');
  try {
    const stamp = readJson(podStamp);
    if (stamp.key === podKey && digest(stamp.files) === digest(treeManifest(path.join(podCache, 'payload'), { allowExternalLinks: true }))) {
      fs.cpSync(path.join(podCache, 'payload/Pods'), path.join(ios, 'Pods'), { recursive: true, verbatimSymlinks: true });
      fs.copyFileSync(path.join(podCache, 'payload/Podfile.lock'), path.join(ios, 'Podfile.lock'));
    }
  } catch { console.log('[PODS] No valid exact Pods snapshot; using pod install'); }
  // Even restored Pods always go through dependency resolution; never trust a cached installation alone.
  const podLog = path.join(stateDir, `${v.variant}-pods.log`);
  timed(`${v.variant}:pods`, () => {
    const fd = fs.openSync(podLog, 'w');
    try { execFileSync('pod', ['install'], { cwd: ios, env: process.env, stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
  });
  const podsProject = fs.readFileSync(path.join(ios, 'Pods/Pods.xcodeproj/project.pbxproj'), 'utf8');
  if (!podsProject.includes('ccache-clang.sh') || !podsProject.includes('ccache-clang++.sh')) throw new Error('RN post_install did not activate C/C++ ccache settings');
  const compilerCheck = capture('ccache', ['--get-config', 'compiler_check']);
  if (compilerCheck !== 'content') throw new Error('ccache must check compiler content');
  const properties = readJson(path.join(ios, 'Podfile.properties.json'));
  const lock = fs.readFileSync(path.join(ios, 'Podfile.lock'), 'utf8');
  const precompiled = { reactNative: readJson(path.join(v.project, 'node_modules/react-native/package.json')).version,
    properties, ccacheEnabled: true, compilerCheck, rnCorePrebuilt: /React-Core-prebuilt/.test(lock), rnDependencies: /ReactNativeDependencies/.test(lock),
    podsLockHash: digest(lock), note: 'Installed template defaults retained; source fallback is supported. See Pods log and lock.' };
  writeJson(path.join(stateDir, `${v.variant}-precompiled.json`), precompiled);
  // Update only after successful dependency installation. Full integrity check rejects truncated/stale Pods.
  fs.rmSync(podCache, { recursive: true, force: true });
  fs.mkdirSync(path.join(podCache, 'payload'), { recursive: true });
  fs.cpSync(path.join(ios, 'Pods'), path.join(podCache, 'payload/Pods'), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(ios, 'Podfile.lock'), path.join(podCache, 'payload/Podfile.lock'));
  writeJson(podStamp, { key: podKey, files: treeManifest(path.join(podCache, 'payload'), { allowExternalLinks: true }) });
  const app = timed(`${v.variant}:native-build`, () => buildSimulatorApp({ iosDirectory: ios,
    derivedDataPath: path.join(nativeWork, `${v.variant}-derived`), nativeOnly: true }));
  const hermesc = path.join(ios, 'Pods/hermes-engine/destroot/bin/hermesc');
  // Use the compiler delivered alongside the actual Pods VM, never a potentially different npm compiler.
  saveNativeCache(directory, v.identity, app, hermesc, precompiled);
  return { directory, cacheHit: false };
}

function assemble(v, shell, bundle) {
  const payload = path.join(shell.directory, 'payload');
  const app = path.join(output, `${v.variant}/KineSync.app`);
  const exported = materializeVariantResources(path.join(payload, 'KineSync.app'), app, bundle.destination);
  timed(`${v.variant}:hermes`, () => run(path.join(payload, 'hermesc'), ['-emit-binary', '-max-diagnostic-width=80', '-O',
    '-out', path.join(app, 'main.jsbundle'), path.join(bundle.destination, 'main.jsbundle')], v.project));
  if (!fs.statSync(path.join(app, 'main.jsbundle')).size) throw new Error('Missing fresh Hermes bundle');
  if (capture('xcrun', ['lipo', '-archs', path.join(app, 'KineSync')]) !== 'arm64' ||
      !/platform\s+IOSSIMULATOR\b/.test(capture('xcrun', ['vtool', '-show-build', path.join(app, 'KineSync')]))) throw new Error('Invalid cached native executable');
  // Embed identity first, sign, then hash the final signed executable and resources into an external manifest.
  const provenance = { schema: 1, sourceSha: v.sourceSha, harnessSha: v.harnessSha, variant: v.variant,
    identity: bundle.identity, runtimeId: bundle.runtimeId, nativeKey: v.identity.key,
    nativeCacheHit: shell.cacheHit, precompiled: readJson(path.join(payload, 'precompiled.json')),
    metroAssets: Object.fromEntries(Object.entries(exported).filter(([name]) => name !== 'main.jsbundle')) };
  writeJson(path.join(app, 'ci-provenance.json'), provenance);
  run('codesign', ['--force', '--deep', '--sign', '-', app], v.project);
  provenance.files = treeManifest(app);
  delete provenance.files['ci-provenance.json'];
  verifyVariantApp(app, v, provenance);
  run('tar', ['-czf', path.join(output, `${v.variant}.tar.gz`), '-C', path.dirname(app), 'KineSync.app'], v.project);
  evidence.variants[v.variant] = { sourceSha: v.sourceSha, harnessSha: v.harnessSha, nativeKey: v.identity.key,
    runtimeId: bundle.runtimeId, nativeCacheHit: shell.cacheHit, bundleHash: provenance.files['main.jsbundle'].hash,
    assetsHash: digest(provenance.metroAssets), precompiled: provenance.precompiled };
  writeJson(path.join(output, `${v.variant}-provenance.json`), provenance);
}

try {
  await buildVariantPair(variants, { exportBundle: exportFresh,
    buildNative: v => timed(`${v.variant}:native-shell`, () => nativeShell(v)), assemble });
} finally {
  writeJson(path.join(stateDir, 'build-evidence.json'), evidence);
}
