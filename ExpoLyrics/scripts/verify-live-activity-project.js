/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const { TARGET, ACTIVITY_MODULE } = require('../plugins/with-live-activity');
const unquote = (value) => String(value || '').replace(/^"|"$/g, '');

function verifyWidgetSource(widgetSource) {
  assert.match(widgetSource, /@main\s+struct\s+KineSyncLyricsWidgetBundle\s*:\s*WidgetBundle/, 'Lyrics widget must have a @main WidgetBundle entry point');
  assert.match(widgetSource, /var\s+body\s*:\s*some\s+Widget\s*\{\s*KineSyncLyricsActivity\(\)\s*\}/, 'WidgetBundle must register KineSyncLyricsActivity');
  assert.match(widgetSource, /ActivityConfiguration\(for:\s*LyricsActivityAttributes\.self\)/, 'Lyrics widget must register an ActivityConfiguration for LyricsActivityAttributes');
}

function verifyProject(project, iosDir, projectRoot) {
  const objects = project.hash.project.objects;
  const targets = Object.entries(objects.PBXNativeTarget).filter(([, value]) => typeof value === 'object');
  const extensions = targets.filter(([, value]) => unquote(value.name) === TARGET);
  assert.equal(extensions.length, 1, 'Exactly one lyrics extension target is required');
  const [extensionId, extension] = extensions[0];
  assert.equal(unquote(extension.productType), 'com.apple.product-type.app-extension');
  const host = targets.find(([, value]) => unquote(value.productType) === 'com.apple.product-type.application')?.[1];
  assert(host, 'Missing host application target');
  assert(host.dependencies.some(({ value }) => objects.PBXTargetDependency[value]?.target === extensionId), 'Host does not build the widget extension');
  const copy = host.buildPhases.map(({ value }) => objects.PBXCopyFilesBuildPhase?.[value]).filter(Boolean);
  assert(copy.some((phase) => Number(phase.dstSubfolderSpec) === 13 && phase.files.some(({ value }) =>
    objects.PBXBuildFile[value]?.fileRef === extension.productReference)), 'Host must embed the extension in PlugIns');
  const sources = extension.buildPhases.flatMap(({ value }) => objects.PBXSourcesBuildPhase?.[value]?.files || []);
  const compiled = sources.map(({ value }) => unquote(objects.PBXFileReference[objects.PBXBuildFile[value].fileRef].path));
  for (const file of ['LyricsActivityAttributes.swift', 'KineSyncLyricsActivity.swift']) {
    assert.equal(compiled.filter((name) => name === file).length, 1, `Missing or duplicate widget source: ${file}`);
  }
  const shared = 'modules/kinesync-live-activity/ios/LyricsActivityAttributes.swift';
  assert.equal(fs.readFileSync(path.join(iosDir, TARGET, 'LyricsActivityAttributes.swift'), 'utf8'), fs.readFileSync(path.join(projectRoot, shared), 'utf8'), 'Host and widget ActivityAttributes must match');
  const widgetSourcePath = path.join(projectRoot, 'widgets/KineSyncLyricsActivity.swift');
  const widgetSource = fs.readFileSync(widgetSourcePath, 'utf8');
  verifyWidgetSource(widgetSource);
  assert.equal(fs.readFileSync(path.join(iosDir, TARGET, 'KineSyncLyricsActivity.swift'), 'utf8'), widgetSource, 'Generated widget implementation must match the registered source');
  const info = plist.parse(fs.readFileSync(path.join(iosDir, TARGET, 'Info.plist'), 'utf8'));
  assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
  const hostList = objects.XCConfigurationList[host.buildConfigurationList].buildConfigurations;
  const hostIds = hostList.map(({ value }) => unquote(objects.XCBuildConfiguration[value].buildSettings.PRODUCT_BUNDLE_IDENTIFIER));
  for (const { value } of objects.XCConfigurationList[extension.buildConfigurationList].buildConfigurations) {
    const settings = objects.XCBuildConfiguration[value].buildSettings;
    assert(hostIds.some((id) => unquote(settings.PRODUCT_BUNDLE_IDENTIFIER) === `${id}.${TARGET}`), 'Widget bundle ID must be nested under host ID');
    assert.equal(settings.APPLICATION_EXTENSION_API_ONLY, 'YES');
    assert.equal(unquote(settings.PRODUCT_MODULE_NAME), ACTIVITY_MODULE, 'Host and widget must use the same ActivityAttributes module');
    assert.equal(unquote(settings.SWIFT_VERSION), '5.0', 'Use the Swift 5 language mode, not a compiler release number');
    assert.equal(settings.SKIP_INSTALL, 'YES');
    assert.equal(unquote(settings.INFOPLIST_FILE), `${TARGET}/Info.plist`);
  }
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..');
  const iosDir = path.join(projectRoot, 'ios');
  const name = fs.readdirSync(iosDir).find((file) => file.endsWith('.xcodeproj'));
  assert(name, 'No generated iOS project');
  const project = xcode.project(path.join(iosDir, name, 'project.pbxproj'));
  project.parseSync();
  verifyProject(project, iosDir, projectRoot);
  const hostInfo = path.join(iosDir, path.basename(name, '.xcodeproj'), 'Info.plist');
  assert.equal(plist.parse(fs.readFileSync(hostInfo, 'utf8')).NSSupportsLiveActivities, true, 'Host is missing NSSupportsLiveActivities');
  assert.match(fs.readFileSync(path.join(iosDir, 'Podfile.lock'), 'utf8'), /KineSyncLiveActivity/, 'Native ActivityKit module is not linked by CocoaPods');
  console.log('Verified host ActivityKit support, native pod, widget sources, dependency, and PlugIns embedding.');
}

module.exports = { verifyProject, verifyWidgetSource };
