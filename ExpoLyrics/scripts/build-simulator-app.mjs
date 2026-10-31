// Build Debug iOS Simulator .app bundle using actual xcodebuild
// Dynamically discovers workspace and scheme
// Ensures EXPO_PUBLIC_SIMULATOR_TEST=1 is exposed in shell env, .env.local, and xcodebuild settings

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const expoLyricsDir = path.resolve(__dirname, '..');
const iosDir = path.join(expoLyricsDir, 'ios');

function findApp(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name.endsWith('.app')) return full;
      const nested = findApp(full);
      if (nested) return nested;
    }
  }
  return null;
}

export function buildSimulatorApp(options = {}) {
  const derivedDataPath = options.derivedDataPath || process.env.DERIVED_DATA_PATH || path.join(iosDir, 'build');

  // Set EXPO_PUBLIC_SIMULATOR_TEST in environment and write .env.local
  process.env.EXPO_PUBLIC_SIMULATOR_TEST = '1';
  const envLocalPath = path.join(expoLyricsDir, '.env.local');
  fs.writeFileSync(envLocalPath, 'EXPO_PUBLIC_SIMULATOR_TEST=1\n', 'utf8');
  console.log('[BUILD] Wrote EXPO_PUBLIC_SIMULATOR_TEST=1 to .env.local');

  if (!fs.existsSync(iosDir)) {
    throw new Error(`iOS directory not found at ${iosDir}. Run npx expo prebuild first.`);
  }

  const ws = fs.readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'));
  if (!ws) {
    throw new Error(`No .xcworkspace found in ${iosDir}`);
  }
  const workspacePath = path.join(iosDir, ws);

  console.log(`[BUILD] Discovering schemes for workspace: ${ws}...`);
  const listJson = execFileSync('xcodebuild', ['-workspace', workspacePath, '-list', '-json'], {
    encoding: 'utf8',
    cwd: iosDir,
  });
  const listData = JSON.parse(listJson);
  const schemes = listData.workspace?.schemes || [];
  const scheme = schemes.find((s) => !String(s).startsWith('Pods')) || schemes[0];

  if (!scheme) {
    throw new Error(`No valid build scheme found in workspace ${ws}`);
  }
  console.log(`[BUILD] Selected scheme: ${scheme}`);

  const signing = [
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_STYLE=Manual',
    'DEVELOPMENT_TEAM=',
    'PROVISIONING_PROFILE_SPECIFIER=',
    'PROVISIONING_PROFILE=',
    'EXPANDED_CODE_SIGN_IDENTITY=',
    'COMPILER_INDEX_STORE_ENABLE=NO',
  ];

  const ccache = process.env.KINESYNC_USE_CCACHE === '1' && process.env.KINESYNC_CC_WRAPPER
    ? [`CC=${process.env.KINESYNC_CC_WRAPPER}`]
    : [];

  const args = [
    '-workspace', workspacePath,
    '-scheme', scheme,
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', derivedDataPath,
    'FORCE_BUNDLING=1',
    'EXPO_PUBLIC_SIMULATOR_TEST=1',
    ...signing,
    ...ccache,
    'build',
  ];

  console.log('[BUILD] Invoking actual xcodebuild for Debug iphonesimulator...');
  execFileSync('xcodebuild', args, {
    stdio: 'inherit',
    cwd: iosDir,
    env: {
      ...process.env,
      EXPO_PUBLIC_SIMULATOR_TEST: '1',
    },
  });

  const productsDir = path.join(derivedDataPath, 'Build', 'Products');
  const appPath = findApp(productsDir);
  if (!appPath) {
    throw new Error(`Failed to locate built .app bundle in ${productsDir}`);
  }
  console.log(`[BUILD] Located built simulator app: ${appPath}`);

  // Ad-hoc codesign app bundle for simulator execution
  console.log('[BUILD] Ad-hoc codesigning app bundle...');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  const builtAppRecord = path.join(iosDir, '.built_app_path');
  fs.writeFileSync(builtAppRecord, appPath, 'utf8');
  console.log(`[BUILD] Successfully built and codesigned app bundle at: ${appPath}`);

  return appPath;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const derivedIndex = process.argv.indexOf('--derived-data-path');
  const derivedDataPath = derivedIndex >= 0 ? process.argv[derivedIndex + 1] : undefined;
  buildSimulatorApp({ derivedDataPath });
}
