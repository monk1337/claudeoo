#!/usr/bin/env node
// Suppress experimental SQLite warning
process.removeAllListeners("warning");
const origEmit = process.emit.bind(process);
// @ts-ignore - suppressing experimental warnings
process.emit = function (event: string, ...args: unknown[]) {
  if (event === "warning" && args[0] && (args[0] as { name?: string }).name === "ExperimentalWarning") {
    return false;
  }
  // @ts-ignore
  return origEmit(event, ...args);
} as typeof process.emit;

/**
 * claudeoo — Accurate Token Usage & Cost Tracker for Claude Code
 *
 * Usage:
 *   claudeoo [claude-args...]                     Run Claude with tracking
 *   claudeoo stats [--today|--week|--all]          Aggregate usage stats
 *   claudeoo sessions [--limit N]                  List recent sessions
 *   claudeoo session <id>                          Per-turn breakdown
 *   claudeoo export [--format csv|json] [--output] Export data
 *   claudeoo pricing --show                        Show current pricing
 */

import type { CliOptions } from "./types";
import { runClaude } from "./run";
import { runStats } from "./stats";
import { runSessionsList, runSessionDetail } from "./sessions";
import { runExport } from "./export";
import { getPricingConfig } from "./pricing";
import { updatePricingOnStartup } from "./update-pricing";
import { bold, cyan, fmtCost } from "./format";

const VERSION = "0.1.0";

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2); // strip node and script path
  const opts: CliOptions = {
    command: "run",
    claudeArgs: [],
    verbose: false,
    noDb: false,
    statsRange: "today",
    sessionsLimit: 10,
    sessionId: null,
    exportFormat: "csv",
    exportOutput: null,
    pricingShow: false,
  };

  // Extract claudeoo-specific flags first
  const remaining: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--coo-verbose") {
      opts.verbose = true;
    } else if (arg === "--coo-no-db") {
      opts.noDb = true;
    } else {
      remaining.push(arg);
    }
  }

  if (remaining.length === 0) {
    opts.command = "run";
    return opts;
  }

  const first = remaining[0];

  if (first === "--version" || first === "-v") {
    opts.command = "version";
    return opts;
  }

  if (first === "--help" || first === "-h") {
    opts.command = "help";
    return opts;
  }

  if (first === "stats") {
    opts.command = "stats";
    for (let i = 1; i < remaining.length; i++) {
      if (remaining[i] === "--today") opts.statsRange = "today";
      else if (remaining[i] === "--week") opts.statsRange = "week";
      else if (remaining[i] === "--all") opts.statsRange = "all";
    }
    return opts;
  }

  if (first === "sessions") {
    opts.command = "sessions";
    for (let i = 1; i < remaining.length; i++) {
      if (remaining[i] === "--limit" && remaining[i + 1]) {
        opts.sessionsLimit = parseInt(remaining[++i], 10) || 10;
      }
    }
    return opts;
  }

  if (first === "session") {
    opts.command = "session";
    opts.sessionId = remaining[1] || null;
    return opts;
  }

  if (first === "export") {
    opts.command = "export";
    for (let i = 1; i < remaining.length; i++) {
      if (remaining[i] === "--format" && remaining[i + 1]) {
        const fmt = remaining[++i];
        if (fmt === "csv" || fmt === "json") opts.exportFormat = fmt;
      } else if (remaining[i] === "--output" && remaining[i + 1]) {
        opts.exportOutput = remaining[++i];
      }
    }
    return opts;
  }

  if (first === "pricing") {
    opts.command = "pricing";
    opts.pricingShow = remaining.includes("--show");
    return opts;
  }

  // Default: everything goes to Claude
  opts.command = "run";
  opts.claudeArgs = remaining;
  return opts;
}

function showHelp(): void {
  console.log(`
${bold("claudeoo")} — Accurate Token Usage & Cost Tracker for Claude Code

${bold("Usage:")}
  claudeoo [claude-args...]                    Run Claude with tracking
  claudeoo stats [--today|--week|--all]        Aggregate usage stats
  claudeoo sessions [--limit N]               List recent sessions
  claudeoo session <id>                        Per-turn breakdown
  claudeoo export [--format csv|json] [--output FILE]  Export data
  claudeoo pricing --show                      Show current pricing

${bold("Flags:")}
  --coo-verbose    Real-time per-call logging to stderr
  --coo-no-db      Skip SQLite, JSONL only
  --version, -v    Show version
  --help, -h       Show this help

${bold("Examples:")}
  claudeoo -p "explain this code"      Track a single prompt
  claudeoo                             Start interactive Claude session
  claudeoo stats --today               Today's token usage and costs
  claudeoo sessions --limit 5          Last 5 sessions
  claudeoo export --format json        Export all data as JSON
`);
}

function showPricing(): void {
  const config = getPricingConfig();
  console.log(`${bold("claudeoo")} pricing (version: ${config.version})\n`);
  console.log(`  ${bold("Model".padEnd(22))}  ${"Input".padEnd(8)}  ${"Output".padEnd(8)}  ${"Cache W".padEnd(8)}  Cache R`);
  console.log(`  ${"-".repeat(62)}`);

  for (const [model, p] of Object.entries(config.models)) {
    console.log(
      `  ${cyan(model.padEnd(22))}  ${fmtCost(p.input).padEnd(8)}  ${fmtCost(p.output).padEnd(8)}  ${fmtCost(p.cacheWrite).padEnd(8)}  ${fmtCost(p.cacheRead)}`
    );
  }
  console.log(`\n  Prices per million tokens.`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Auto-update pricing from Anthropic docs on every startup
  // Runs in background for "run" (non-blocking), awaited for pricing/stats
  const needsFreshPricing = ["run", "pricing", "stats"].includes(opts.command);
  if (needsFreshPricing) {
    if (opts.command === "run") {
      // Non-blocking for run — don't delay Claude startup
      updatePricingOnStartup(opts.verbose).catch(() => {});
    } else {
      // Await for query commands so they show latest pricing
      await updatePricingOnStartup(opts.verbose);
    }
  }

  switch (opts.command) {
    case "version":
      console.log(`claudeoo v${VERSION}`);
      break;

    case "help":
      showHelp();
      break;

    case "stats":
      runStats(opts.statsRange);
      break;

    case "sessions":
      runSessionsList(opts.sessionsLimit);
      break;

    case "session":
      if (!opts.sessionId) {
        console.error("Usage: claudeoo session <session-id>");
        process.exit(1);
      }
      runSessionDetail(opts.sessionId);
      break;

    case "export":
      runExport(opts.exportFormat, opts.exportOutput);
      break;

    case "pricing":
      showPricing();
      break;

    case "run":
      runClaude(opts.claudeArgs, opts.verbose, opts.noDb);
      break;
  }
}

main();
