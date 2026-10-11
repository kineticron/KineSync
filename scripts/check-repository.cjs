const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function headings(source) {
  const counts = new Map();
  return new Set([...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].trim().replace(/\s+#+$/, '').replace(/<[^>]+>/g, '')
      .toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}

function checkMarkdownLinks(root, file) {
  const errors = [];
  const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  const targets = [...source.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1].replace(/^<|>$/g, ''));
  targets.push(...[...source.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]));
  for (const target of targets) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const [relative, fragment] = target.split('#');
    let destination;
    try { destination = path.resolve(root, path.dirname(file), decodeURIComponent(relative || path.basename(file))); }
    catch { errors.push(`${file}: invalid link ${target}`); continue; }
    const withinRoot = path.relative(root, destination);
    if (withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) {
      errors.push(`${file}: link leaves repository: ${target}`); continue;
    }
    if (!fs.existsSync(destination)) {
      errors.push(`${file}: missing target ${target}`); continue;
    }
    if (fragment && /\.md$/i.test(destination)) {
      const contents = fs.readFileSync(destination, 'utf8');
      const anchors = headings(contents);
      for (const match of contents.matchAll(/(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
      if (!anchors.has(decodeURIComponent(fragment))) errors.push(`${file}: missing anchor ${target}`);
    }
  }
  return errors;
}

function run(root) {
  const errors = [];
  const required = ['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md', 'SECURITY.md',
    'LICENSE', 'ExpoLyrics/LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/README.md',
    '.github/PULL_REQUEST_TEMPLATE.md', '.github/CODEOWNERS', '.github/dependabot.yml'];
  for (const file of required) if (!fs.existsSync(path.join(root, file))) errors.push(`Missing community file: ${file}`);
  const documents = fs.readdirSync(root).filter(file => file.endsWith('.md'));
  for (const directory of ['docs', 'ExpoLyrics/docs', 'scripts', 'RELEASE_NOTES', '.github']) {
    for (const file of fs.readdirSync(path.join(root, directory))) if (file.endsWith('.md')) documents.push(`${directory}/${file}`);
  }
  documents.push('ExpoLyrics/README.md', 'ExpoLyrics/THIRD_PARTY_NOTICES.md', 'DesktopBridge/README.md', 'DesktopBridge/src/lyrics/README.md');
  if (fs.existsSync(path.join(root, 'website/README.md'))) documents.push('website/README.md', 'website/THIRD_PARTY_NOTICES.md');
  for (const file of documents) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (/[—;]/.test(source)) errors.push(`${file}: documentation must not contain em dashes or semicolons`);
    errors.push(...checkMarkdownLinks(root, file));
  }
  for (const file of fs.readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/.test(file))) {
    const source = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    for (const match of source.matchAll(/\buses:\s*([^\s#]+)/g)) {
      if (!match[1].startsWith('./') && !/@[a-f\d]{40}$/i.test(match[1])) errors.push(`${file}: action must use a full commit SHA: ${match[1]}`);
    }
    if (!/^permissions:\s*\n\s+contents: read\s*$/m.test(source)) errors.push(`${file}: default contents permission must be read`);
    if (/^\s*pull_request_target:/m.test(source)) errors.push(`${file}: privileged pull_request_target needs explicit security review`);
  }
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of tracked) {
    if (/\.(?:jks|keystore|pfx|p12|p8)$/i.test(file) || /(^|\/)\.env(?:\.|$)/.test(file) && !/\.example$/.test(file)) {
      errors.push(`Tracked local credential/signing file: ${file}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Repository checks passed: ${documents.length} documents, pinned actions, community files, and tracked secret-file exclusions.`);
}

if (require.main === module) run(path.resolve(__dirname, '..'));
module.exports = { headings, checkMarkdownLinks };
