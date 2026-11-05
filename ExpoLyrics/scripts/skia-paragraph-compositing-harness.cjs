/* global __dirname */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { buildSync } = require('esbuild');
const installed = path.dirname(require.resolve('@shopify/react-native-skia/package.json'));
const imports = {
  visit: 'sksg/Recorder/Visitor', Recorder: 'sksg/Recorder/Recorder', replay: 'sksg/Recorder/Player',
  createDrawingContext: 'sksg/Recorder/DrawingContext', Group: 'renderer/components/Group', Glyphs: 'renderer/components/text/Glyphs', Paint: 'renderer/components/Paint',
};
const code = buildSync({ stdin: { contents: Object.entries(imports).map(([name, file]) =>
  `export {${name}} from ${JSON.stringify(path.join(installed, 'src', file))};`).join('\n'), resolveDir: __dirname },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-native', 'react-native-reanimated'] }).outputFiles[0].text;
const compiled = new Module(__filename, module);
compiled.filename = __filename;
compiled.paths = module.paths;
compiled._compile(code, __filename);
const renderer = compiled.exports;
const numeric = value => value && typeof value === 'object' && 'value' in value ? value.value : value;

// Only the native canvas/paint/paragraph boundaries are mocked. Group expansion,
// traversal, recording, paint stacks and playback come from the installed Skia.
function paragraphComposite(group) {
  const layers = [{ alpha: 1, samples: [] }];
  const layerAlphas = [];
  const canvas = {
    saveLayer(paint) {
      const alpha = paint?.getAlphaf() ?? 1;
      layerAlphas.push(alpha);
      layers.push({ alpha, samples: [] });
    },
    restore() {
      assert(layers.length > 1, 'balanced native canvas layers');
      const layer = layers.pop();
      layers.at(-1).samples.push(...layer.samples.map(sample => ({ ...sample, alpha: sample.alpha * layer.alpha })));
    },
    drawGlyphs(_glyphs, _positions, _x, _y, _font, paint) { this.paragraph('main', paint.getAlphaf()); },
    paragraph(label, alpha) { layers.at(-1).samples.push({ label, alpha }); },
  };
  const makePaint = () => ({ alpha: 1, getAlphaf() { return this.alpha; }, setAlphaf(value) { this.alpha = value; },
    copy() { const next = makePaint(); next.assign(this); return next; }, assign(other) { this.alpha = other.alpha; },
    setShader() {}, setColor() {}, setAntiAlias() {}, dispose() {} });
  const paragraph = (label, alpha) => ({ layout() {}, paint(target) { target.paragraph(label, alpha); } });
  function element(node) {
    if (!node || typeof node !== 'object') return null;
    const { children, layer, ...props } = node.props;
    if ('opacity' in props) props.opacity = numeric(props.opacity);
    if (layer) props.layer = typeof layer === 'object' && layer.type ? element(layer) : layer;
    if (node.type === 'Paragraph') props.paragraph = paragraph('main', 1);
    const type = { Group: renderer.Group, Glyphs: renderer.Glyphs, Paint: renderer.Paint, Paragraph: 'skParagraph' }[node.type];
    assert(type, `unexpected isolated paragraph host ${node.type}`);
    return React.createElement(type, props, ...[children].flat().map(element));
  }
  function expand(element) {
    if (!element) return null;
    if (typeof element.type === 'function') return expand(element.type(element.props));
    const { children, ...props } = element.props;
    return { type: element.type, props, children: React.Children.toArray(children).map(expand).filter(Boolean) };
  }
  const root = [expand(element(group)), { type: 'skParagraph', props: { paragraph: paragraph('translation', 0.3), x: 0, y: 0, width: 100 }, children: [] }];
  const recorder = new renderer.Recorder();
  renderer.visit(recorder, root);
  const context = renderer.createDrawingContext({ Paint: makePaint, Color: value => value }, [], canvas);
  renderer.replay(context, recorder.getRecording().commands);
  context.dispose();
  assert.equal(layers.length, 1, 'layer restored before translation sibling');
  assert.equal(layers[0].samples.find(sample => sample.label === 'translation').alpha, 0.3, 'inactive alpha never dims translation sibling');
  return { alpha: layers[0].samples.find(sample => sample.label === 'main').alpha, layerAlphas };
}
module.exports = { paragraphComposite };
