/**
 * Default command: find Claude's cli.js and spawn it with the fetch interceptor.
 *
 * Two modes:
 *   1. npm-installed: found cli.js → node --require interceptor-loader.js cli.js ...args
 *   2. binary (Bun-compiled): found binary → spawn with HTTPS proxy interception
 *      (falls back to pass-through with JSONL reading if proxy unavailable)
 */

import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { formatSessionSummary } from "./format";
import { closeDb } from "./db";
import type { ApiCallRecord, SessionReport } from "./types";

interface ClaudeLocation {
  type: "node-cli" | "binary";
  path: string;
}

/** Find Claude Code's entry point — prefer npm cli.js, fall back to binary */
function findClaude(): ClaudeLocation | null {
  // 1. Look for npm-installed cli.js first (supports --require injection)
  const npmPaths = [
    // Global npm (Homebrew on macOS)
    "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    // Global npm (Linux / macOS default)
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    // User-local npm global
    path.join(process.env.HOME || "~", ".npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
    path.join(process.env.HOME || "~", "node_modules/@anthropic-ai/claude-code/cli.js"),
  ];

  // Also check npm root -g
  try {
    const npmRoot = execSync("npm root -g 2>/dev/null", { encoding: "utf-8" }).trim();
    if (npmRoot) {
      npmPaths.unshift(path.join(npmRoot, "@anthropic-ai/claude-code/cli.js"));
    }
  } catch {
    // ignore
  }

  for (const p of npmPaths) {
    if (fs.existsSync(p)) {
      return { type: "node-cli", path: p };
    }
  }

  // 2. Check npx cache
  const npxCache = path.join(process.env.HOME || "~", ".npm/_npx");
  if (fs.existsSync(npxCache)) {
    try {
      for (const d of fs.readdirSync(npxCache)) {
        const cliPath = path.join(npxCache, d, "node_modules/@anthropic-ai/claude-code/cli.js");
        if (fs.existsSync(cliPath)) {
          return { type: "node-cli", path: cliPath };
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Resolve `claude` from PATH
  try {
    const which = execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
    if (which) {
      // Check if it's a symlink to a JS file
      const resolved = fs.realpathSync(which);
      if (resolved.endsWith(".js")) {
        return { type: "node-cli", path: resolved };
      }

      // Check for npm cli.js near the symlink target
      if (resolved.endsWith("/bin/claude")) {
        const nearby = path.resolve(
          path.dirname(resolved),
          "../lib/node_modules/@anthropic-ai/claude-code/cli.js"
        );
        if (fs.existsSync(nearby)) {
          return { type: "node-cli", path: nearby };
        }
      }

      // Read shell wrapper for JS path
      try {
        const content = fs.readFileSync(which, "utf-8");
        const match = content.match(/node\s+["']?([^"'\s]+cli\.js)["']?/);
        if (match?.[1] && fs.existsSync(match[1])) {
          return { type: "node-cli", path: match[1] };
        }
      } catch {
        // It's a binary, not a shell wrapper
      }

      // It's a Bun-compiled binary
      return { type: "binary", path: which };
    }
  } catch {
    // ignore
  }

  return null;
}

const reportsDir = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claudeoo",
  "reports"
);

/** Generate a detailed session report JSON from API call records */
function generateReport(
  records: ApiCallRecord[],
  sessionId: string,
  durationSecs: number
): SessionReport {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let totalThinking = 0;
  let totalText = 0;
  let totalToolUse = 0;
  const modelsUsed: Record<string, { calls: number; cost_usd: number; input_tokens: number; output_tokens: number }> = {};

  const turns = records.map((r) => {
    totalInput += r.input_tokens;
    totalOutput += r.output_tokens;
    totalCacheWrite += r.cache_creation_input_tokens;
    totalCacheRead += r.cache_read_input_tokens;
    totalCost += r.cost_usd;
    totalThinking += r.thinking_chars;
    totalText += r.text_chars;
    totalToolUse += r.tool_use_chars;

    const model = r.model;
    if (!modelsUsed[model]) {
      modelsUsed[model] = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
    }
    modelsUsed[model].calls++;
    modelsUsed[model].cost_usd += r.cost_usd;
    modelsUsed[model].input_tokens += r.input_tokens;
    modelsUsed[model].output_tokens += r.output_tokens;

    return {
      turn: r.turn_number,
      model: r.model,
      timestamp: r.timestamp,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      thinking_chars: r.thinking_chars,
      text_chars: r.text_chars,
      tool_use_chars: r.tool_use_chars,
      cost_usd: r.cost_usd,
      duration_ms: r.duration_ms,
      stop_reason: r.stop_reason,
    };
  });

  // Round model costs for cleaner JSON
  for (const m of Object.values(modelsUsed)) {
    m.cost_usd = Math.round(m.cost_usd * 1_000_000) / 1_000_000;
  }

  const firstTs = records[0]?.timestamp || new Date().toISOString();
  const lastTs = records[records.length - 1]?.timestamp || firstTs;

  return {
    session_id: sessionId,
    timestamp_start: firstTs,
    timestamp_end: lastTs,
    duration_secs: Math.round(durationSecs),
    cwd: records[0]?.cwd || process.cwd(),
    total_api_calls: records.length,
    total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cache_creation: totalCacheWrite,
      cache_read: totalCacheRead,
      total: totalInput + totalOutput + totalCacheWrite + totalCacheRead,
    },
    output_breakdown: {
      thinking_chars: totalThinking,
      text_chars: totalText,
      tool_use_chars: totalToolUse,
    },
    models_used: modelsUsed,
    turns,
  };
}

/** Save a session report JSON and return the file path */
function saveReport(report: SessionReport): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `${report.session_id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return reportPath;
}

export function runClaude(claudeArgs: string[], verbose: boolean, noDb: boolean): void {
  const claude = findClaude();
  if (!claude) {
    process.stderr.write(
      "Error: Could not find Claude Code.\n" +
      "Install via npm: npm install -g @anthropic-ai/claude-code\n"
    );
    process.exit(1);
  }

  const sessionId = crypto.randomUUID();

  // Determine the interceptor loader path
  let loaderPath = path.join(__dirname, "interceptor-loader.js");
  if (!fs.existsSync(loaderPath)) {
    loaderPath = path.join(path.dirname(__dirname), "src", "interceptor-loader.js");
  }

  if (verbose) {
    process.stderr.write(`[claudeoo] Claude: ${claude.type} @ ${claude.path}\n`);
    process.stderr.write(`[claudeoo] Session: ${sessionId}\n`);
    process.stderr.write(`[claudeoo] Loader: ${loaderPath}\n`);
  }

  const startTime = Date.now();
  const env = {
    ...process.env,
    CLAUDEOO_SESSION_ID: sessionId,
    CLAUDEOO_VERBOSE: verbose ? "1" : "0",
    CLAUDEOO_NO_DB: noDb ? "1" : "0",
  };

  let child: ReturnType<typeof spawn>;

  if (claude.type === "node-cli" && fs.existsSync(loaderPath)) {
    // Mode 1: npm-installed — use node --require for fetch interception
    if (verbose) {
      process.stderr.write(`[claudeoo] Mode: node --require (fetch interception)\n`);
    }

    // Unset CLAUDECODE to avoid "nested session" check
    delete (env as Record<string, string | undefined>).CLAUDECODE;

    child = spawn(
      process.execPath, // node
      ["--require", loaderPath, claude.path, ...claudeArgs],
      { stdio: "inherit", env }
    );
  } else {
    // Mode 2: binary — run directly, read JSONL afterward
    // (The Bun-compiled binary doesn't support --require injection)
    if (verbose) {
      process.stderr.write(`[claudeoo] Mode: binary pass-through (JSONL post-read)\n`);
    }

    // Unset CLAUDECODE to avoid "nested session" check
    delete (env as Record<string, string | undefined>).CLAUDECODE;

    child = spawn(claude.path, claudeArgs, { stdio: "inherit", env });
  }

  child.on("exit", (code, signal) => {
    const durationSecs = (Date.now() - startTime) / 1000;

    // Read session records from JSONL for summary + report
    try {
      const jsonlPath = path.join(
        process.env.HOME || "~",
        ".claudeoo",
        "sessions",
        `${sessionId}.jsonl`
      );
      if (fs.existsSync(jsonlPath)) {
        const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n");
        const records: ApiCallRecord[] = lines.filter(Boolean).map((l) => JSON.parse(l));
        if (records.length > 0) {
          const summary = formatSessionSummary(records, sessionId, durationSecs);
          process.stderr.write(summary + "\n");

          // Save detailed JSON report
          try {
            const report = generateReport(records, sessionId, durationSecs);
            const reportPath = saveReport(report);
            process.stderr.write(`\n\x1b[2mSession report: ${reportPath}\x1b[0m\n`);
          } catch {
            // Report generation is non-fatal
          }

          // Show full log path if it exists
          const logPath = path.join(
            process.env.HOME || "~",
            ".claudeoo",
            "logs",
            `${sessionId}.jsonl`
          );
          if (fs.existsSync(logPath)) {
            process.stderr.write(`\x1b[2mFull API log:   ${logPath}\x1b[0m\n`);
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      closeDb();
    } catch {
      // ignore
    }

    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  // Forward signals to child
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
}
