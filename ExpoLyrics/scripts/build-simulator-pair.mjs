// Build at most one native shell when fingerprints agree; always export each exact variant.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSimulatorApp } from './build-simulator-app.mjs';
import { mayShareNative, validateNativeCache, saveNativeCache, treeManifest, digest, readJson, writeJson, verifyVariantApp, materializeVariantResources, buildVariantPair, provenanceEntry, resolveHermesCompiler, hermesCompileArguments } from './simulator-app-reuse.mjs';
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
    // Commit tree is unmodified source; the separately hashed trusted overlay and flags complete its identity.
    sourceTree: capture('git', ['rev-parse', 'HEAD^{tree}'], v.directory), harness: context.harness, env: context.env };
  const runtimeId = digest(identity);
  const entry = capture(process.execPath, ['-e', "require('expo/scripts/resolveAppEntry')", v.project, 'ios', 'absolute'], v.project);
  if (!path.isAbsolute(entry) || !fs.statSync(entry).isFile()) throw new Error('Invalid resolved bundle entry');
  const wrapper = path.join(v.project, '.expo/ci-provenance-entry.js');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, provenanceEntry(runtimeId, entry));
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
  // Complete native generation before Metro may crawl this source tree.
  timed(`${v.variant}:prebuild`, () => run(process.execPath, ['node_modules/expo/bin/cli', 'prebuild', '--clean', '--platform', 'ios', '--no-install'], v.project));
  const ios = path.join(v.project, 'ios');
  const podfile = fs.readFileSync(path.join(ios, 'Podfile'), 'utf8');
  if (!podfile.includes(':ccache_enabled => ccache_enabled?(podfile_properties)') || !podfile.includes("return ENV['USE_CCACHE'] == '1'")) throw new Error('Installed template no longer passes ccache_enabled=true to RN');
  // No persisted Pods or DerivedData snapshots: a native miss resolves Pods into this fresh source tree.
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
  const built = timed(`${v.variant}:native-build`, () => buildSimulatorApp({ iosDirectory: ios,
    derivedDataPath: path.join(nativeWork, `${v.variant}-derived`), nativeOnly: true, returnBuildDetails: true }));
  const app = built.appPath;
  const hermesc = resolveHermesCompiler(built.buildSettings, ios);
  precompiled.hermesCompiler = { effectiveSetting: built.buildSettings.HERMES_CLI_PATH || null, resolved: hermesc };
  writeJson(path.join(stateDir, `${v.variant}-precompiled.json`), precompiled);
  saveNativeCache(directory, v.identity, app, hermesc, precompiled);
  return { directory, cacheHit: false };
}

function assemble(v, shell, bundle) {
  const payload = path.join(shell.directory, 'payload');
  const app = path.join(output, `${v.variant}/KineSync.app`);
  const exported = materializeVariantResources(path.join(payload, 'KineSync.app'), app, bundle.destination);
  timed(`${v.variant}:hermes`, () => run(path.join(payload, 'hermesc'), hermesCompileArguments(path.join(bundle.destination, 'main.jsbundle'), path.join(app, 'main.jsbundle')), v.project));
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
