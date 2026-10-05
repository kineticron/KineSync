const fs = require('node:fs');
const path = require('node:path');
const { withInfoPlist, withXcodeProject, withPodfile } = require('expo/config-plugins');
const plist = require('@expo/plist');

const TARGET = 'KineSyncLyricsWidget';
const unquote = (value) => String(value || '').replace(/^"|"$/g, '');

function configureProject(project, { projectRoot, platformProjectRoot, bundleIdentifier, version, buildNumber }) {
  const directory = path.join(platformProjectRoot, TARGET);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'widgets/KineSyncLyricsActivity.swift'), path.join(directory, 'KineSyncLyricsActivity.swift'));
  fs.writeFileSync(path.join(directory, 'Info.plist'), plist.default.build({
    CFBundleDisplayName: 'KineSync Lyrics',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: version,
    CFBundleVersion: buildNumber,
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
  }));

  const objects = project.hash.project.objects;
  // node-xcode expects these sections even in projects with no prior extensions.
  for (const section of ['PBXTargetDependency', 'PBXContainerItemProxy']) objects[section] ||= {};
  let entry = Object.entries(project.pbxNativeTargetSection()).find(([, target]) =>
    typeof target === 'object' && unquote(target.name) === TARGET);
  if (!entry) {
    // addTarget creates BOTH the host dependency and a Copy Files phase to PlugIns.
    const added = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleIdentifier}.${TARGET}`);
    entry = [added.uuid, added.pbxNativeTarget];
    const group = project.addPbxGroup([], TARGET, TARGET);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', added.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', added.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', added.uuid);
    for (const file of ['KineSyncLyricsActivity.swift']) {
      project.addSourceFile(file, { target: added.uuid }, group.uuid);
    }
  }
  const [, target] = entry;
  // Remove the old copied declaration when prebuild reuses an existing project.
  for (const { value } of target.buildPhases) {
    const phase = objects.PBXSourcesBuildPhase?.[value];
    if (!phase) continue;
    phase.files = phase.files.filter(({ value: buildId }) => {
      const ref = objects.PBXBuildFile[buildId]?.fileRef;
      return unquote(objects.PBXFileReference[ref]?.path) !== 'LyricsActivityAttributes.swift';
    });
  }
  const configurations = objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations;
  for (const { value } of configurations) {
    Object.assign(objects.XCBuildConfiguration[value].buildSettings, {
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}.${TARGET}"`,
      PRODUCT_NAME: `"${TARGET}"`,
      // Keep the widget module distinct from the Expo host pod. ActivityKit
      // imports KineSyncActivityTypes in both targets for matching attributes
      // identity without shadowing Expo's KineSyncLiveActivity host module.
      PRODUCT_MODULE_NAME: TARGET,
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      GENERATE_INFOPLIST_FILE: 'NO',
      IPHONEOS_DEPLOYMENT_TARGET: '16.4',
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SDKROOT: 'iphoneos',
      SUPPORTED_PLATFORMS: '"iphoneos iphonesimulator"',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CLANG_ENABLE_MODULES: 'YES',
      SWIFT_OPTIMIZATION_LEVEL: '-O',
      SKIP_INSTALL: 'YES',
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
      MARKETING_VERSION: `"${version}"`,
    });
  }
  // Strip only headers during embedding; preserve the extension and sign it in
  // signed builds. CI's CODE_SIGNING_ALLOWED=NO also applies to the extension.
  for (const buildFile of Object.values(objects.PBXBuildFile)) {
    if (typeof buildFile === 'object' && buildFile.fileRef === target.productReference) {
      buildFile.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
    }
  }
  return project;
}

function withLiveActivity(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSSupportsLiveActivities = true;
    return mod;
  });
  config = withPodfile(config, (mod) => {
    mod.modResults.contents = configurePodfile(mod.modResults.contents);
    return mod;
  });
  // Let EAS provision the extension too, if a signed EAS build is used later.
  const iosBuild = (((config.extra ||= {}).eas ||= {}).build ||= {}).experimental ||= {};
  const ios = iosBuild.ios ||= {};
  ios.appExtensions = (ios.appExtensions || []).filter((entry) => entry.targetName !== TARGET);
  ios.appExtensions.push({ targetName: TARGET, bundleIdentifier: `${config.ios.bundleIdentifier}.${TARGET}`, entitlements: {} });
  return withXcodeProject(config, (mod) => {
    configureProject(mod.modResults, {
      ...mod.modRequest,
      bundleIdentifier: config.ios.bundleIdentifier,
      version: config.version || '1.0.0',
      buildNumber: config.ios.buildNumber || '1',
    });
    return mod;
  });
}

module.exports = withLiveActivity;
module.exports.configureProject = configureProject;
module.exports.TARGET = TARGET;

function configurePodfile(contents) {
  const start = '# BEGIN KineSync lyrics widget pods';
  const end = '# END KineSync lyrics widget pods';
  const block = `${start}\ntarget '${TARGET}' do\n  use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']\n  use_frameworks! :linkage => ENV['USE_FRAMEWORKS'].to_sym if ENV['USE_FRAMEWORKS']\n  pod 'KineSyncActivityTypes', :path => '../modules/kinesync-live-activity/ios/types', :modular_headers => true\nend\n${end}`;
  const previous = /# BEGIN KineSync lyrics widget pods[\s\S]*?# END KineSync lyrics widget pods/;
  return previous.test(contents) ? contents.replace(previous, block) : `${contents.trimEnd()}\n\n${block}\n`;
}
module.exports.configurePodfile = configurePodfile;
