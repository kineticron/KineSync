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
    if viewModel.hasEmbeddedBundle {
      DispatchQueue.main.async { [weak self] in
        self?.viewModel.loadLocalBundle()
      }
    }
  }`;

function patch(source) {
  if (source.includes(MARKER)) return source;
  if (!source.includes(EXPECTED)) {
    throw new Error('expo-dev-launcher DevLauncherViewController viewDidLoad context mismatch. Refusing to patch.');
  }
  const next = source.replace(EXPECTED, PATCHED);
  if (!next.includes(MARKER) || !next.includes('viewModel.loadLocalBundle()')) throw new Error('expo-dev-launcher patch did not apply');
  return next;
}

if (require.main === module) {
  const root = process.env.GITHUB_WORKSPACE || path.resolve(__dirname, '../..');
  const file = path.resolve(process.env.DEV_LAUNCHER_CONTROLLER || path.join(root, 'ExpoLyrics/node_modules/expo-dev-launcher/ios/SwiftUI/DevLauncherViewController.swift'));
  const source = fs.readFileSync(file, 'utf8');
  const next = patch(source);
  if (next !== source) fs.writeFileSync(file, next);
  console.log(`Patched ${file}`);
}

module.exports = { EXPECTED, MARKER, PATCHED, patch };
