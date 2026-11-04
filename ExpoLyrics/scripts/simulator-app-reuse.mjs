// CI-only native shell cache. Never cache a variant's JS or Metro assets.
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const digest = value => sha256(JSON.stringify(value));
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };

// Include names, bytes, modes and symlink targets. Reject links outside the app/cache.
export function treeManifest(root, { allowExternalLinks = false } = {}) {
  const files = {};
  const walk = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = path.join(relative, name), file = path.join(root, rel), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (!allowExternalLinks && !fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error(`Escaping symlink: ${rel}`);
        files[rel] = { link: target };
      } else if (stat.isDirectory()) walk(rel);
      else if (stat.isFile()) files[rel] = { hash: sha256(fs.readFileSync(file)), mode: stat.mode & 0o777 };
      else throw new Error(`Unsupported cache entry: ${rel}`);
    }
  };
  walk('');
  return files;
}

export function mayShareNative(a, b) {
  return Boolean(a?.eligible && b?.eligible && /^[a-f0-9]{64}$/.test(a.key) && a.key === b.key);
}

export async function nativeIdentity(projectRoot, context) {
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    // Reject project overrides which could weaken the trusted strict policy.
    for (const name of fs.readdirSync(projectRoot)) {
      if (/^(fingerprint\.config\.|\.fingerprintignore$)/.test(name)) throw new Error('Project fingerprint overrides require separate builds');
    }
    const { createFingerprintAsync } = require('@expo/fingerprint');
    const fingerprint = await createFingerprintAsync(projectRoot, {
      platforms: ['ios'], preset: 'strict', sourceSkips: 0, hashAlgorithm: 'sha256',
      nativeModuleSourceType: 'files', configPluginSourceType: 'files', silent: true,
      // Keep every autolinking path; normalize only the checkout prefix, never strip overrides.
      fileHookTransform: (source, chunk) => source.type === 'contents' && chunk != null
        ? String(chunk).replaceAll(`${projectRoot}/`, '<project>/') : chunk,
    });
    if (!/^[a-f0-9]{64}$/.test(fingerprint.hash) || !fingerprint.sources?.length ||
        !['expoConfig', 'expoAutolinkingConfig:ios', 'rncoreAutolinkingConfig:ios'].every(id => fingerprint.sources.some(source => source.id === id && source.hash)) ||
        fingerprint.sources.some(source => !source.hash)) throw new Error('Incomplete native fingerprint');
    // Whole lockfile/config/package + local plugins/modules close gaps in native discovery.
    const extra = {};
    for (const name of ['package.json', 'package-lock.json', 'app.json', 'plugins', 'modules', 'widgets', 'assets', 'cng-patches']) {
      const file = path.join(projectRoot, name);
      if (fs.existsSync(file)) extra[name] = fs.statSync(file).isDirectory() ? treeManifest(file) : sha256(fs.readFileSync(file));
    }
    const inputs = { schema: 1, fingerprintVersion: require('@expo/fingerprint/package.json').version, fingerprint: fingerprint.hash, extra, context };
    return { eligible: true, key: digest(inputs), inputs, fingerprint };
  } catch (error) {
    // A missing/failed/unsupported fingerprint never authorizes reuse, even for equal SHAs.
    return { eligible: false, key: null, error: error.message };
  }
}

export function validateNativeCache(directory, identity) {
  if (!identity.eligible) return false;
  try {
    const manifest = readJson(path.join(directory, 'native.json'));
    if (manifest.key !== identity.key || manifest.schema !== 1 ||
        fs.existsSync(path.join(directory, 'payload/KineSync.app/main.jsbundle')) ||
        !fs.statSync(path.join(directory, 'payload/precompiled.json')).isFile() ||
        !fs.statSync(path.join(directory, 'payload/hermesc')).isFile() ||
        !fs.statSync(path.join(directory, 'payload/KineSync.app/KineSync')).isFile()) return false;
    return digest(manifest.files) === digest(treeManifest(path.join(directory, 'payload')));
  } catch { return false; }
}

export function saveNativeCache(directory, identity, app, hermesc, precompiled = {}) {
  // Cache publication is atomic; a failed build/copy leaves no trusted manifest.
  const staging = `${directory}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'payload'), { recursive: true });
  fs.cpSync(app, path.join(staging, 'payload/KineSync.app'), { recursive: true, verbatimSymlinks: true });
  if (fs.existsSync(path.join(staging, 'payload/KineSync.app/main.jsbundle'))) throw new Error('Refusing to cache JS');
  fs.copyFileSync(hermesc, path.join(staging, 'payload/hermesc'));
  fs.chmodSync(path.join(staging, 'payload/hermesc'), 0o755);
  writeJson(path.join(staging, 'payload/precompiled.json'), precompiled);
  writeJson(path.join(staging, 'native.json'), { schema: 1, key: identity.key, files: treeManifest(path.join(staging, 'payload')) });
  fs.rmSync(directory, { recursive: true, force: true });
  fs.renameSync(staging, directory);
}

// Diagnostic snapshot only. Use the verifier's tree scope; embedded provenance is
// checked separately by verifyVariantApp. Never substitute this snapshot for verification.
export function saveInstalledAppEvidence(installed, provenance, outputDir) {
  const files = treeManifest(installed);
  delete files['ci-provenance.json'];
  writeJson(path.join(outputDir, 'installed-app-hashes.json'), { installed, files });
  const expected = provenance.files || {};
  const differences = [];
  for (const name of [...new Set([...Object.keys(expected), ...Object.keys(files)])].sort()) {
    const before = expected[name] ?? null, after = files[name] ?? null;
    if (before?.hash !== after?.hash || before?.mode !== after?.mode || before?.link !== after?.link || !before || !after) {
      differences.push({ path: name, status: !before ? 'added' : !after ? 'missing' : 'changed', expected: before, actual: after });
    }
  }
  writeJson(path.join(outputDir, 'installed-app-diff.json'), { installed, differences });
}

export function verifyVariantApp(app, expected, manifest) {
  const embedded = readJson(path.join(app, 'ci-provenance.json'));
  const provenance = manifest || embedded;
  if (embedded.runtimeId !== provenance.runtimeId || digest(embedded.identity) !== digest(provenance.identity)) throw new Error('Embedded runtime identity mismatch');
  for (const key of ['sourceSha', 'variant', 'harnessSha']) {
    if (!expected[key] || provenance[key] !== expected[key]) throw new Error(`App provenance mismatch: ${key}`);
  }
  if (provenance.runtimeId !== digest(provenance.identity)) throw new Error('Invalid runtime identity');
  if (provenance.identity.sourceSha !== provenance.sourceSha || provenance.identity.variant !== provenance.variant ||
      provenance.identity.harnessSha !== provenance.harnessSha) throw new Error('Inconsistent runtime identity');
  const actual = treeManifest(app);
  delete actual['ci-provenance.json'];
  if (!provenance.files || !provenance.files['main.jsbundle']?.hash) throw new Error('Missing signed app hashes');
  for (const [name, asset] of Object.entries(provenance.metroAssets || {})) {
    if (name === 'main.jsbundle' || asset.hash !== provenance.files[name]?.hash) throw new Error('Metro asset provenance mismatch');
  }
  if (digest(actual) !== digest(provenance.files)) throw new Error('App bundle/assets/native hash mismatch');
  return provenance;
}

export function verifyRuntimeProvenance(provenance, observed) {
  if (observed !== provenance.runtimeId) throw new Error('Missing or mismatched runtime bundle provenance');
  return { runtimeId: observed, sourceSha: provenance.sourceSha, bundleHash: provenance.files['main.jsbundle']?.hash,
    assetsHash: digest(provenance.metroAssets || {}) };
}

// Destination is always replaced, so a removed Metro asset cannot survive a variant swap.
export function materializeVariantResources(nativeApp, app, bundleDirectory) {
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.cpSync(nativeApp, app, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(path.join(app, '_CodeSignature'), { recursive: true, force: true });
  const exported = treeManifest(bundleDirectory);
  if (!exported['main.jsbundle']?.hash || !fs.statSync(path.join(bundleDirectory, 'main.jsbundle')).size) throw new Error('Missing fresh bundle');
  if (fs.existsSync(path.join(app, 'main.jsbundle'))) throw new Error('Native shell contains stale JS');
  for (const relative of Object.keys(exported)) {
    if (relative === 'main.jsbundle') continue;
    const destination = path.join(app, relative);
    if (exported[relative].link || fs.existsSync(destination)) throw new Error(`Metro asset collides with native resource or uses a link: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(bundleDirectory, relative), destination);
  }
  return exported;
}

export async function buildVariantPair(variants, { exportBundle, buildNative, assemble }) {
  const shared = mayShareNative(variants.baseline.identity, variants.candidate.identity);
  let activeBundle;
  try {
    const baselineShell = buildNative(variants.baseline);
    // Baseline's tree is now stable. Only a different candidate tree may build during its export.
    activeBundle = exportBundle(variants.baseline);
    const candidateShell = shared ? baselineShell : buildNative(variants.candidate);
    await activeBundle.finish();
    assemble(variants.baseline, baselineShell, activeBundle);
    activeBundle = exportBundle(variants.candidate);
    await activeBundle.finish();
    assemble(variants.candidate, candidateShell, activeBundle);
  } finally { activeBundle?.stop(); }
  return { shared };
}

export const MAX_NATIVE_CACHE_BYTES = 1024 * 1024 * 1024;
export const MAX_COMPILER_CACHE_BYTES = 512 * 1024 * 1024;
export function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) return Buffer.byteLength(fs.readlinkSync(directory));
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(directory).reduce((total, name) => total + directoryBytes(path.join(directory, name)), 0);
}

// Per-native identity only: changing the other variant cannot invalidate this entry.
export function nativeCacheToken(identity) {
  return identity?.eligible && /^[a-f0-9]{64}$/.test(identity.key) ? identity.key : null;
}

export function nativeCacheState(cacheRoot, identity, previouslyValid = false, limit = MAX_NATIVE_CACHE_BYTES) {
  const token = nativeCacheToken(identity);
  if (!token) return { eligible: false, valid: false, bytes: 0, save: false, reason: 'fingerprint ineligible' };
  const directory = path.join(cacheRoot, token);
  const valid = validateNativeCache(directory, identity);
  const bytes = directoryBytes(directory);
  return { eligible: true, valid, bytes, save: valid && !previouslyValid && bytes <= limit,
    reason: !valid ? 'missing or invalid' : previouslyValid ? 'verified hit; no new snapshot' : bytes > limit ? 'entry exceeds byte cap' : 'new verified entry' };
}

export function provenanceEntry(runtimeId, entry) {
  if (!/^[a-f0-9]{64}$/.test(runtimeId) || !path.isAbsolute(entry)) throw new Error('Invalid provenance entry inputs');
  return `console.info(${JSON.stringify(`[KINESYNC_PROVENANCE] ${runtimeId}`)});\nrequire(${JSON.stringify(entry)});\n`;
}

// Follow the app target's effective Pods-generated setting, including source-built Hermes.
// Do not guess a compiler from npm or choose any existing binary from another VM train.
export function resolveHermesCompiler(settings, iosDirectory) {
  const variables = { ...settings, PODS_ROOT: settings.PODS_ROOT || path.join(iosDirectory, 'Pods') };
  let compiler = settings.HERMES_CLI_PATH || '$(PODS_ROOT)/hermes-engine/destroot/bin/hermesc';
  for (let pass = 0; pass < 10 && /\$[({]/.test(compiler); pass++) {
    compiler = compiler.replace(/\$\(([^)]+)\)|\$\{([^}]+)\}/g, (match, a, b) => variables[a || b] ?? match);
  }
  if (!path.isAbsolute(compiler) || /\$[({]/.test(compiler)) throw new Error('Unresolved effective HERMES_CLI_PATH from app build settings');
  try {
    if (!fs.statSync(compiler).isFile()) throw new Error('not a file');
    fs.accessSync(compiler, fs.constants.X_OK);
  } catch { throw new Error(`Matching Hermes compiler missing or not executable at effective HERMES_CLI_PATH: ${compiler}`); }
  return fs.realpathSync(compiler);
}

export function hermesCompileArguments(input, output) {
  return ['-emit-binary', '-max-diagnostic-width=80', '-O', '-w', '-out', output, input];
}
