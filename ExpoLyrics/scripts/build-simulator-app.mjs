// Build Debug iOS Simulator .app bundle using actual xcodebuild
// Dynamically discovers workspace and verifies application scheme via showBuildSettings
// Ensures EXPO_PUBLIC_SIMULATOR_TEST=1 is exposed in shell env, .env.local, and xcodebuild settings

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const expoLyricsDir = path.resolve(__dirname, '..');
const iosDir = path.join(expoLyricsDir, 'ios');

export function parseXcodebuildJson(output) {
  const trimmed = String(output || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const startBracket = trimmed.indexOf('[');
    const startBrace = trimmed.indexOf('{');
    let startIdx = -1;
    if (startBracket !== -1 && startBrace !== -1) {
      startIdx = Math.min(startBracket, startBrace);
    } else if (startBracket !== -1) {
      startIdx = startBracket;
    } else {
      startIdx = startBrace;
    }

    if (startIdx !== -1) {
      const endBracket = trimmed.lastIndexOf(']');
      const endBrace = trimmed.lastIndexOf('}');
      const endIdx = Math.max(endBracket, endBrace);
      if (endIdx > startIdx) {
        return JSON.parse(trimmed.slice(startIdx, endIdx + 1));
      }
    }
    throw new Error(`Failed to parse xcodebuild JSON output: ${trimmed.slice(0, 300)}`);
  }
}

function applicationIdentity(application) {
  const settings = application.buildSettings;
  // Extension schemes can expose the host app as a dependency. Compare the app,
  // not the scheme that happened to expose it. Keep distinct projects/products separate.
  return JSON.stringify([
    settings.PROJECT_FILE_PATH || settings.PROJECT_NAME || '',
    application.target,
    settings.PRODUCT_BUNDLE_IDENTIFIER || '',
    settings.FULL_PRODUCT_NAME || '',
    settings.TARGET_BUILD_DIR ? path.normalize(settings.TARGET_BUILD_DIR) : '',
  ]);
}

export function findApplicationTarget(targetList) {
  if (!targetList) return null;
  const targets = Array.isArray(targetList)
    ? targetList
    : (targetList.targets || [targetList]);

  const matches = [];
  for (const entry of targets) {
    const settings = entry?.buildSettings || entry;
    if (!settings || typeof settings !== 'object') continue;

    const wrapperExt = settings.WRAPPER_EXTENSION;
    const productType = settings.PRODUCT_TYPE;

    const isAppWrapper = wrapperExt === 'app';
    const isAppProductType = productType === 'com.apple.product-type.application';

    if (isAppWrapper && isAppProductType) {
      matches.push({
        target: entry.target || settings.TARGET_NAME || settings.PRODUCT_NAME || '',
        action: entry.action || 'build',
        buildSettings: settings,
      });
    }
  }
  const identities = new Map(matches.map(app => [applicationIdentity(app), app]));
  if (identities.size > 1) throw new Error('Ambiguous application targets within scheme');
  return identities.values().next().value || null;
}

export function discoverApplicationScheme(workspacePath, options = {}) {
  const {
    applicationScheme = 'KineSync',
    configuration = 'Debug',
    sdk = 'iphonesimulator',
    destination = 'generic/platform=iOS Simulator',
    derivedDataPath,
    cwd = path.dirname(workspacePath),
    execCommand = execFileSync,
  } = options;

  const wsName = path.basename(workspacePath);
  console.log(`[BUILD] Discovering schemes for workspace: ${wsName}...`);

  const listRaw = execCommand('xcodebuild', ['-workspace', workspacePath, '-list', '-json'], {
    encoding: 'utf8',
    cwd,
  });
  const listData = parseXcodebuildJson(listRaw);
  const schemes = listData.workspace?.schemes || [];

  if (!Array.isArray(schemes) || schemes.length === 0) {
    throw new Error(`No build schemes found in workspace ${wsName}`);
  }

  const matchingSchemes = [];

  for (const scheme of schemes) {
    const showArgs = [
      '-workspace', workspacePath,
      '-scheme', String(scheme),
      '-configuration', configuration,
      '-sdk', sdk,
      '-destination', destination,
    ];
    if (derivedDataPath) {
      showArgs.push('-derivedDataPath', derivedDataPath);
    }
    showArgs.push('-showBuildSettings', '-json');

    try {
      const settingsRaw = execCommand('xcodebuild', showArgs, {
        encoding: 'utf8',
        cwd,
      });
      const parsedSettings = parseXcodebuildJson(settingsRaw);
      const appTarget = findApplicationTarget(parsedSettings);
      if (appTarget) {
        matchingSchemes.push({
          scheme: String(scheme),
          target: appTarget.target,
          buildSettings: appTarget.buildSettings,
        });
      }
    } catch (err) {
      // Scheme may not support simulator destination or build settings query (e.g. internal pods or utility targets)
      if (err.message.includes('Ambiguous application targets')) throw err;
      console.log(`[BUILD] Scheme ${scheme} showBuildSettings skipped: ${err.message}`);
    }
  }

  if (matchingSchemes.length === 0) {
    throw new Error(
      `No application scheme found in workspace ${wsName}. Evaluated schemes: [${schemes.join(', ')}]. ` +
      'None produced WRAPPER_EXTENSION=app and PRODUCT_TYPE application.'
    );
  }

  const identities = new Set(matchingSchemes.map(applicationIdentity));
  if (identities.size > 1) {
    const ambiguousNames = matchingSchemes.map((m) => `${m.scheme} (target: ${m.target})`).join(', ');
    throw new Error(
      `Ambiguous application schemes found in workspace ${wsName}: ${ambiguousNames}. ` +
      'Expected exactly one application target/product identity.'
    );
  }

  // The intended host scheme must exist even when widget/utility schemes expose it.
  const selected = matchingSchemes.find(app => app.scheme === applicationScheme);
  if (!selected) throw new Error(`Intended application scheme ${applicationScheme} was not found among application schemes: ${matchingSchemes.map(app => app.scheme).join(', ')}`);
  console.log(`[BUILD] Selected application scheme: ${selected.scheme} (target: ${selected.target})`);
  return selected;
}

export function buildSimulatorApp(options = {}) {
  const derivedDataPath = options.derivedDataPath || process.env.DERIVED_DATA_PATH || path.join(iosDir, 'build');
  const iosDirectory = options.iosDirectory || iosDir;
  const appDirectory = options.appDirectory || expoLyricsDir;
  const execCommand = options.execCommand || execFileSync;

  // Set EXPO_PUBLIC_SIMULATOR_TEST in environment and write .env.local
  process.env.EXPO_PUBLIC_SIMULATOR_TEST = '1';
  const envLocalPath = path.join(appDirectory, '.env.local');
  fs.writeFileSync(envLocalPath, 'EXPO_PUBLIC_SIMULATOR_TEST=1\n', 'utf8');
  console.log('[BUILD] Wrote EXPO_PUBLIC_SIMULATOR_TEST=1 to .env.local');

  if (!fs.existsSync(iosDirectory)) {
    throw new Error(`iOS directory not found at ${iosDirectory}. Run npx expo prebuild first.`);
  }

  const ws = fs.readdirSync(iosDirectory).find((f) => f.endsWith('.xcworkspace'));
  if (!ws) {
    throw new Error(`No .xcworkspace found in ${iosDirectory}`);
  }
  const workspacePath = path.join(iosDirectory, ws);

  const discovered = discoverApplicationScheme(workspacePath, {
    derivedDataPath,
    cwd: iosDirectory,
    execCommand,
  });

  const scheme = discovered.scheme;
  const targetBuildDir = discovered.buildSettings?.TARGET_BUILD_DIR;
  const fullProductName = discovered.buildSettings?.FULL_PRODUCT_NAME;

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

  console.log(`[BUILD] Invoking actual xcodebuild for ${scheme} (Debug iphonesimulator)...`);
  execCommand('xcodebuild', args, {
    stdio: 'inherit',
    cwd: iosDirectory,
    env: {
      ...process.env,
      EXPO_PUBLIC_SIMULATOR_TEST: '1',
    },
  });

  if (!targetBuildDir || !fullProductName || path.basename(fullProductName) !== fullProductName || !fullProductName.endsWith('.app')) throw new Error('Missing exact application product path');
  const appPath = path.join(targetBuildDir, fullProductName);
  if (!fs.existsSync(appPath)) throw new Error(`Expected built application does not exist: ${appPath}`);
  const plistPath = path.join(appPath, 'Info.plist');
  const bundleId = String(execCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath], { encoding: 'utf8' })).trim();
  const platforms = String(execCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleSupportedPlatforms', plistPath], { encoding: 'utf8' }));
  if (bundleId !== 'dev.kineticron.KineSync' || !/\biPhoneSimulator\b/.test(platforms)) throw new Error('Built product is not the expected KineSync simulator application');
  console.log(`[BUILD] Located built simulator app: ${appPath}`);

  // Ad-hoc codesign app bundle for simulator execution
  console.log('[BUILD] Ad-hoc codesigning app bundle...');
  execCommand('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  const builtAppRecord = path.join(iosDirectory, '.built_app_path');
  fs.writeFileSync(builtAppRecord, appPath, 'utf8');
  console.log(`[BUILD] Successfully built and codesigned app bundle at: ${appPath}`);

  return appPath;
}

const isDirectExecution = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  import.meta.url.endsWith(path.basename(process.argv[1]))
);

if (isDirectExecution) {
  const derivedIndex = process.argv.indexOf('--derived-data-path');
  const derivedDataPath = derivedIndex >= 0 ? process.argv[derivedIndex + 1] : undefined;
  buildSimulatorApp({ derivedDataPath });
}
