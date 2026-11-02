// Compares simulator screenshots between current branch and baseline ref
// Uses pngjs for genuine image decoding, non-blank verification, and pixel comparison

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { reviewPNG } from './simulator-review-png.mjs';
import { nativePNGMetadata } from './simulator-png-metadata.mjs';
import { validateCaptureAttestation } from './simulator-native-capture.mjs';
import { SimulatorLogParser, REQUIRED_STAGES } from './parse-simulator-logs.mjs';

export const REQUIRED_SCREENSHOTS = REQUIRED_STAGES.slice(0, 7).map(s => `${s}.png`);

export function analyzeScreenshotContent(buffer) {
  let png;
  try {
    png = PNG.sync.read(buffer);
  } catch (err) {
    return { width: 0, height: 0, nonBlank: false, variance: 0, error: err.message };
  }
  const { width, height, data } = png;
  const totalPixels = width * height;

  if (totalPixels === 0) {
    return { width: 0, height: 0, nonBlank: false, variance: 0, reason: 'Zero dimensions' };
  }

  let sumLuma = 0;
  let sumLumaSq = 0;
  const colorBuckets = new Set();

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sumLuma += luma;
    sumLumaSq += luma * luma;

    // Sample color bucket every 16 pixels
    if ((i & 0x3f) === 0) {
      const bucket = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      colorBuckets.add(bucket);
    }
  }

  const meanLuma = sumLuma / totalPixels;
  const variance = sumLumaSq / totalPixels - meanLuma * meanLuma;
  const stdDev = Math.sqrt(Math.max(0, variance));

  // A blank/black screen has stdDev near 0 and very few color buckets
  const nonBlank = stdDev >= 3.0 && colorBuckets.size >= 8;

  return {
    width,
    height,
    nonBlank,
    meanLuma: Math.round(meanLuma * 10) / 10,
    stdDev: Math.round(stdDev * 10) / 10,
    uniqueColorBuckets: colorBuckets.size,
  };
}

export function compareScreenshots(branchDir, baselineDir) {
  const results = [];
  if (!fs.existsSync(branchDir)) {
    return { error: `Branch directory not found: ${branchDir}`, results: [] };
  }
  if (!fs.existsSync(baselineDir)) {
    return { error: `Baseline directory not found: ${baselineDir}`, results: [] };
  }

  const branchFiles = fs.readdirSync(branchDir).filter((f) => f.endsWith('.png'));
  if (branchFiles.length === 0) {
    return { error: `No PNG screenshot files found in branch directory: ${branchDir}`, results: [] };
  }

  const baselineFiles = fs.readdirSync(baselineDir).filter(f => f.endsWith('.png'));
  const files = [...new Set([...branchFiles, ...baselineFiles])];
  for (const filename of files) {
    const branchPath = path.join(branchDir, filename);
    const baselinePath = path.join(baselineDir, filename);

    if (!fs.existsSync(branchPath)) {
      results.push({ filename, status: 'MISSING_IN_BRANCH', branchNonBlank: false, baselineNonBlank: false, differenceRatio: 1 });
      continue;
    }
    const branchBuf = fs.readFileSync(branchPath);
    const branchAnalysis = analyzeScreenshotContent(branchBuf);

    if (!fs.existsSync(baselinePath)) {
      results.push({
        filename,
        status: 'NEW_IN_BRANCH',
        branchWidth: branchAnalysis.width,
        branchHeight: branchAnalysis.height,
        branchNonBlank: branchAnalysis.nonBlank,
        baselineWidth: 0,
        baselineHeight: 0,
        differingPixels: 0,
        totalPixels: branchAnalysis.width * branchAnalysis.height,
        differenceRatio: 1.0,
      });
      continue;
    }

    const baselineBuf = fs.readFileSync(baselinePath);
    const baselineAnalysis = analyzeScreenshotContent(baselineBuf);

    if (branchAnalysis.error || baselineAnalysis.error) {
      results.push({ filename, status: 'INVALID_PNG', branchNonBlank: branchAnalysis.nonBlank, baselineNonBlank: baselineAnalysis.nonBlank, differenceRatio: 1 });
      continue;
    }
    const branchPng = PNG.sync.read(branchBuf);
    const baselinePng = PNG.sync.read(baselineBuf);

    if (branchPng.width !== baselinePng.width || branchPng.height !== baselinePng.height) {
      results.push({
        filename,
        status: 'DIMENSION_MISMATCH',
        branchWidth: branchPng.width,
        branchHeight: branchPng.height,
        branchNonBlank: branchAnalysis.nonBlank,
        baselineNonBlank: baselineAnalysis.nonBlank,
        baselineWidth: baselinePng.width,
        baselineHeight: baselinePng.height,
        differingPixels: 0,
        totalPixels: branchPng.width * branchPng.height,
        differenceRatio: 1.0,
      });
      continue;
    }

    const totalPixels = branchPng.width * branchPng.height;
    let diffPixels = 0;
    const len = branchPng.data.length;

    // Tolerance of 16/1020 allows for minor subpixel/rasterization font variations
    const COLOR_TOLERANCE = 16;

    for (let i = 0; i < len; i += 4) {
      const dr = Math.abs(branchPng.data[i] - baselinePng.data[i]);
      const dg = Math.abs(branchPng.data[i + 1] - baselinePng.data[i + 1]);
      const db = Math.abs(branchPng.data[i + 2] - baselinePng.data[i + 2]);
      const da = Math.abs(branchPng.data[i + 3] - baselinePng.data[i + 3]);
      if (dr + dg + db + da > COLOR_TOLERANCE) {
        diffPixels++;
      }
    }

    const diffRatio = totalPixels > 0 ? diffPixels / totalPixels : 0;
    const isIdentical = diffPixels === 0;

    results.push({
      filename,
      status: isIdentical ? 'IDENTICAL' : 'DIFFERENT',
      branchWidth: branchPng.width,
      branchHeight: branchPng.height,
      branchNonBlank: branchAnalysis.nonBlank,
      baselineNonBlank: baselineAnalysis.nonBlank,
      baselineWidth: baselinePng.width,
      baselineHeight: baselinePng.height,
      differingPixels: diffPixels,
      totalPixels,
      differenceRatio: diffRatio,
    });
  }

  return { error: null, results };
}

export function generateComparisonMarkdown(comparison, baselineRef = 'baseline') {
  const lines = [
    '# Baseline vs Branch Screenshot Comparison',
    '',
    `Baseline reference: ${baselineRef}`,
    '',
    '## Visual Snapshot Differences',
    '',
    '| Image | Status | Dimensions | Differing Pixels | Divergence | Real Content |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  if (comparison.error) {
    lines.push(`| Error | ${comparison.error} | - | - | - | - |`);
  } else if (comparison.results.length === 0) {
    lines.push('| None | No screenshots found to compare | - | - | - | - |');
  } else {
    for (const r of comparison.results) {
      const diffPct = `${Math.round(r.differenceRatio * 100)}%`;
      const dims = `${r.branchWidth}x${r.branchHeight}`;
      const nonBlank = r.branchNonBlank ? 'Confirmed' : 'BLANK';
      lines.push(`| ${r.filename} | ${r.status} | ${dims} | ${r.differingPixels} / ${r.totalPixels} | ${diffPct} | ${nonBlank} |`);
    }
  }

  lines.push(
    '',
    '## Documentation of Comparison Limits',
    '',
    '* When the baseline reference lacks the simulator test harness, the test harness files are applied to the baseline workspace for visual testing.',
    '* Baseline harness integration must apply successfully. Incompatible baselines fail closed.',
    '* Acceptance requires all seven authentic nonblank review image pairs, orientation-correct landscape copies, untouched native originals and conversion provenance. Pixel differences are advisory; Kat reviews artifacts afterwards.',
    '* Minor anti-aliasing and subpixel differences across independent builds can result in non-zero byte divergence even when layouts match visually.',
    '',
  );

  return lines.join('\n');
}

export function validateComparison(comparison) {
  const failures = [];
  if (comparison.error) failures.push(comparison.error);
  const names = comparison.results.map(r => r.filename);
  if (names.length !== REQUIRED_SCREENSHOTS.length || REQUIRED_SCREENSHOTS.some(f => !names.includes(f))) failures.push('Expected exactly seven screenshot pairs');
  for (const r of comparison.results) {
    if (!['branchWidth', 'branchHeight', 'baselineWidth', 'baselineHeight'].every(key => Number.isInteger(r[key]) && r[key] > 0)) failures.push(`Invalid screenshot dimensions: ${r.filename}`);
    const landscape = r.filename === 'stage_7_rotation.png';
    if (landscape ? r.branchWidth <= r.branchHeight || r.baselineWidth <= r.baselineHeight : r.branchHeight <= r.branchWidth || r.baselineHeight <= r.baselineWidth) failures.push(`Invalid native screenshot orientation: ${r.filename}`);
    if (!['IDENTICAL', 'DIFFERENT', 'DIMENSION_MISMATCH'].includes(r.status) || !r.branchNonBlank || !r.baselineNonBlank) failures.push(`Screenshot acceptance failed: ${r.filename} (${r.status})`);
  }
  return failures;
}

// Re-parse observed protocol and cross-check its full metrics against exported records.
// A visually identical failed run must never produce a passing comparison.
export function validateRunArtifacts(directory) {
  const failures = [];
  try {
    const parser = new SimulatorLogParser();
    const raw = fs.readFileSync(path.join(directory, 'simulator-raw-log.txt'), 'utf8');
    for (const line of raw.split('\n')) parser.processLine(line);
    failures.push(...parser.validateAssertions());
    const perf = JSON.parse(fs.readFileSync(path.join(directory, 'simulator-perf.json')));
    for (const [key, value] of Object.entries({ summary: parser.summary && Object.fromEntries(Object.entries(parser.summary).filter(([key]) => key !== 'heartbeat')), stages: parser.stages, renderers: [...parser.renderers] })) {
      if (JSON.stringify(key === 'summary' && perf[key] ? Object.fromEntries(Object.entries(perf[key]).filter(([field]) => field !== 'heartbeat')) : perf[key]) !== JSON.stringify(value)) failures.push(`Exported ${key} contradicts protocol`);
    }
    if (perf.landscapeConfirmed !== true || perf.portraitConfirmed !== true || perf.nativePortraitRestored !== true ||
        !Array.isArray(perf.assertionFailures) || perf.assertionFailures.length) failures.push('Run did not pass all capture/scenario assertions');
    const run = raw.match(/\[KINESYNC_SIM\] SCENARIO_START token=([\w]+)/)?.[1];
    const captures = fs.readFileSync(path.join(directory, 'native-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const first = captures[0];
    const ids = new Set();
    for (const capture of captures) {
      // capture.id and before.id alias one observation; after.id is a second nonce.
      // One set covers every phase and stage, including portrait restoration.
      for (const id of [capture.id, capture.after?.id]) {
        if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) || ids.has(id.toLowerCase())) failures.push('Invalid or reused native capture nonce');
        else ids.add(id.toLowerCase());
      }
      if (!run || capture.run !== run || capture.token !== `${run}_${capture.stage}` || capture.error ||
          !capture.id || !first?.session || capture.session !== first.session || !first.udid || capture.udid !== first.udid) failures.push('Invalid native capture ownership');
      if (capture.stage === 'stage_7_rotation' && capture.source !== 'XCUIWindow') failures.push('Landscape requires native window provenance');
      if (!['XCUIScreen', 'XCUIWindow'].includes(capture.source) || !capture.before || !capture.after || capture.before.id !== capture.id || capture.after.id === capture.id || capture.before.phase !== 'before' || capture.after.phase !== 'after') failures.push('Missing native foreground attestations');
      else for (const observed of [capture.before, capture.after]) {
        validateCaptureAttestation(observed, { session: capture.session, id: observed.id, run: capture.run, stage: capture.stage, token: capture.token, orientation: capture.orientation, udid: capture.udid, phase: observed.phase }, capture.udid);
      }
    }
    for (const stage of [...REQUIRED_STAGES.slice(0, 7), 'stage_7_restore']) {
      const last = captures.filter(capture => capture.stage === stage).at(-1);
      const file = stage === 'stage_7_restore' ? 'diagnostics/restored-portrait.png' : `${stage}.png`;
      const bytes = fs.readFileSync(path.join(directory, file));
      const image = PNG.sync.read(bytes);
      if (!analyzeScreenshotContent(bytes).nonBlank) failures.push(`Blank native capture: ${stage}`);
      const orientation = stage === 'stage_7_rotation' ? 'landscape' : 'portrait';
      if (!last || last.orientation !== orientation || !/^originals\/[a-f0-9-]{36}\.png$/i.test(last.originalFile || '')) { failures.push(`Missing original capture: ${stage}`); continue; }
      const original = fs.readFileSync(path.join(directory, last.originalFile));
      const native = PNG.sync.read(original), metadata = nativePNGMetadata(original);
      const review = reviewPNG(original, orientation);
      if (last.sha256 !== createHash('sha256').update(original).digest('hex') || last.width !== native.width || last.height !== native.height || last.exifOrientation !== metadata.exifOrientation ||
          JSON.stringify(last.review) !== JSON.stringify({ ...review.conversion, outputSHA256: createHash('sha256').update(bytes).digest('hex') }) || !image.data.equals(PNG.sync.read(review.bytes).data) ||
          (orientation === 'landscape' ? image.width <= image.height : image.height <= image.width)) failures.push(`Missing or mismatched native/review conversion: ${stage}`);
    }
    return failures;
  } catch (error) { return [...failures, `Incomplete run artifacts: ${error.message}`]; }
}

// CLI entrypoint
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const branchDirIndex = process.argv.indexOf('--branch-dir');
  const baselineDirIndex = process.argv.indexOf('--baseline-dir');
  const outputIndex = process.argv.indexOf('--output');
  const baselineRefIndex = process.argv.indexOf('--baseline-ref');

  const branchDir = branchDirIndex >= 0 ? process.argv[branchDirIndex + 1] : '.expo/simulator-test-output';
  const baselineDir = baselineDirIndex >= 0 ? process.argv[baselineDirIndex + 1] : '.expo/baseline-test-output';
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const baselineRef = baselineRefIndex >= 0 ? process.argv[baselineRefIndex + 1] : 'baseline';

  const comparison = compareScreenshots(branchDir, baselineDir);
  const markdown = generateComparisonMarkdown(comparison, baselineRef);

  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, markdown, 'utf8');
    const manifest = { baseline: baselineRef, review: 'Review copies may be EXIF-oriented. Untouched originals and conversion records accompany them. Kat reviews externally; no visual verdict', nativeOriginals: { candidate: path.relative(path.dirname(output), path.join(branchDir, 'originals')), main: path.relative(path.dirname(output), path.join(baselineDir, 'originals')) }, captureLedgers: { candidate: path.relative(path.dirname(output), path.join(branchDir, 'native-captures.jsonl')), main: path.relative(path.dirname(output), path.join(baselineDir, 'native-captures.jsonl')) }, stages: REQUIRED_SCREENSHOTS.map(filename => ({ filename, kind: 'review-copy', candidate: path.relative(path.dirname(output), path.join(branchDir, filename)), main: path.relative(path.dirname(output), path.join(baselineDir, filename)) })) };
    fs.writeFileSync(`${output}.manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(`Wrote screenshot comparison report to ${output}`);
  } else {
    console.log(markdown);
  }

  const failures = [...validateComparison(comparison),
    ...validateRunArtifacts(branchDir).map(f => `Candidate: ${f}`),
    ...validateRunArtifacts(baselineDir).map(f => `Baseline: ${f}`)];
  if (failures.length && output) fs.appendFileSync(output, '\n## Run acceptance failures\n\n' + failures.map(f => `* ${f}`).join('\n') + '\n');
  if (failures.length) {
    console.error(`[COMPARATOR] ${failures.join('\n')}`);
    process.exit(1);
  }
}
