const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRustLyricsGesture } = require('../lib/rust-lyrics-gesture');
const { harness } = require('./check-native-translation-scroll.cjs');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const parse = text => ts.createSourceFile('view.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const evaluate = (code, context) => vm.runInNewContext(ts.transpileModule(`(${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const screen = parse(read('app/(tabs)/index.tsx'));
let zone, press;
function inspect(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(screen) === 'controlsRevealZone') zone = evaluate(node.initializer.getText(screen), {});
  if (ts.isJsxOpeningElement(node) && node.attributes.getText(screen).includes('styles.controlsRevealZone')) {
    press = node.parent.children.find(child => ts.isJsxSelfClosingElement(child) && child.tagName.getText(screen) === 'Pressable');
  }
  ts.forEachChild(node, inspect);
}
inspect(screen);
const revealExpression = press.attributes.properties.find(p => p.name?.text === 'onPress').initializer.expression.getText(screen);
const find = (node, type) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat()) { const result = find(child, type); if (result) return result; }
  return null;
};
module.exports = (async () => {
  for (const backend of ['rust', 'amll-webview', 'spicy-webview', 'amll-skia', 'spicy-skia']) for (const empty of [false, true]) {
    let reveals = 0, seeks = 0, selections = 0, hits = 0, hold;
    const interaction = () => { reveals++; };
    const reveal = evaluate(revealExpression, { handleControlsInteraction: interaction });
    let tap, longPress;
    if (backend === 'rust') {
      let stamp = 0;
      const gesture = createRustLyricsGesture({
        now: () => stamp,
        shouldRevealTap: pageY => pageY >= 600,
        hitTest: () => { hits++; return empty ? -1 : 0; }, scrollBy() {},
        setFollowing() {}, tapEnabled: () => true, onAutoFollowChange() {}, onUserInteraction: interaction,
        onLinePress: () => seeks++, onLineLongPress: () => selections++,
        setTimer: fn => { hold = fn; return 1; }, clearTimer() {},
      });
      tap = async fraction => { gesture.grant(0, 0, fraction * 1000); await Promise.resolve(); await Promise.resolve(); gesture.release(); await Promise.resolve(); };
      longPress = async fraction => { gesture.grant(0, 0, fraction * 1000); stamp += 540; await Promise.resolve(); await Promise.resolve(); hold?.(); gesture.release(); };
    } else if (backend.endsWith('skia')) {
      const h = harness(backend.split('-')[0], 'flash');
      h.render({ tapToSeekEnabled: true, onUserInteraction: interaction, onLinePress: () => seeks++, onLineLongPress: () => selections++ });
      const list = find(h.treeSnapshot(), 'FlashList');
      const row = h.row();
      const handlers = list.props.renderItem({ item: row }).props;
      tap = () => { hits++; if (!empty) handlers.onPress(row); };
      longPress = () => { hits++; if (!empty) handlers.onLongPress(row); };
    } else {
      const ast = parse(read(`components/lyrics/${backend.split('-')[0]}-lyrics-view.tsx`));
      let handler;
      function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleMessage') handler = node.initializer.arguments[0].getText(ast);
        ts.forEachChild(node, visit);
      }
      visit(ast);
      const message = evaluate(handler, { currentSourceKey: { current: 'song' }, sourceKey: 'song', lyrics: empty ? [] : [{}], onUserInteraction: interaction, onLinePress: () => seeks++, onLineLongPress: () => selections++ });
      tap = () => { hits++; message({ nativeEvent: { data: JSON.stringify({ type: 'linePress', index: 0 }) } }); };
      longPress = () => { hits++; message({ nativeEvent: { data: JSON.stringify({ type: 'lineLongPress', index: 0 }) } }); };
    }
    const route = async (fraction, handler) => {
      if (backend === 'rust') await handler(fraction);
      else if (fraction >= parseFloat(zone.top) / 100) reveal();
      else await handler();
    };
    for (const fraction of [.6, .6001, .9]) { await route(fraction, tap); await route(fraction, longPress); }
    assert.deepEqual([reveals, seeks, selections, hits], [backend === 'rust' ? 3 : 6, 0, 0, 0], `${backend}/${empty}: bottom touches cannot reach lyric handlers`);
    await route(.5999, tap); await route(.5999, longPress);
    assert.equal(hits, 2, 'coordinates above the boundary still reach the renderer handlers');
    assert.equal(seeks, empty ? 0 : 1);
    assert.equal(selections, empty ? 0 : 1);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
