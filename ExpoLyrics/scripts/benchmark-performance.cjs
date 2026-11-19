/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { runPerformanceBenchmarks } = require('./performance-benchmark-suite.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'components/lyrics/active-line-timeline.ts'), 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, context);
const report = { generatedAt: new Date().toISOString(), runtime: process.version,
  platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  ...runPerformanceBenchmarks(context.exports.createActiveLineTimeline),
};
if (process.argv.includes('--check')) {
  for (const row of report.results.filter(row => row.lineCount >= 1000)) {
    assert.ok(row.optimizedMedianMs < row.baselineMedianMs * 0.8,
      `${row.lineCount}-line lookup must save at least 20% CPU in the same warmed process`);
  }
}
const directory = path.join(root, '../.cache/performance');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'node-benchmark.json'), JSON.stringify(report, null, 2));
console.table(report.results.map(row => ({ lines: row.lineCount,
  before_us: row.baselineUsPerLookup.toFixed(3), after_us: row.optimizedUsPerLookup.toFixed(3),
  speedup: `${row.speedup.toFixed(1)}x`, cpu_reduction: `${row.reductionPercent.toFixed(1)}%`,
  index_build_ms: row.indexBuildMs.toFixed(2),
})));
console.log(report.caveat);
