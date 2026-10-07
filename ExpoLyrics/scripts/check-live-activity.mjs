import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const source of ['KineSyncLiveActivityModule.swift', 'types/LyricsActivityAttributes.swift', 'KineSyncLiveActivity.podspec', 'types/KineSyncActivityTypes.podspec']) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', `modules/kinesync-live-activity/ios/${source}`], { cwd: root });
  assert.equal(result.status, 1, `Native source must survive a clean Git checkout: ${source}`);
}
const bundled = await build({
  entryPoints: [path.join(root, 'lib/live-activity-snapshot.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const { makeLiveActivitySnapshot, liveActivityInputChanged } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const base = {
  currentTrack: { id: 'one', title: 'Song', artist: 'Artist', album: 'Album', durationMs: 120000 },
  lyrics: [{ lineStartTime: 1000, lineEndTime: 4000, syllables: [
    { text: 'Hel', startTime: 1000, endTime: 1200, isPartOfWord: true },
    { text: 'lo', startTime: 1200, endTime: 1500, isPartOfWord: false },
    { text: 'world', startTime: 1500, endTime: 4000 },
  ] }],
  lyricsMetadata: {}, lyricsSource: 'spicy-lyrics-syllable',
  lyricsStatusMessage: 'Fetched 1 lines from spicy-lyrics-syllable.',
  playbackMode: 'mobile', connectionStatus: 'disconnected',
  anchorPositionMs: 1000, anchorMonotonicMs: 10000, isPlaying: true,
};
const snapshot = makeLiveActivitySnapshot(base);
assert.equal(snapshot.title, 'Song');
assert.equal(snapshot.artist, 'Artist');
for (const key of ['lyric', 'lines', 'positionMs', 'durationMs', 'sampledAtMs', 'instrumental']) {
  assert.equal(Object.hasOwn(snapshot, key), false, `Live Activity must not receive lyric scheduling data: ${key}`);
}
assert(!JSON.stringify(snapshot).includes('Hello world'), 'Lyric text must stay inside the player');
assert.equal(snapshot.timingMode, 'karaoke');
assert.equal(snapshot.source, 'Spicy · Karaoke');
assert.equal(snapshot.status, 'Fetched 1 lines');
assert.equal(makeLiveActivitySnapshot({ ...base, currentTrack: { ...base.currentTrack, artworkUrl: 'https://example.com/cover.jpg' } }).artworkUrl, 'https://example.com/cover.jpg');
assert.equal(makeLiveActivitySnapshot({ ...base, currentTrack: null }).artworkUrl, '', 'Idle snapshots clear artwork');
assert.equal(makeLiveActivitySnapshot({ ...base, playbackMode: 'desktop', currentTrack: { ...base.currentTrack, artworkUrl: 'data:image/jpeg;base64,cover' } }).artworkUrl, '', 'Disconnected desktop snapshots clear artwork');
assert.equal(liveActivityInputChanged({ ...base, playbackPosition: 2000 }, base), false, '10 Hz UI ticks must not publish ActivityKit updates');
assert.equal(liveActivityInputChanged({ ...base, isPlaying: false }, base), true);
assert.equal(liveActivityInputChanged({ ...base, anchorPositionMs: 5000, anchorMonotonicMs: 15000 }, base), false, 'Clock corrections must not publish metadata updates');
assert.equal(liveActivityInputChanged({ ...base, currentTrack: { ...base.currentTrack, artworkUrl: 'https://example.com/new.jpg' } }, base), true, 'Artwork changes must still publish');
assert.equal(liveActivityInputChanged({ ...base, lyricsSource: 'spicy-lyrics-line' }, base), true);
assert.equal(makeLiveActivitySnapshot({ ...base, lyricsSource: 'spicy-lyrics-line' }).timingMode, 'interpolated');
assert.equal(makeLiveActivitySnapshot({ ...base, lyrics: [{ lineStartTime: 0, lineEndTime: 0, syllables: [{ text: 'Plain lyrics', startTime: 0, endTime: 0 }] }] }).timingMode, 'static');
assert.equal(makeLiveActivitySnapshot({ ...base, currentTrack: null }).trackId, '');
assert.equal(makeLiveActivitySnapshot({ ...base, currentTrack: null }).isPlaying, false);
assert.equal(makeLiveActivitySnapshot({ ...base, playbackMode: 'desktop' }).trackId, '', 'Switch to static content on desktop disconnect');
// Clear stale metadata after a disconnect or when playback disappears.
for (const input of [{ ...base, currentTrack: null }, { ...base, playbackMode: 'desktop' }]) {
    const idle = makeLiveActivitySnapshot(input);
    assert.equal(idle.title, 'KineSync');
    assert.equal(idle.artist, '');
    assert.equal(idle.status, 'Waiting for a song');
    assert.equal(idle.timingMode, 'unknown');
    assert.equal(idle.isPlaying, false);
}
assert.equal(makeLiveActivitySnapshot({ ...base, isPlaying: false }).title, 'Song', 'Pauses retain the song');
assert.equal(makeLiveActivitySnapshot(base).title, 'Song', 'Playback replaces the static title');
const unicode = makeLiveActivitySnapshot({ ...base, currentTrack: { ...base.currentTrack, title: '👨‍👩‍👧‍👦日本語\\"'.repeat(500) } });
assert(Array.from(unicode.title).length <= 240);
assert(!/[\uD800-\uDBFF]$/.test(unicode.title), 'Do not split UTF-16 surrogate pairs');

// Exercise target generation with the installed Expo SDK's real Xcode template.
// It works on Windows too; no fabricated PBX graph or committed ios folder.
const temporaryRoot = path.join(root, '.expo');
fs.mkdirSync(temporaryRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(temporaryRoot, 'live-activity-check-'));
try {
  const template = path.join(path.dirname(require.resolve('expo/package.json')), 'template.tgz');
  const pbxPath = path.join(fixture, 'project.pbxproj');
  fs.writeFileSync(pbxPath, execFileSync('tar', ['-xOf', template, 'package/ios/HelloWorld.xcodeproj/project.pbxproj']));
  const project = require('xcode').project(pbxPath);
  project.parseSync();
  const { configureProject, configurePodfile, TARGET } = require('../plugins/with-live-activity');
  const templatePodfile = execFileSync('tar', ['-xOf', template, 'package/ios/Podfile'], { encoding: 'utf8' });
  const podfile = configurePodfile(templatePodfile);
  assert.equal(configurePodfile(podfile), podfile, 'Repeat prebuild must not duplicate the widget Podfile target');
  fs.writeFileSync(path.join(fixture, 'Podfile'), podfile);
  const { verifyProject, verifyWidgetSource } = require('./verify-live-activity-project');
  const host = project.getFirstTarget().firstTarget;
  const objects = project.hash.project.objects;
  const firstConfig = objects.XCConfigurationList[host.buildConfigurationList].buildConfigurations[0].value;
  const bundleIdentifier = objects.XCBuildConfiguration[firstConfig].buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replace(/^"|"$/g, '');
  const options = { projectRoot: root, platformProjectRoot: fixture, bundleIdentifier, version: '9.8.7', buildNumber: '987' };
  configureProject(project, options);
  verifyProject(project, fixture, root);
  const widgetSource = fs.readFileSync(path.join(root, 'widgets/KineSyncLyricsActivity.swift'), 'utf8');
  assert.throws(
    () => verifyWidgetSource(widgetSource.replace('KineSyncLyricsActivity()', 'MissingLyricsActivity()')),
    /register KineSyncLyricsActivity/,
    'A widget bundle that omits the Live Activity must fail verification',
  );
  const first = project.writeSync();
  // A separately compiled attributes copy recreates the empty Island regression.
  const extensionTarget = Object.entries(objects.PBXNativeTarget).find(([, target]) => typeof target === 'object' && String(target.name).replace(/^"|"$/g, '') === TARGET);
  const sourcePhase = objects.PBXSourcesBuildPhase[extensionTarget[1].buildPhases.find(({ value }) => objects.PBXSourcesBuildPhase[value]).value];
  const sourceFiles = sourcePhase.files;
  objects.PBXBuildFile.BAD_ATTRIBUTES = { fileRef: 'BAD_ATTRIBUTES_REF' };
  objects.PBXFileReference.BAD_ATTRIBUTES_REF = { path: 'LyricsActivityAttributes.swift' };
  sourcePhase.files = [...sourceFiles, { value: 'BAD_ATTRIBUTES' }];
  assert.throws(() => verifyProject(project, fixture, root), /not define its own module-scoped copy/);
  configureProject(project, options);
  assert.deepEqual(sourcePhase.files, sourceFiles, 'Prebuild must remove the old copied attributes from an existing target');
  delete objects.PBXBuildFile.BAD_ATTRIBUTES;
  delete objects.PBXFileReference.BAD_ATTRIBUTES_REF;
  configureProject(project, options);
  assert.equal(project.writeSync(), first, 'Repeated prebuild must not duplicate targets, sources, or embed phases');
  fs.writeFileSync(pbxPath, first);
  const reloaded = require('xcode').project(pbxPath);
  reloaded.parseSync();
  verifyProject(reloaded, fixture, root);
  const info = require('@expo/plist').default.parse(fs.readFileSync(path.join(fixture, TARGET, 'Info.plist'), 'utf8'));
  assert.equal(info.CFBundleShortVersionString, '9.8.7');
  assert.equal(info.CFBundleVersion, '987');
  // Reject a widget module name that collides with the Expo host pod. The
  // generated ExpoModulesProvider imports KineSyncLiveActivity to find the
  // host Module class; a same-named widget module shadows it in Release builds.
  const extension = Object.values(objects.PBXNativeTarget).find((target) => typeof target === 'object' && String(target.name).replace(/^"|"$/g, '') === TARGET);
  const widgetConfig = objects.XCConfigurationList[extension.buildConfigurationList].buildConfigurations[0].value;
  const settings = objects.XCBuildConfiguration[widgetConfig].buildSettings;
  const moduleName = settings.PRODUCT_MODULE_NAME;
  settings.PRODUCT_MODULE_NAME = 'KineSyncLiveActivity';
  assert.throws(() => verifyProject(project, fixture, root), /must remain distinct/);
  settings.PRODUCT_MODULE_NAME = moduleName;
  // Reject a missing extension embed phase.
  const copy = host.buildPhases.find(({ value }) => objects.PBXCopyFilesBuildPhase?.[value]?.files.length);
  const files = objects.PBXCopyFilesBuildPhase[copy.value].files;
  objects.PBXCopyFilesBuildPhase[copy.value].files = [];
  assert.throws(() => verifyProject(project, fixture, root), /embed the extension/);
  objects.PBXCopyFilesBuildPhase[copy.value].files = files;
} finally {
  // Only remove this script's verified workspace fixture directory.
  assert(path.dirname(fixture) === temporaryRoot && path.basename(fixture).startsWith('live-activity-check-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
const autolinkingBin = path.join(path.dirname(require.resolve('expo-modules-autolinking/package.json')), 'bin/expo-modules-autolinking.js');
const linked = JSON.parse(execFileSync(process.execPath, [autolinkingBin, 'resolve', '--platform', 'apple', '--json'], { cwd: root, encoding: 'utf8' }));
assert(linked.modules.some((module) => module.packageName === 'kinesync-live-activity' && module.modules.some((entry) => entry.class === 'KineSyncLiveActivityModule')), 'Expo must discover the native module');
const liveModule = linked.modules.find((module) => module.packageName === 'kinesync-live-activity');
assert(liveModule.pods.some((pod) => pod.podName === 'KineSyncActivityTypes'), 'Expo must autolink shared activity types into the host');
assert.deepEqual(liveModule.swiftModuleNames, ['KineSyncLiveActivity'], 'Expo provider must import the host module without any widget collision');
console.log('Live Activity checks passed: metadata/source payloads, Expo autolinking, generated widget target, repeat prebuild, and missing-extension detection.');
