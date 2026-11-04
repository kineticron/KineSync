import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseXcodebuildJson,
  findApplicationTarget,
  discoverApplicationScheme,
  buildSimulatorApp,
  configureStandaloneSimulator,
} from './build-simulator-app.mjs';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-build-'));

function testSchemeDiscovery() {
  console.log('Testing Xcode scheme discovery and validation rules...');

  // 1. Test parseXcodebuildJson with direct JSON, bracketed JSON, and console preamble
  {
    const clean = JSON.stringify([{ action: 'build', target: 'KineSync' }]);
    assert.deepStrictEqual(parseXcodebuildJson(clean), [{ action: 'build', target: 'KineSync' }]);

    const withPreamble = `User defaults from command line:\n    IDEPackageSupportUseBuiltinSCM = YES\n\n${clean}\n\n`;
    assert.deepStrictEqual(parseXcodebuildJson(withPreamble), [{ action: 'build', target: 'KineSync' }]);

    assert.throws(() => parseXcodebuildJson('Not a JSON object'), /Failed to parse xcodebuild JSON/);
  }

  // 2. Test findApplicationTarget:
  // - app target (WRAPPER_EXTENSION=app, PRODUCT_TYPE=com.apple.product-type.application) -> returns target
  // - wrong build product (WRAPPER_EXTENSION=framework, PRODUCT_TYPE=com.apple.product-type.framework) -> returns null
  // - wrong build product (WRAPPER_EXTENSION=bundle, PRODUCT_TYPE=com.apple.product-type.bundle) -> returns null
  // - wrong build product (WRAPPER_EXTENSION=app, PRODUCT_TYPE=com.apple.product-type.bundle) -> returns null
  // - wrong build product (WRAPPER_EXTENSION=framework, PRODUCT_TYPE=com.apple.product-type.application) -> returns null
  // - static library (WRAPPER_EXTENSION='', PRODUCT_TYPE=com.apple.product-type.library.static) -> returns null
  {
    const appEntry = {
      target: 'KineSync',
      action: 'build',
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app',
        PRODUCT_TYPE: 'com.apple.product-type.application',
        TARGET_BUILD_DIR: '/DerivedData/Build/Products/Release-iphonesimulator',
        FULL_PRODUCT_NAME: 'KineSync.app',
      },
    };
    const foundApp = findApplicationTarget([appEntry]);
    assert.ok(foundApp, 'Must find valid application target');
    assert.strictEqual(foundApp.target, 'KineSync');
    assert.throws(() => findApplicationTarget([appEntry, { ...appEntry, target: 'OtherApp' }]), /Ambiguous application targets/);
    assert.strictEqual(findApplicationTarget([{ buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app', PRODUCT_TYPE: 'fake-application' } }]), null);
    assert.strictEqual(foundApp.buildSettings.FULL_PRODUCT_NAME, 'KineSync.app');
    assert.strictEqual(foundApp.buildSettings.TARGET_BUILD_DIR, '/DerivedData/Build/Products/Release-iphonesimulator');

    // Wrong build products
    const frameworkEntry = {
      target: 'DoubleConversion',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'framework',
        PRODUCT_TYPE: 'com.apple.product-type.framework',
      },
    };
    assert.strictEqual(findApplicationTarget([frameworkEntry]), null, 'Must reject framework wrapper');

    const bundleEntry = {
      target: 'AssetBundle',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'bundle',
        PRODUCT_TYPE: 'com.apple.product-type.bundle',
      },
    };
    assert.strictEqual(findApplicationTarget([bundleEntry]), null, 'Must reject bundle wrapper');

    const mismatch1 = {
      target: 'FakeApp',
      action: 'build',
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app',
        PRODUCT_TYPE: 'com.apple.product-type.bundle',
      },
    };
    assert.strictEqual(findApplicationTarget([mismatch1]), null, 'Must reject app wrapper with non-app product type');

    const mismatch2 = {
      target: 'FakeFramework',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'framework',
        PRODUCT_TYPE: 'com.apple.product-type.application',
      },
    };
    assert.strictEqual(findApplicationTarget([mismatch2]), null, 'Must reject app product type with non-app wrapper');

    const staticLibEntry = {
      target: 'boost',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: '',
        PRODUCT_TYPE: 'com.apple.product-type.library.static',
      },
    };
    assert.strictEqual(findApplicationTarget([staticLibEntry]), null, 'Must reject static library');

    // Scheme with mixed targets: pod dependency first, then app target
    const mixed = findApplicationTarget([frameworkEntry, staticLibEntry, appEntry]);
    assert.ok(mixed, 'Must find app target among multiple dependency targets');
    assert.strictEqual(mixed.target, 'KineSync');
  }

  // 3. Regression test: mock scheme inventory with pod first and app later
  // This mirrors the root cause of GitHub Actions run 41233371227 where 'boost' was selected alphabetically
  {
    const mockInventory = ['boost', 'DoubleConversion', 'fmt', 'KineSync', 'Pods-KineSync'];
    const mockExec = (cmd, args, options) => {
      assert.equal(options.timeout, 60000);
      assert.strictEqual(cmd, 'xcodebuild');
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: mockInventory,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        assert.equal(args[args.indexOf('-configuration') + 1], 'Release');
        assert.ok(args.includes('ONLY_ACTIVE_ARCH=YES'));
        assert.ok(args.includes('ARCHS=arm64'));
        const schemeIdx = args.indexOf('-scheme');
        const scheme = args[schemeIdx + 1];
        assert.equal(scheme, 'KineSync', 'Never probe dependency or widget schemes');
        if (scheme === 'boost') {
          return JSON.stringify([
            {
              target: 'boost',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: '',
                PRODUCT_TYPE: 'com.apple.product-type.library.static',
                TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator/boost',
              },
            },
          ]);
        }
        if (scheme === 'DoubleConversion') {
          return JSON.stringify([
            {
              target: 'DoubleConversion',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'framework',
                PRODUCT_TYPE: 'com.apple.product-type.framework',
                TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator/DoubleConversion',
              },
            },
          ]);
        }
        if (scheme === 'fmt') {
          return JSON.stringify([
            {
              target: 'fmt',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'a',
                PRODUCT_TYPE: 'com.apple.product-type.library.static',
                TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator/fmt',
              },
            },
          ]);
        }
        if (scheme === 'Pods-KineSync') {
          return JSON.stringify([
            {
              target: 'Pods-KineSync',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'framework',
                PRODUCT_TYPE: 'com.apple.product-type.framework',
                TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator/Pods-KineSync',
              },
            },
          ]);
        }
        if (scheme === 'KineSync') {
          return JSON.stringify([
            {
              target: 'KineSync',
              action: 'build',
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app',
                PRODUCT_TYPE: 'com.apple.product-type.application',
                TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator',
                FULL_PRODUCT_NAME: 'KineSync.app',
              },
            },
          ]);
        }
        throw new Error(`Unknown scheme in mock: ${scheme}`);
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    const discovered = discoverApplicationScheme('/path/to/KineSync.xcworkspace', {
      execCommand: mockExec,
    });
    assert.strictEqual(discovered.scheme, 'KineSync', 'Must select KineSync and not earlier pod scheme boost');
    assert.strictEqual(discovered.target, 'KineSync');
    assert.strictEqual(discovered.buildSettings.FULL_PRODUCT_NAME, 'KineSync.app');
    assert.strictEqual(discovered.buildSettings.TARGET_BUILD_DIR, '/derived/Build/Products/Release-iphonesimulator');
  }

  // Real run 41290266075: widget scheme also reports the KineSync host app.
  {
    const app = { target: 'KineSync', action: 'build', buildSettings: {
      PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app', PRODUCT_TYPE: 'com.apple.product-type.application',
      PROJECT_FILE_PATH: '/repo/ios/KineSync.xcodeproj',
      TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator', FULL_PRODUCT_NAME: 'KineSync.app',
    } };
    const widget = { target: 'KineSyncLyricsWidget', buildSettings: {
      WRAPPER_EXTENSION: 'appex', PRODUCT_TYPE: 'com.apple.product-type.app-extension',
      FULL_PRODUCT_NAME: 'KineSyncLyricsWidget.appex',
    } };
    const run = (schemes, host = app) => discoverApplicationScheme('/repo/ios/KineSync.xcworkspace', {
      execCommand: (_cmd, args) => args.includes('-list') ? JSON.stringify({ workspace: { schemes } }) :
        JSON.stringify(args[args.indexOf('-scheme') + 1] === 'KineSyncLyricsWidget' ? [widget, host] : [app]),
    });
    for (const schemes of [['KineSyncLyricsWidget', 'KineSync'], ['KineSync', 'KineSyncLyricsWidget']]) {
      const selected = run(schemes);
      assert.equal(selected.scheme, 'KineSync', 'Select intended host scheme regardless of enumeration order');
      assert.equal(selected.target, 'KineSync');
      assert.equal(selected.buildSettings.FULL_PRODUCT_NAME, 'KineSync.app');
    }
    assert.throws(() => run(['KineSyncLyricsWidget']), /Intended application scheme KineSync was not found/);
    assert.equal(findApplicationTarget([app, structuredClone(app)]).target, 'KineSync', 'Repeated identical app settings are one identity');
    for (const changed of [
      { PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.Other' },
      { FULL_PRODUCT_NAME: 'Other.app' },
      { PROJECT_FILE_PATH: '/other/KineSync.xcodeproj' },
      { TARGET_BUILD_DIR: '/other/Release-iphonesimulator' },
    ]) {
      const other = { ...app, buildSettings: { ...app.buildSettings, ...changed } };
      assert.equal(run(['KineSync', 'KineSyncLyricsWidget'], other).scheme, 'KineSync');
      assert.throws(() => findApplicationTarget([app, other]), /Ambiguous application targets/);
    }
  }

  // 4. Regression test: no app in scheme inventory (only pods / wrong build products)
  {
    const mockInventoryOnlyPods = ['boost', 'DoubleConversion', 'fmt'];
    const mockExec = (cmd, args) => {
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'TestWs',
            schemes: mockInventoryOnlyPods,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        return JSON.stringify([
          {
            target: 'StaticLib',
            action: 'build',
            buildSettings: {
              WRAPPER_EXTENSION: 'a',
              PRODUCT_TYPE: 'com.apple.product-type.library.static',
            },
          },
        ]);
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    assert.throws(
      () => discoverApplicationScheme('/path/to/TestWs.xcworkspace', { execCommand: mockExec }),
      /Intended application scheme KineSync was not found/,
      'Must throw explicit error when no application scheme is found'
    );
  }

  // 5. Regression test: ambiguous explicit failure (multiple application schemes)
  {
    const mockInventoryAmbiguous = ['KineSync', 'KineSyncBeta'];
    const mockExec = (cmd, args) => {
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: mockInventoryAmbiguous,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        assert.equal(args[args.indexOf('-configuration') + 1], 'Release');
        assert.ok(args.includes('ONLY_ACTIVE_ARCH=YES'));
        assert.ok(args.includes('ARCHS=arm64'));
        const schemeIdx = args.indexOf('-scheme');
        const scheme = args[schemeIdx + 1];
        return JSON.stringify([
          {
            target: scheme,
            action: 'build',
            buildSettings: {
              PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app',
              PRODUCT_TYPE: 'com.apple.product-type.application',
              TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator',
              FULL_PRODUCT_NAME: `${scheme}.app`,
            },
          },
        ]);
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    assert.equal(discoverApplicationScheme('/path/to/KineSync.xcworkspace', { execCommand: mockExec }).scheme, 'KineSync');
  }

  // 6. Regression test: pod scheme query failure is tolerated during discovery
  {
    const mockInventoryWithError = ['failing-pod', 'KineSync'];
    const mockExec = (cmd, args) => {
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: mockInventoryWithError,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        assert.equal(args[args.indexOf('-configuration') + 1], 'Release');
        assert.ok(args.includes('ONLY_ACTIVE_ARCH=YES'));
        assert.ok(args.includes('ARCHS=arm64'));
        const schemeIdx = args.indexOf('-scheme');
        const scheme = args[schemeIdx + 1];
        if (scheme === 'failing-pod') {
          throw new Error('xcodebuild: error: Scheme failing-pod is not configured for iphonesimulator');
        }
        if (scheme === 'KineSync') {
          return JSON.stringify([
            {
              target: 'KineSync',
              action: 'build',
              buildSettings: {
                PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app',
                PRODUCT_TYPE: 'com.apple.product-type.application',
                TARGET_BUILD_DIR: '/derived/Build/Products/Release-iphonesimulator',
                FULL_PRODUCT_NAME: 'KineSync.app',
              },
            },
          ]);
        }
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    const discovered = discoverApplicationScheme('/path/to/KineSync.xcworkspace', {
      execCommand: mockExec,
    });
    assert.strictEqual(discovered.scheme, 'KineSync');
  }

  // 7. End-to-end buildSimulatorApp with mock runner and exact derived path verification
  {
    const testIosDir = path.join(tempDir, 'mock-ios');
    const testDerivedDir = path.join(tempDir, 'mock-derived');
    const expectedAppDir = path.join(testDerivedDir, 'Build', 'Products', 'Release-iphonesimulator', 'KineSync.app');
    fs.mkdirSync(path.join(testIosDir, 'KineSync.xcworkspace'), { recursive: true });
    fs.mkdirSync(expectedAppDir, { recursive: true });

    let builtScheme = null;
    fs.mkdirSync(path.join(testIosDir, 'KineSync'), { recursive: true });
    fs.writeFileSync(path.join(testIosDir, 'KineSync/AppDelegate.swift'), '#if DEBUG\nreturn RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")\n#else\n    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")\n#endif');
    let signedPath = null;
    const mockRunner = (cmd, args) => {
      if (cmd === 'xcodebuild' && args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: ['boost', 'KineSyncLyricsWidget', 'KineSync'],
          },
        });
      }
      if (cmd === 'xcodebuild' && args.includes('-showBuildSettings')) {
        const scheme = args[args.indexOf('-scheme') + 1];
        if (scheme === 'boost') {
          return JSON.stringify([{ target: 'boost', buildSettings: { WRAPPER_EXTENSION: '', PRODUCT_TYPE: 'library' } }]);
        }
        return JSON.stringify([
          {
            target: 'KineSync',
            buildSettings: {
              PRODUCT_BUNDLE_IDENTIFIER: 'dev.kineticron.KineSync', WRAPPER_EXTENSION: 'app',
              PRODUCT_TYPE: 'com.apple.product-type.application',
              TARGET_BUILD_DIR: path.join(testDerivedDir, 'Build', 'Products', 'Release-iphonesimulator'),
              FULL_PRODUCT_NAME: 'KineSync.app',
            },
          },
        ]);
      }
      if (cmd === 'xcodebuild' && args.includes('build')) {
        assert.equal(args[args.indexOf('-configuration') + 1], 'Release');
        for (const flag of ['ONLY_ACTIVE_ARCH=YES', 'ARCHS=arm64', 'EXPO_PUBLIC_SIMULATOR_TEST_BUILD=release-arm64', 'FORCE_BUNDLING=1']) assert.ok(args.includes(flag), flag);
        assert.equal(process.env.EXPO_PUBLIC_SIMULATOR_TEST_BUILD, 'release-arm64');
        assert.ok(!fs.existsSync(path.join(tempDir, '.env.local')));
        if (fs.existsSync(expectedAppDir)) { fs.writeFileSync(path.join(expectedAppDir, 'main.jsbundle'), 'test bundle'); fs.writeFileSync(path.join(expectedAppDir, 'KineSync'), 'mock executable'); }
        builtScheme = args[args.indexOf('-scheme') + 1];
        return '';
      }
      if (cmd === '/usr/libexec/PlistBuddy') return args[1].includes('Identifier') ? 'dev.kineticron.KineSync' : args[1].includes('Executable') ? 'KineSync' : 'Array { iPhoneSimulator }';
      if (cmd === 'xcrun') return args[0] === 'lipo' ? 'arm64' : 'platform IOSSIMULATOR';
      if (cmd === 'codesign') {
        signedPath = args[args.length - 1];
        return '';
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    };

    const appResult = buildSimulatorApp({
      derivedDataPath: testDerivedDir,
      iosDirectory: testIosDir,
      appDirectory: tempDir,
      execCommand: mockRunner,
    });

    assert.match(fs.readFileSync(path.join(testIosDir, 'KineSync/AppDelegate.swift'), 'utf8'), /standalone simulator harness/);
    assert.match(fs.readFileSync(path.join(testIosDir, '.xcode.env.local'), 'utf8'), /unset SKIP_BUNDLING/);
    assert.strictEqual(builtScheme, 'KineSync', 'Must invoke xcodebuild build for application scheme KineSync');
    assert.strictEqual(signedPath, expectedAppDir, 'Must codesign exact derived app path');
    assert.strictEqual(appResult, expectedAppDir, 'Must return exact derived app path');
    for (const bad of ['arm64 x86_64', 'x86_64', 'platform IOS']) {
      const runner = (cmd, args) => cmd === 'xcrun' ? (args[0] === 'lipo' ? (bad.startsWith('platform') ? 'arm64' : bad) : (bad.startsWith('platform') ? bad : 'platform IOSSIMULATOR')) : mockRunner(cmd, args);
      assert.throws(() => buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, appDirectory: tempDir, execCommand: runner }), /exactly arm64 IOSSIMULATOR/);
    }
    fs.writeFileSync(path.join(expectedAppDir, 'main.jsbundle'), 'stale cached bundle');
    const missingBundle = (cmd, args) => cmd === 'xcodebuild' && args.includes('build') ? '' : mockRunner(cmd, args);
    assert.throws(() => buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, appDirectory: tempDir, execCommand: missingBundle }), /no main.jsbundle/);
    const emptyBundle = (cmd, args) => {
      if (cmd === 'xcodebuild' && args.includes('build')) { fs.writeFileSync(path.join(expectedAppDir, 'main.jsbundle'), ''); return ''; }
      return mockRunner(cmd, args);
    };
    assert.throws(() => buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, appDirectory: tempDir, execCommand: emptyBundle }), /no main.jsbundle/);
    fs.rmSync(expectedAppDir, { recursive: true });
    fs.mkdirSync(path.join(testDerivedDir, 'Build/Products/Release-iphoneos/Stale.app'), { recursive: true });
    assert.throws(() => buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, appDirectory: tempDir, execCommand: mockRunner }), /Expected built application does not exist/);
    fs.mkdirSync(expectedAppDir, { recursive: true });
    for (const badMetadata of ['wrong.bundle', 'Array { iPhoneOS }']) {
      const wrongRunner = (cmd, args) => cmd === '/usr/libexec/PlistBuddy' ? badMetadata : mockRunner(cmd, args);
      assert.throws(() => buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, appDirectory: tempDir, execCommand: wrongRunner }), /not the expected/);
    }
    assert.ok(!fs.existsSync(path.join(testIosDir, '.built_app_path')), 'Failed build must invalidate stale product record');
    const nativeRunner = (cmd, args, options) => {
      if (cmd === 'xcodebuild' && args.includes('build')) {
        assert.equal(fs.existsSync(expectedAppDir), false, 'Native shell must remove the whole stale app, including assets');
        assert.equal(options.env.KINESYNC_EXTERNAL_BUNDLE, '1');
        assert.ok(args.includes('GCC_GENERATE_DEBUGGING_SYMBOLS=NO'));
        assert.ok(args.includes('DEBUG_INFORMATION_FORMAT=dwarf'));
        fs.mkdirSync(expectedAppDir, { recursive: true });
        fs.writeFileSync(path.join(expectedAppDir, 'KineSync'), 'fresh native executable');
        return '';
      }
      return mockRunner(cmd, args, options);
    };
    assert.equal(buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, nativeOnly: true, execCommand: nativeRunner }), expectedAppDir);
    assert.equal(fs.existsSync(path.join(expectedAppDir, 'main.jsbundle')), false);
    const details = buildSimulatorApp({ derivedDataPath: testDerivedDir, iosDirectory: testIosDir, nativeOnly: true, returnBuildDetails: true, execCommand: nativeRunner });
    assert.equal(details.appPath, expectedAppDir);
    assert.equal(details.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, 'dev.kineticron.KineSync');

  }

  console.log('Xcode scheme discovery and validation rules passed.');
}


function testInstalledTemplateShell() {
  const template = fileURLToPath(new URL('../node_modules/expo/template.tgz', import.meta.url));
  const project = execFileSync('tar', ['-xOzf', template, 'package/ios/HelloWorld.xcodeproj/project.pbxproj'], { encoding: 'utf8' });
  const phase = [...project.matchAll(/shellScript = ("(?:\\.|[^"\\])*");/g)]
    .map(match => JSON.parse(match[1])).find(script => script.includes('export SKIP_BUNDLING=1'));
  assert.ok(phase, 'Installed Expo template must expose the actual Debug bundle phase');
  const ios = path.join(tempDir, 'actual-template');
  fs.mkdirSync(path.join(ios, 'HelloWorld'), { recursive: true });
  fs.writeFileSync(path.join(ios, 'HelloWorld/AppDelegate.swift'), execFileSync('tar', ['-xOzf', template, 'package/ios/HelloWorld/AppDelegate.swift']));
  fs.writeFileSync(path.join(ios, '.xcode.env.local'), 'export PRESERVED_LOCAL=local\n');
  fs.writeFileSync(path.join(ios, '.xcode.env.updates'), 'export PRESERVED_UPDATES=updates\nexport SKIP_BUNDLING=1\n');
  const fakeRN = path.join(ios, 'fake-rn');
  fs.mkdirSync(path.join(fakeRN, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(fakeRN, 'scripts/react-native-xcode.sh'), '#!/bin/bash\nprintf "%s|%s|%s|%s" "${SKIP_BUNDLING-unset}" "$FORCE_BUNDLING" "$PRESERVED_LOCAL" "$PRESERVED_UPDATES"\n', { mode: 0o755 });
  const nodeShim = path.join(ios, 'node-shim');
  fs.writeFileSync(nodeShim, '#!/bin/bash\nprintf "%s" "$TEST_RN_PATH"\n', { mode: 0o755 });
  const execute = (configuration = 'Debug') => execFileSync('bash', ['-e', '-c', phase], { encoding: 'utf8', env: { ...process.env, SRCROOT: ios, PROJECT_DIR: ios, CONFIGURATION: configuration, SKIP_BUNDLING: '', FORCE_BUNDLING: '1', ENTRY_FILE: '/mock/index.js', CLI_PATH: '/mock/cli', BUNDLE_COMMAND: 'export:embed', NODE_BINARY: nodeShim, TEST_RN_PATH: path.join(fakeRN, 'scripts/react-native-xcode.sh') } });
  assert.equal(execute(), '1|1|local|updates', 'Xcode arg alone must lose to actual generated phase');
  configureStandaloneSimulator(ios);
  assert.equal(execute('Release'), 'unset|1|local|updates', 'Release embed phase must override updates skip flag too');
  process.env.KINESYNC_EXTERNAL_BUNDLE = '1';
  assert.equal(execute('Release'), '1|1|local|updates', 'External fresh bundles must skip the native build bundle phase');
  delete process.env.KINESYNC_EXTERNAL_BUNDLE;
  assert.equal(execute(), 'unset|1|local|updates', 'Late local override must win after Debug and updates exports');
  const first = fs.readFileSync(path.join(ios, '.xcode.env.local'), 'utf8');
  configureStandaloneSimulator(ios);
  assert.equal(fs.readFileSync(path.join(ios, '.xcode.env.local'), 'utf8'), first, 'Override must be idempotent');
  assert.equal(execute(), 'unset|1|local|updates');
  const delegate = path.join(ios, 'HelloWorld/AppDelegate.swift');
  fs.writeFileSync(delegate, fs.readFileSync(delegate, 'utf8').replace('#else', '#elseif UNKNOWN'));
  assert.throws(() => configureStandaloneSimulator(ios), /Unsupported generated Release bundle URL/);
  console.log('Installed Expo template shell override tests passed.');
}

try { testSchemeDiscovery(); testInstalledTemplateShell(); } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
