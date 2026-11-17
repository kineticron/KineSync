// CI-only fix for expo-dev-launcher 58.0.12. The launcher opens its menu on
// first launch even when an embedded bundle is present. The simulator build
// auto-loads that bundle so the smoke test can prove app rendering without Metro.
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED = `  public override func viewDidLoad() {
    super.viewDidLoad()
    addHostingController()
  }`;
const MARKER = 'KineSync simulator CI: load the embedded bundle without a launcher tap.';
const PATCHED = `  public override func viewDidLoad() {
    super.viewDidLoad()
    addHostingController()
    // ${MARKER}
    #if targetEnvironment(simulator)
    if viewModel.hasEmbeddedBundle {
      DispatchQueue.main.async { [weak self] in
        self?.viewModel.loadLocalBundle()
      }
    }
    #endif
  }`;

function patch(source) {
  if (source.includes(MARKER)) {
    if (source.split(PATCHED).length !== 2) throw new Error('Patched launcher context mismatch');
    return source;
  }
  if (source.split(EXPECTED).length !== 2) {
    throw new Error('expo-dev-launcher DevLauncherViewController viewDidLoad context mismatch. Refusing to patch.');
  }
  const next = source.replace(EXPECTED, PATCHED);
  if (!next.includes(MARKER) || !next.includes('viewModel.loadLocalBundle()')) throw new Error('expo-dev-launcher patch did not apply');
  return next;
}

function assertVersion(installed, locked) {
  if (installed !== '58.0.12' || locked !== '58.0.12') throw new Error('Simulator launcher patch requires installed and locked expo-dev-launcher 58.0.12');
}

if (require.main === module) {
  const root = process.env.GITHUB_WORKSPACE || path.resolve(__dirname, '../..');
  const packageRoot = path.join(root, 'ExpoLyrics/node_modules/expo-dev-launcher');
  const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'ExpoLyrics/package-lock.json'), 'utf8'));
  assertVersion(installed.version, lock.packages?.['node_modules/expo-dev-launcher']?.version);
  const file = path.join(packageRoot, 'ios/SwiftUI/DevLauncherViewController.swift');
  const source = fs.readFileSync(file, 'utf8');
  const next = patch(source);
  if (next !== source) fs.writeFileSync(file, next);
  console.log(`Patched ${file}`);
}

module.exports = { EXPECTED, MARKER, PATCHED, patch, assertVersion };
