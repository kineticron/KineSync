const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../lib/spotify-browser.ts'), 'utf8');

// Evaluate the exported templates with the build flag set before injecting them into the mock page.
module.exports = function loadSpotifyBrowser(development) {
  const browser = { exports: {} };
  const compiled = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    define: { __DEV__: String(development) },
    minifySyntax: true,
  }).code;
  vm.runInNewContext(compiled, { module: browser, exports: browser.exports });
  return browser.exports;
};
