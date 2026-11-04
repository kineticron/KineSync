// Runs only from the frozen harness checkout. Source refs were resolved by the trusted resolver.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareBaselineHarness } from './prepare-baseline-harness.mjs';
import { nativeIdentity, digest, sha256, treeManifest, writeJson, nativeCacheToken } from './simulator-app-reuse.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stateDir = path.join(root, 'ExpoLyrics/.expo/pair');
fs.mkdirSync(stateDir, { recursive: true });
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000 }).trim();
const toolchain = {
  xcode: capture('xcodebuild', ['-version']), sdk: capture('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']),
  clang: capture('xcrun', ['clang', '--version']),
  clangHash: sha256(fs.readFileSync(capture('xcrun', ['--sdk', 'iphonesimulator', '-f', 'clang']))),
  sdkSettingsHash: sha256(fs.readFileSync(path.join(capture('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']), 'SDKSettings.json'))),
  host: capture('sw_vers', []), ruby: capture('ruby', ['--version']), pods: capture('pod', ['--version']), node: process.version,
  ccache: capture('ccache', ['--version']), arch: capture('uname', ['-m']), developer: process.env.DEVELOPER_DIR,
};
if (toolchain.arch !== 'arm64' || !toolchain.xcode.startsWith('Xcode 26.6\n') || toolchain.sdk !== '26.5') throw new Error('Unsupported native toolchain');
const overlay = Object.fromEntries(['lib/fixtures/simulator-test-fixtures.ts', 'lib/simulator-playback-clock.ts', 'lib/simulator-test-bridge.ts', 'lib/simulator-test-harness.ts', 'components/simulator-test-controller.tsx'].map(name => [name, sha256(fs.readFileSync(path.join(root, 'ExpoLyrics', name)))]));
const context = { toolchain,
  // Shared path namespace preserves canonical-path compatibility without coupling native identities.
  sourceRoots: ['baseline', 'candidate'].map(variant => path.resolve(root, `../kinesync-source-${variant}/ExpoLyrics`)),
  harness: digest({ scripts: treeManifest(path.join(root, 'ExpoLyrics/scripts')), overlay }),
  build: 'Release-arm64-no-dsym-external-bundle-v1',
  env: { CI: '1', EXPO_PUBLIC_SIMULATOR_TEST: '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: 'release-arm64', USE_CCACHE: '1', CCACHE_COMPILERCHECK: 'content', EXPO_NO_DOTENV: '1' },
};
const harnessSha = capture('git', ['-C', root, 'rev-parse', 'HEAD']);
if (process.env.GITHUB_SHA && harnessSha !== process.env.GITHUB_SHA) throw new Error('Harness checkout does not match the workflow SHA');
const variants = {};
const sourceRefs = { baseline: process.env.BASELINE_SHA, candidate: process.env.CANDIDATE_SHA };
for (const variant of ['baseline', 'candidate']) {
  const sourceSha = sourceRefs[variant];
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('Missing exact source SHA');
  const directory = path.resolve(root, `../kinesync-source-${variant}`);
  run('git', ['fetch', '--no-tags', 'origin', sourceSha]);
  if (capture('git', ['-C', root, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']) !== sourceSha) throw new Error('Fetched source SHA differs');
  run('git', ['worktree', 'add', '--detach', directory, sourceSha]);
  prepareBaselineHarness({ candidateDir: root, baselineDir: directory });
  const project = path.join(directory, 'ExpoLyrics');
  // Source checkout is exact and overlays are restricted to the existing trusted adapter.
  run('npm', ['ci'], project);
  variants[variant] = { directory, project, variant, sourceSha, harnessSha, identity: await nativeIdentity(project, context) };
  writeJson(path.join(stateDir, `${variant}-fingerprint.json`), variants[variant].identity);
}
const compilerKey = digest({ toolchain, harness: context.harness,
  roots: Object.values(variants).map(v => v.project), compilerCheck: 'content', maxSize: '512M' });
writeJson(path.join(stateDir, 'plan.json'), { variants, context, compilerKey });
for (const [variant, source] of Object.entries(variants)) {
  const token = nativeCacheToken(source.identity);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${variant}_key=${token || ''}\n`);
}
fs.appendFileSync(process.env.GITHUB_OUTPUT, `compiler_key=${compilerKey}\n`);
