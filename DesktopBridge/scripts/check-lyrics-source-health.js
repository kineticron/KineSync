#!/usr/bin/env node

const {
  runLyricsSourceHealthCheck,
  DEFAULT_PROBE_TRACKS,
} = require("../src/lyricsSourceHealth");

const USAGE = `
Usage:
  node scripts/check-lyrics-source-health.js [options]

Options:
  --source <name>       Source to test (repeatable, comma-separated accepted)
  --sources <names>     Alias of --source
  --all                 Test all available sources (default when none specified)
  --min-pass <number>   Minimum passing tracks per source to mark healthy (default: 1)
  -h, --help            Show this help

Examples:
  node scripts/check-lyrics-source-health.js --source qq-meting
  node scripts/check-lyrics-source-health.js --source qq-mirror,qq-direct
  node scripts/check-lyrics-source-health.js --all --min-pass 2
`.trim();

function splitSources(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const sources = [];
  let minPasses = 1;
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      showHelp = true;
      continue;
    }
    if (arg === "--all") {
      sources.push("all");
      continue;
    }
    if (arg === "--source" || arg === "--sources") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      sources.push(...splitSources(next));
      index += 1;
      continue;
    }
    if (arg.startsWith("--source=") || arg.startsWith("--sources=")) {
      const [, value = ""] = arg.split("=", 2);
      sources.push(...splitSources(value));
      continue;
    }
    if (arg === "--min-pass") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--min-pass requires a numeric value");
      }
      minPasses = Number(next);
      index += 1;
      continue;
    }
    if (arg.startsWith("--min-pass=")) {
      const [, value = ""] = arg.split("=", 2);
      minPasses = Number(value);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    // Treat positional arguments as source names for npm script ergonomics.
    sources.push(...splitSources(arg));
  }

  if (!Number.isFinite(minPasses) || minPasses <= 0) {
    throw new Error("--min-pass must be a positive number");
  }

  return {
    sources,
    minPasses: Math.floor(minPasses),
    showHelp,
  };
}

function formatTrack(track) {
  return `${track.title} - ${track.artist}`;
}

function printSourceDetails(sourceResult) {
  console.log(`\n[${sourceResult.source}]`);
  for (const entry of sourceResult.trackResults) {
    if (entry.ok) {
      const lineCount = Number(entry.result?.lyrics?.length || 0);
      const fetchedFrom = String(entry.result?.source || sourceResult.source);
      console.log(
        `  PASS ${formatTrack(entry.track)} | ${lineCount} lines | ${fetchedFrom}`,
      );
      continue;
    }
    const reason = entry.errorMessage
      ? `${entry.errorType}: ${entry.errorMessage}`
      : entry.errorType;
    console.log(`  FAIL ${formatTrack(entry.track)} | ${reason}`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    console.error("");
    console.error(USAGE);
    process.exit(2);
    return;
  }

  if (parsed.showHelp) {
    console.log(USAGE);
    process.exit(0);
    return;
  }

  const report = await runLyricsSourceHealthCheck({
    sources: parsed.sources,
    tracks: DEFAULT_PROBE_TRACKS,
    minPasses: parsed.minPasses,
  });

  if (report.unknownSources.length) {
    console.error(
      `Unknown sources: ${report.unknownSources.join(", ")}\nAvailable sources: ${report.availableSources.join(", ")}`,
    );
    process.exit(2);
    return;
  }

  console.log(`Testing ${report.selectedSources.length} source(s) across ${DEFAULT_PROBE_TRACKS.length} track(s).`);
  if (report.disabledSources.length) {
    console.log(
      `Temporarily disabled in app: ${report.disabledSources.join(", ")}`,
    );
  }

  for (const sourceResult of report.sourceResults) {
    printSourceDetails(sourceResult);
  }

  console.log("\nSummary:");
  for (const sourceResult of report.sourceResults) {
    const status = sourceResult.isHealthy ? "HEALTHY" : "UNHEALTHY";
    console.log(
      `  ${sourceResult.source}: ${sourceResult.passCount}/${sourceResult.totalTracks} passes (${status})`,
    );
  }

  const overall = report.allHealthy ? "HEALTHY" : "UNHEALTHY";
  console.log(`Overall: ${overall}`);
  process.exit(report.allHealthy ? 0 : 1);
}

main().catch((error) => {
  console.error("Source health script crashed:", error);
  process.exit(2);
});
