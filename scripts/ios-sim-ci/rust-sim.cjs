const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const config = require('./config.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const symbols = ['kr_abi_version', 'kr_create', 'kr_set_fonts', 'kr_copy_layout_json', 'kr_set_track', 'kr_set_anchor', 'kr_resize', 'kr_set_following', 'kr_scroll_by', 'kr_fling', 'kr_hit_test', 'kr_render', 'kr_metrics', 'kr_destroy', 'kr_copy_error'];

function inspect(framework) {
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(framework, 'Info.plist')], { encoding: 'utf8' }));
  if (info.AvailableLibraries?.length !== 1) throw new Error('Expected one simulator-only XCFramework slice');
  const slice = info.AvailableLibraries[0];
  if (slice.SupportedPlatform !== 'ios' || slice.SupportedPlatformVariant !== 'simulator' || JSON.stringify(slice.SupportedArchitectures) !== '["arm64"]') throw new Error('Unexpected non-simulator or non-arm64 XCFramework');
  for (const key of ['LibraryIdentifier', 'LibraryPath', 'HeadersPath']) {
    if (!slice[key] || path.isAbsolute(slice[key]) || slice[key].split('/').includes('..')) throw new Error('Invalid XCFramework path');
  }
  const root = path.join(framework, slice.LibraryIdentifier);
  const library = path.join(root, slice.LibraryPath);
  const header = path.join(root, slice.HeadersPath, 'KineSyncLyrics.h');
  const modulemap = path.join(root, slice.HeadersPath, 'module.modulemap');
  const arch = execFileSync('xcrun', ['lipo', '-archs', library], { encoding: 'utf8' }).trim();
  if (arch !== 'arm64') throw new Error(`Static library has unexpected architecture: ${arch}`);
  if (!fs.readFileSync(modulemap, 'utf8').includes('module KineSyncLyrics')) throw new Error('Missing Swift Clang module map');
  return { slice, library, files: Object.fromEntries([library, header, modulemap, path.join(framework, 'Info.plist')].map(file => [path.relative(framework, file), hash(file)])) };
}

function inspectFonts(app, sourceRoot = path.resolve(__dirname, '../..')) {
  const bundles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'KineSyncLyricsFonts.bundle') bundles.push(file);
        else walk(file);
      }
    }
  }
  walk(app);
  if (bundles.length !== 1) throw new Error('Expected exactly one packaged Rust font bundle');
  const files = {};
  for (const name of ['SF-Pro-Display-Regular.otf', 'SF-Pro-Display-Bold.otf']) {
    const file = path.join(bundles[0], name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Missing packaged Rust font ${name}`);
    const expected = hash(path.join(sourceRoot, 'ExpoLyrics/assets/fonts', name));
    if (hash(file) !== expected) throw new Error(`Packaged Rust font digest mismatch: ${name}`);
    files[path.relative(app, file)] = expected;
  }
  return files;
}

function inventory(library) {
  const rustcArgs = [`+${config.rust.toolchain}`];
  const sysroot = execFileSync('rustc', [...rustcArgs, '--print', 'sysroot'], { encoding: 'utf8' }).trim();
  const version = execFileSync('rustc', [...rustcArgs, '-vV'], { encoding: 'utf8' });
  const host = version.match(/^host: (\S+)$/m)?.[1];
  if (!host || !path.isAbsolute(sysroot)) throw new Error('Invalid pinned Rust sysroot/host');
  const reader = path.join(sysroot, 'lib/rustlib', host, 'bin/llvm-nm');
  return execFileSync(reader, ['--extern-only', '--defined-only', library], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

// The ABI is a constant return, so inspect the exact arm64 instruction stream
// shipped in the cached simulator archive instead of trusting source text.
function abiDisassembly(library) {
  return execFileSync('xcrun', ['llvm-objdump', '-d', '--disassemble-symbols=_kr_abi_version', library], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function matchesAbi(disassembly, abi = config.rust.abi) {
  const expected = `0x${abi.toString(16)}`;
  const start = disassembly.search(/(?:^|\n)(?:[0-9a-f]+\s+)?<_kr_abi_version>:(?=\n)|(?:^|\n)_kr_abi_version:(?=\n)/);
  if (start < 0) return false;
  const rest = disassembly.slice(start + 1);
  const end = rest.search(/\n(?:[0-9a-f]+\s+)?<_[^>]+>:/);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  const immediate = body.match(/mov\s+w0,\s*#(0x[0-9a-f]+|\d+)/i);
  return Boolean(immediate && (immediate[1].toLowerCase() === expected || Number(immediate[1]) === abi) && /\bret\b/.test(body));
}

function verifyLibrary(checked) {
  const nm = inventory(checked.library);
  for (const symbol of symbols) if (!new RegExp(`\\b_${symbol}\\s*$`, 'm').test(nm)) throw new Error(`Static library missing ${symbol}`);
  const disassembly = abiDisassembly(checked.library);
  if (!matchesAbi(disassembly)) throw new Error(`Rust ABI is not ${config.rust.abi} in the simulator archive`);
  return { nm, disassembly };
}

function seal() {
  const root = process.env.RUST_SIM_PREBUILT_DIR;
  const framework = path.join(root, config.rust.framework);
  const checked = inspect(framework);
  const { nm, disassembly } = verifyLibrary(checked);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-sim-nm.txt'), nm);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-sim-abi.txt'), disassembly);
  const manifest = { cache_key: process.env.RUST_SIM_KEY, rust: config.rust, files: checked.files,
    rustc: execFileSync('rustc', [`+${config.rust.toolchain}`, '-vV'], { encoding: 'utf8' }), symbols, abi: config.rust.abi };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function validate() {
  const root = process.env.RUST_SIM_PREBUILT_DIR;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  if (manifest.cache_key !== process.env.RUST_SIM_KEY || JSON.stringify(manifest.rust) !== JSON.stringify(config.rust) || manifest.abi !== config.rust.abi) throw new Error('Cached Rust simulator source/config identity mismatch');
  const checked = inspect(path.join(root, config.rust.framework));
  if (JSON.stringify(checked.files) !== JSON.stringify(manifest.files)) throw new Error('Rust simulator XCFramework content/header integrity mismatch');
  const { nm, disassembly } = verifyLibrary(checked);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-sim-nm.txt'), nm);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-sim-abi.txt'), disassembly);
  const destination = path.join(process.env.GITHUB_WORKSPACE, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/Frameworks');
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(root, config.rust.framework), path.join(destination, config.rust.framework), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(process.env.CI_EVIDENCE_DIR, 'rust-sim-manifest.json'));
}

if (require.main === module) {
  if (process.argv[2] === 'seal') seal();
  else if (process.argv[2] === 'validate') validate();
  else throw new Error('Expected seal or validate');
}
module.exports = { symbols, inspect, inventory, inspectFonts, abiDisassembly, matchesAbi };
