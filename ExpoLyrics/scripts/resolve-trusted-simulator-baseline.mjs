// Only history reachable from the repository's trusted main may execute baseline builds.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveTrustedBaseline(ref, cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!ref || ref.startsWith('-')) throw new Error('Invalid baseline ref');
  if (!/^[0-9a-fA-F]{40}$/.test(ref)) git(['check-ref-format', '--branch', ref]);
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') git(['fetch', '--unshallow', '--no-tags', 'origin', 'main']);
  git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  git(['fetch', '--no-tags', 'origin', '--', ref]);
  const commit = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  try { git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']); }
  catch { throw new Error('Untrusted baseline: commit must be reachable from origin/main'); }
  return commit;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(resolveTrustedBaseline(process.argv[2])); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
