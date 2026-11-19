// Compares simulator screenshots between current branch and baseline ref
// Uses pngjs for genuine image decoding, non-blank verification, and pixel comparison

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { REQUIRED_STAGES } from './parse-simulator-logs.mjs';

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
    '* Acceptance requires all seven nonblank image pairs with matching dimensions. The default maximum differing-pixel ratio is zero after channel tolerance.',
    '* Minor anti-aliasing and subpixel differences across independent builds can result in non-zero byte divergence even when layouts match visually.',
    '',
  );

  return lines.join('\n');
}

export function validateComparison(comparison, maxDifferenceRatio = 0) {
  const failures = [];
  if (!Number.isFinite(maxDifferenceRatio) || maxDifferenceRatio < 0 || maxDifferenceRatio > 1) return ['Invalid maximum difference ratio'];
  if (comparison.error) failures.push(comparison.error);
  const names = comparison.results.map(r => r.filename);
  if (names.length !== REQUIRED_SCREENSHOTS.length || REQUIRED_SCREENSHOTS.some(f => !names.includes(f))) failures.push('Expected exactly seven screenshot pairs');
  for (const r of comparison.results) {
    if (!['IDENTICAL', 'DIFFERENT'].includes(r.status) || !r.branchNonBlank || !r.baselineNonBlank || r.differenceRatio > maxDifferenceRatio) failures.push(`Screenshot acceptance failed: ${r.filename} (${r.status})`);
  }
  return failures;
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
    console.log(`Wrote screenshot comparison report to ${output}`);
  } else {
    console.log(markdown);
  }

  const thresholdIndex = process.argv.indexOf('--max-difference-ratio');
  const threshold = thresholdIndex >= 0 ? Number(process.argv[thresholdIndex + 1]) : 0;
  const failures = validateComparison(comparison, threshold);
  if (failures.length) {
    console.error(`[COMPARATOR] ${failures.join('\n')}`);
    process.exit(1);
  }
}
