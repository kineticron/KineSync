import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

// Exercise the runner shell resolution with spaces, then compare
// action inputs to the destinations used by the native and DerivedData producers.
const temporary = fs.mkdtempSync('/tmp/cache-contract-');
try {
  const parent = path.join(temporary, 'runner work');
  const workspace = path.join(parent, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  const resolved = execFileSync('bash', ['-c', 'cd "$GITHUB_WORKSPACE/.." && pwd -P'], {
    env: { ...process.env, GITHUB_WORKSPACE: workspace }, encoding: 'utf8',
  }).trim();
  assert.equal(resolved, fs.realpathSync(parent));
  const workflows = path.resolve(import.meta.dirname, '../../.github/workflows');
  for (const file of fs.readdirSync(workflows).filter(file => /\.ya?ml$/.test(file))) {
    const workflow = YAML.parse(fs.readFileSync(path.join(workflows, file), 'utf8'));
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
      if (!/actions\/(cache|upload-artifact|upload-pages-artifact)(\/|@)/.test(step.uses ?? '')) continue;
      for (const entry of (step.with?.path ?? '').split('\n').filter(Boolean)) {
        assert.ok(!/(^|\/)\.{1,2}(\/|$)/.test(entry), `${file}: ${step.name}: ${entry}`);
      }
    }
  }
  for (const producer of ['build-simulator-pair.mjs', 'inspect-simulator-cache.mjs']) {
    assert.match(fs.readFileSync(path.join(import.meta.dirname, producer), 'utf8'), /path\.resolve\(root, '\.\.\/kinesync-native-cache'\)/);
  }
  const simulator = YAML.parse(fs.readFileSync(path.join(workflows, 'ios-simulator-test.yml'), 'utf8'));
  for (const step of simulator.jobs['native-apps'].steps.filter(step => /actions\/cache\//.test(step.uses ?? ''))) {
    const actual = step.with.path.replace('${{ env.CCACHE_BASEDIR }}', resolved)
      .replace('${{ env.CCACHE_DIR }}', path.join(resolved, 'kinesync-ios-ccache'))
      .replace(/\$\{\{ steps.pair.outputs.(baseline|candidate)_key \}\}/, 'identity');
    assert.equal(actual, path.resolve(workspace, step.with.path.includes('native-cache')
      ? '../kinesync-native-cache/identity' : '../kinesync-ios-ccache'));
  }
  for (const [file, suffix] of [['ios-development-build', '-debug'], ['ios-unsigned-ipa', '']]) {
    const workflow = YAML.parse(fs.readFileSync(path.join(workflows, `${file}.yml`), 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const setup = steps.find(step => step.name === 'Resolve cache producer destination');
    const envFile = path.join(temporary, `env${suffix}`);
    execFileSync('bash', ['-eu', '-c', setup.run], { env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_ENV: envFile } });
    assert.equal(fs.readFileSync(envFile, 'utf8').trim(), `IOS_DERIVED_DATA=${path.resolve(workspace, `../kinesync-ios-derived${suffix}`)}`);
    assert.ok(steps.some(step => step.with?.path?.includes('${{ env.IOS_DERIVED_DATA }}')));
    assert.ok(steps.some(step => step.env?.DERIVED_DATA_PATH === '${{ env.IOS_DERIVED_DATA }}'));
  }
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
console.log('Cache/upload path contracts passed');
