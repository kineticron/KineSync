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
for (const source of ['KineSyncLiveActivityModule.swift', 'LyricsActivityAttributes.swift', 'KineSyncLiveActivity.podspec']) {
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
const snapshot = makeLiveActivitySnapshot(base, 11250, 100000);
assert.equal(snapshot.positionMs, 2250, 'Project native clock from monotonic anchor, not stale UI clock');
assert.equal(snapshot.lines[0].text, 'Hello world');
assert.equal(snapshot.timingMode, 'karaoke');
assert.equal(snapshot.source, 'Spicy · Karaoke');
assert.equal(snapshot.status, 'Fetched 1 lines');
assert.equal(makeLiveActivitySnapshot({ ...base, isPlaying: false }, 11250, 100000).positionMs, 1000);
assert.equal(makeLiveActivitySnapshot(base, 999999, 100000).positionMs, 120000);
assert.equal(makeLiveActivitySnapshot({ ...base, anchorPositionMs: 50000, anchorMonotonicMs: 11250 }, 11250, 100000).positionMs, 50000, 'Seeks replace the anchor');
assert.equal(liveActivityInputChanged({ ...base, playbackPosition: 2000 }, base), false, '10 Hz UI ticks must not publish ActivityKit updates');
assert.equal(liveActivityInputChanged({ ...base, isPlaying: false }, base), true);
assert.equal(liveActivityInputChanged({ ...base, lyricsSource: 'spicy-lyrics-line' }, base), true);
assert.equal(makeLiveActivitySnapshot({ ...base, lyricsSource: 'spicy-lyrics-line' }, 0, 0).timingMode, 'interpolated');
assert.equal(makeLiveActivitySnapshot({ ...base, lyrics: [{ lineStartTime: 0, lineEndTime: 0, syllables: [{ text: 'Plain lyrics', startTime: 0, endTime: 0 }] }] }, 0, 0).timingMode, 'static');
assert.equal(makeLiveActivitySnapshot({ ...base, currentTrack: null }, 0, 0).trackId, '');
assert.equal(makeLiveActivitySnapshot({ ...base, currentTrack: null }, 0, 0).isPlaying, false);
assert.equal(makeLiveActivitySnapshot({ ...base, playbackMode: 'desktop' }, 0, 0).trackId, '', 'End activities on desktop disconnect');
assert.equal(makeLiveActivitySnapshot(base, 0, 0, false).lines, undefined, 'Clock corrections must not resend the entire timeline');
assert.deepEqual(makeLiveActivitySnapshot({ ...base, lyrics: [{ ...base.lyrics[0], lineStartTime: NaN }] }, 0, 0).lines, []);
const unicode = makeLiveActivitySnapshot({ ...base, currentTrack: { ...base.currentTrack, title: '👨‍👩‍👧‍👦日本語\\"'.repeat(500) } }, 0, 0);
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
  const { configureProject, TARGET } = require('../plugins/with-live-activity');
  const { verifyProject } = require('./verify-live-activity-project');
  const host = project.getFirstTarget().firstTarget;
  const objects = project.hash.project.objects;
  const firstConfig = objects.XCConfigurationList[host.buildConfigurationList].buildConfigurations[0].value;
  const bundleIdentifier = objects.XCBuildConfiguration[firstConfig].buildSettings.PRODUCT_BUNDLE_IDENTIFIER.replace(/^"|"$/g, '');
  const options = { projectRoot: root, platformProjectRoot: fixture, bundleIdentifier, version: '9.8.7', buildNumber: '987' };
  configureProject(project, options);
  verifyProject(project, fixture, root);
  const first = project.writeSync();
  configureProject(project, options);
  assert.equal(project.writeSync(), first, 'Repeated prebuild must not duplicate targets, sources, or embed phases');
  fs.writeFileSync(pbxPath, first);
  const reloaded = require('xcode').project(pbxPath);
  reloaded.parseSync();
  verifyProject(reloaded, fixture, root);
  const info = require('@expo/plist').default.parse(fs.readFileSync(path.join(fixture, TARGET, 'Info.plist'), 'utf8'));
  assert.equal(info.CFBundleShortVersionString, '9.8.7');
  assert.equal(info.CFBundleVersion, '987');
  // Prove the verifier rejects the original invisible-widget failure mode.
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
console.log('Live Activity checks passed: timing, lyrics/source payloads, Expo autolinking, generated widget target, repeat prebuild, and missing-extension detection.');
