const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('a version-tag collision stops the actual publisher before GitHub mutations', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-publisher-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bootstrap = path.join(directory, 'mock-gh.sh');
  const log = path.join(directory, 'calls.txt');
  fs.writeFileSync(bootstrap, `gh() {
    printf '%s\\n' "$*" >> "$MOCK_GH_LOG"
    case "$*" in
      *git/ref/heads/main*) printf '%s\\n' "$GITHUB_SHA" ;;
      *git/ref/tags/v*) return 0 ;;
      *commits/v*) printf '%s\\n' 'a-different-published-commit' ;;
      *) printf '%s\\n' 'Unexpected GitHub call' >&2; return 99 ;;
    esac
  }
`);
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const root = path.resolve(__dirname, '../..');
  const result = spawnSync(bash, ['scripts/publish-production-release.sh', 'unused.apk'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BASH_ENV: bootstrap.replaceAll('\\', '/'),
      MOCK_GH_LOG: log.replaceAll('\\', '/'), GITHUB_REPOSITORY: 'example/project', GITHUB_SHA: 'current-commit' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /bump the version/);
  const calls = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /--method (?:POST|PATCH|PUT)|release (?:create|edit|upload)/);
});
