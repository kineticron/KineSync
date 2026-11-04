// Execute RN's shipped console polyfill in Release mode, not a fake console/log stream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { provenanceEntry, digest } from './simulator-app-reuse.mjs';
const require = createRequire(import.meta.url);
const project = path.resolve(new URL('..', import.meta.url).pathname);
const rn = path.dirname(require.resolve('react-native/package.json'));
const polyfillPath = require.resolve('@react-native/js-polyfills/console.js');
const polyfill = fs.readFileSync(polyfillPath, 'utf8');
const metro = require('expo/metro-config').getDefaultConfig(project);
assert.ok(metro.serializer.getPolyfills({ platform: 'ios' }).includes(polyfillPath), 'Actual iOS serializer installs RN console before the wrapper');
assert.ok(metro.resolver.blockList.some(rule => rule.test('ios/Pods')), 'Installed Expo excludes Pods during crawling without an unsupported override');
const nativeMessages = [], required = [];
const context = { __DEV__: false, console: { info() { throw new Error('Release must use RN native hook, not original console'); } },
  nativeLoggingHook: (message, level) => nativeMessages.push({ message, level }), require: entry => required.push(entry),
  process: { env: { EXPO_PUBLIC_SIMULATOR_TEST: '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: 'release-arm64' } },
  exports: {}, setTimeout, clearTimeout };
context.global = context;
vm.runInNewContext(polyfill, context, { filename: 'actual-RN-console.js' });
const runtimeId = digest('Release provenance regression');
vm.runInNewContext(provenanceEntry(runtimeId, '/exact/source/entry.js'), context);
assert.equal(context.console._isPolyfilled, true);
assert.equal(required[0], '/exact/source/entry.js');
assert.deepEqual(nativeMessages, [{ message: `[KINESYNC_PROVENANCE] ${runtimeId}`, level: 1 }]);
// Execute the actual historical bridge publisher using the same Release console.
const bridge = fs.readFileSync(path.join(project, 'lib/simulator-test-bridge.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(bridge, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
context.exports.notifySimulatorRendererReady({ key: 'test', generation: 1, style: 'amll', linesCount: 1, trackId: 'test' });
assert.equal(nativeMessages[1].level, nativeMessages[0].level);
assert.match(nativeMessages[1].message, /\[KINESYNC_SIM\] RENDERER_ACTIVE/);
// Check the actual native half of that hook and live-stream route. This worker cannot run os_log on Linux.
const bindings = fs.readFileSync(path.join(rn, 'ReactCommon/jsitooling/react/runtime/JSRuntimeBindings.cpp'), 'utf8');
assert.match(bindings, /"nativeLoggingHook"/);
assert.match(bindings, /args\[0\]\.asString\(runtime\)\.utf8\(runtime\)/);
assert.match(bindings, /static_cast<unsigned int>\(args\[1\]\.asNumber\(\)\)/);
const instance = fs.readFileSync(path.join(rn, 'ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm'), 'utf8');
assert.match(instance, /bindNativeLogger\(runtime,[\s\S]*?_RCTLogJavaScriptInternal\(static_cast<RCTLogLevel>\(logLevel\)/);
const logging = fs.readFileSync(path.join(rn, 'React/Base/RCTLog.mm'), 'utf8');
assert.match(logging, /RCTDefaultLogThreshold = \(RCTLogLevel\)\(RCTLogLevelInfo - 1\)/);
assert.match(logging, /RCTCurrentLogThreshold = RCTDefaultLogThreshold/);
assert.match(logging, /RCTGetLogFunction\(\)[\s\S]*?RCTCurrentLogFunction = RCTDefaultLogFunction/);
assert.match(logging, /RCTLogSourceJavaScript:[\s\S]*?os_log_create\("com.facebook.react.log", "javascript"\)/);
assert.match(logging, /logLevel <= RCTLogLevelWarning\)[\s\S]*?return OS_LOG_TYPE_INFO/);
assert.match(logging, /os_log_with_type\(RCTLogForLogSource\(source\), RCTLogTypeForLogLevel\(level\), "%\{public\}s"/);
const nativeJS = logging.slice(logging.indexOf('void _RCTLogJavaScriptInternal'));
assert.match(nativeJS, /BOOL log = RCT_DEBUG \|\| \(logFunction != nil\)/);
assert.match(nativeJS, /level >= RCTGetLogThreshold\(\)/);
assert.match(nativeJS, /logFunction\(level, RCTLogSourceJavaScript/);
assert.ok(!nativeJS.includes('#if RCT_DEBUG'), 'Release JS logging must not be compiled out');
const runner = fs.readFileSync(new URL('./run-ios-simulator-test.mjs', import.meta.url), 'utf8');
assert.match(runner, /'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', 'process == "KineSync"'/);
console.log('Actual RN Release console routes wrapper and bridge at info level; native threshold/backend and canonical stream verified from installed implementation.');
