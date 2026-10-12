const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { headings, checkMarkdownLinks } = require('../check-repository.cjs');

test('documentation checks resolve links and reject broken files, anchors, and escapes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'guide.md'), '# Setup (advanced)\n## Same\n## Same\n');
  fs.writeFileSync(path.join(root, 'README.md'), '[Guide](guide.md#setup-advanced)\n[Second](guide.md#same-1)\n[External](https://example.com)\n```md\n[Example](not-real.md)\n```\n');
  assert.deepEqual(checkMarkdownLinks(root, 'README.md'), []);
  fs.appendFileSync(path.join(root, 'README.md'), '[Bad](missing.md)\n[Anchor](guide.md#absent)\n[Escape](../outside.md)\n');
  const errors = checkMarkdownLinks(root, 'README.md');
  assert.equal(errors.length, 3);
  assert.match(errors[0], /missing target/);
  assert.match(errors[1], /missing anchor/);
  assert.match(errors[2], /leaves repository/);
  assert.ok(headings('# Développement / Setup').has('développement--setup'));
});
