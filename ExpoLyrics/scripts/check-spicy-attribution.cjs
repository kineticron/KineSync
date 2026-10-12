const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { lyricsToTtml } = require('../lib/lyrics-ttml-export');
const { parseTtmlToLyrics } = require('../lib/lyrics-ttml-import');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(root, file), 'utf8');
const profiles = {
  Maker: { username: 'maker', url: 'https://spicylyrics.org/uid/123' },
  Uploader: { username: 'uploader', url: 'https://spicylyrics.org/uid/456' },
};
const payload = { source: 'spicy_lyrics', UploadAttribution: profiles };
let attribution;
for (const file of ['../DesktopBridge/src/lyrics/parts/01c-fingerprinting.js', 'lib/mobile-lyrics-service.js']) {
  const source = read(file);
  const helper = source.slice(source.indexOf('function extractSpicyPayloadMetadata('), source.indexOf('function extractSpicyLeadVocalPlainText('));
  const context = vm.createContext({ payload });
  vm.runInContext(helper, context);
  attribution = vm.runInContext('extractSpicyPayloadMetadata(payload).attribution', context);
  assert.equal(attribution.maker.url, profiles.Maker.url);
  assert.equal(attribution.uploader.url, profiles.Uploader.url);
  context.payload = { source: 'spl', TTMLUploadMetadata: {
    Maker: { ...profiles.Maker, url: `  ${profiles.Maker.url}  ` },
    Uploader: { ...profiles.Uploader, url: 'javascript:alert(1)' },
  } };
  const legacy = vm.runInContext('extractSpicyPayloadMetadata(payload).attribution', context);
  assert.equal(legacy.maker.url, profiles.Maker.url, 'trim URLs before validation');
  assert.equal(legacy.uploader.url, undefined, 'unsafe URLs stay unlinked');
  context.payload = { ...payload, source: 'apple_music' };
  const official = vm.runInContext('extractSpicyPayloadMetadata(payload).attribution', context);
  assert.equal(official.maker, undefined);
  assert.equal(official.uploader, undefined);
}
const xml = lyricsToTtml({ lyrics: [{ lineStartTime: 0, lineEndTime: 1000,
  syllables: [{ text: 'Hello', startTime: 0, endTime: 1000 }] }], metadata: { attribution } });
assert.deepEqual(parseTtmlToLyrics(xml).metadata.attribution, JSON.parse(JSON.stringify(attribution)), 'TTML preserves contributor URLs');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.events = {}; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, handler) { this.events[type] = handler; }
}
class Anchor extends Element {}
const descendants = node => Array.isArray(node) ? node.flatMap(descendants)
  : node ? [node, ...(node.children || []).flatMap(descendants)] : [];
for (const file of ['amll-webview-entry.ts', 'spicy-webview-entry.ts']) {
  const source = read(`components/lyrics/${file}`);
  const start = source.indexOf('function appendCreditsContent(');
  const end = source.indexOf('\nfunction ', start + 1);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const messages = [];
  const context = vm.createContext({
    HTMLAnchorElement: Anchor,
    document: { createElement: tag => tag === 'a' ? new Anchor(tag) : new Element(tag), createTextNode: textContent => ({ textContent }) },
    post: message => messages.push(message),
  });
  vm.runInContext(js, context);
  const container = new Element('div');
  context.appendCreditsContent(container, [], attribution);
  const anchors = descendants(container).filter(node => node instanceof Anchor);
  assert.deepEqual(anchors.map(node => [node.textContent, node.href]), [
    ['@maker', profiles.Maker.url], ['@uploader', profiles.Uploader.url],
  ]);
  for (const anchor of anchors) {
    let prevented = false;
    let stopped = false;
    anchor.events.click({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.ok(prevented && stopped, 'profile clicks must not trigger lyric seeking');
    assert.equal(messages.at(-1).url, anchor.href);
    assert.equal(messages.at(-1).type, 'attributionLink');
  }
  const uploaderOnly = new Element('div');
  context.appendCreditsContent(uploaderOnly, [], { uploader: attribution.uploader });
  assert.ok(descendants(uploaderOnly).some(node => node.textContent === 'Uploaded By: '));
}

// Render the native footer with lightweight host elements and exercise its actual handlers.
const nativeSource = read('components/lyrics/native/native-lyrics-view.tsx');
const footer = nativeSource.slice(nativeSource.indexOf('const footer = useMemo('), nativeSource.indexOf('const retryFlatScroll ='));
const nativeJs = ts.transpileModule(`${footer}\nresult = footer;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
const opened = [];
const context = vm.createContext({
  result: null,
  React: { createElement: (tag, props, ...children) => ({ tag, props, children }) },
  Pressable: 'Pressable', Text: 'Text', Image: 'Image', useMemo: callback => callback(),
  metadata: { attribution }, styles: { profileLink: { textDecorationLine: 'underline' } },
  landscapeMode: false, lyrics: [], onCreditsTimestampPress: undefined, onUserInteraction: undefined,
  Linking: { openURL(url) { opened.push(url); return Promise.resolve(); } },
});
vm.runInContext(nativeJs, context);
const nativeLinks = descendants(context.result).filter(node => node?.props?.accessibilityRole === 'link');
assert.equal(nativeLinks.length, 2);
for (const link of nativeLinks) {
  let stopped = false;
  link.props.onPress({ stopPropagation() { stopped = true; } });
  assert.ok(stopped);
}
assert.deepEqual(opened, [profiles.Maker.url, profiles.Uploader.url]);
console.log('Spicy contributor links, native accessibility, and TTML attribution checks passed.');
