// CI-only native shell cache. Never cache a variant's JS or Metro assets.
import fs from 'node:fs';
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
    activeBundle = exportBundle(variants.baseline);
    const baselineShell = buildNative(variants.baseline);
    await activeBundle.finish();
    assemble(variants.baseline, baselineShell, activeBundle);
    activeBundle = exportBundle(variants.candidate);
    const candidateShell = shared ? baselineShell : buildNative(variants.candidate);
    await activeBundle.finish();
    assemble(variants.candidate, candidateShell, activeBundle);
  } finally { activeBundle?.stop(); }
  return { shared };
}
