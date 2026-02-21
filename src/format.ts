import type { ApiCallRecord, AggregateStats, SessionSummary } from "./types";

// ANSI color helpers
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

export function bold(s: string): string {
  return `${c.bold}${s}${c.reset}`;
}

export function dim(s: string): string {
  return `${c.dim}${s}${c.reset}`;
}

export function green(s: string): string {
  return `${c.green}${s}${c.reset}`;
}

export function yellow(s: string): string {
  return `${c.yellow}${s}${c.reset}`;
}

export function cyan(s: string): string {
  return `${c.cyan}${s}${c.reset}`;
}

export function red(s: string): string {
  return `${c.red}${s}${c.reset}`;
}

export function magenta(s: string): string {
  return `${c.magenta}${s}${c.reset}`;
}

/** Format a number with commas */
export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format USD cost */
export function fmtCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format tokens compactly: 1234567 → 1.23M, 12345 → 12.3K */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toString();
}

/** Box-drawing session summary printed on exit */
export function formatSessionSummary(
  records: ApiCallRecord[],
  sessionId: string,
  durationSecs: number
): string {
  if (records.length === 0) return "";

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let totalThinking = 0;
  let totalText = 0;
  let totalToolUse = 0;

  for (const r of records) {
    totalInput += r.input_tokens;
    totalOutput += r.output_tokens;
    totalCacheWrite += r.cache_creation_input_tokens;
    totalCacheRead += r.cache_read_input_tokens;
    totalCost += r.cost_usd;
    totalThinking += r.thinking_chars;
    totalText += r.text_chars;
    totalToolUse += r.tool_use_chars;
  }

  const mins = Math.floor(durationSecs / 60);
  const secs = Math.floor(durationSecs % 60);
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const lines: string[] = [];
  lines.push("");
  lines.push(`${c.cyan}╭─────────────────────────────────────────────╮${c.reset}`);
  lines.push(`${c.cyan}│${c.reset} ${c.bold}claudeoo${c.reset} session summary                    ${c.cyan}│${c.reset}`);
  lines.push(`${c.cyan}├─────────────────────────────────────────────┤${c.reset}`);
  lines.push(`${c.cyan}│${c.reset} API calls:  ${padRight(fmtNum(records.length), 14)} Duration: ${padRight(duration, 8)}${c.cyan}│${c.reset}`);
  lines.push(`${c.cyan}│${c.reset} Input:      ${padRight(fmtTokens(totalInput), 14)} Cache W: ${padRight(fmtTokens(totalCacheWrite), 9)}${c.cyan}│${c.reset}`);
  lines.push(`${c.cyan}│${c.reset} Output:     ${padRight(fmtTokens(totalOutput), 14)} Cache R: ${padRight(fmtTokens(totalCacheRead), 9)}${c.cyan}│${c.reset}`);
  lines.push(`${c.cyan}├─────────────────────────────────────────────┤${c.reset}`);
  lines.push(`${c.cyan}│${c.reset} ${c.bold}Total cost: ${green(fmtCost(totalCost))}${padRight("", 45 - 14 - fmtCost(totalCost).length)}${c.cyan}│${c.reset}`);
  lines.push(`${c.cyan}╰─────────────────────────────────────────────╯${c.reset}`);

  return lines.join("\n");
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

/** Format stats for the stats command */
export function formatStats(stats: AggregateStats, rangeLabel: string): string {
  const lines: string[] = [];
  lines.push(`${bold("claudeoo")} usage — ${rangeLabel}`);
  lines.push("");
  lines.push(`  API calls:     ${fmtNum(stats.total_calls)}`);
  lines.push(`  Sessions:      ${fmtNum(stats.session_count)}`);
  lines.push(`  Input tokens:  ${fmtTokens(stats.total_input_tokens)}`);
  lines.push(`  Output tokens: ${fmtTokens(stats.total_output_tokens)}`);
  lines.push(`  Cache write:   ${fmtTokens(stats.total_cache_write_tokens)}`);
  lines.push(`  Cache read:    ${fmtTokens(stats.total_cache_read_tokens)}`);
  lines.push(`  ${bold("Total cost:")}   ${green(fmtCost(stats.total_cost))}`);

  if (Object.keys(stats.models).length > 0) {
    lines.push("");
    lines.push(`  ${bold("By model:")}`);
    for (const [model, data] of Object.entries(stats.models)) {
      lines.push(`    ${cyan(model)}: ${fmtNum(data.calls)} calls, ${fmtCost(data.cost)}`);
    }
  }

  return lines.join("\n");
}

/** Format sessions list */
export function formatSessionsList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return dim("No sessions found.");

  const lines: string[] = [];
  lines.push(`${bold("Recent sessions:")}\n`);
  lines.push(
    `  ${padRight("Session ID", 12)}  ${padRight("Date", 20)}  ${padRight("Calls", 6)}  ${padRight("Cost", 10)}  CWD`
  );
  lines.push(`  ${"-".repeat(80)}`);

  for (const s of sessions) {
    const shortId = s.session_id.slice(0, 10);
    const date = s.first_seen.replace("T", " ").slice(0, 19);
    const cwd = s.cwd ? shortenPath(s.cwd) : "-";
    lines.push(
      `  ${padRight(shortId, 12)}  ${padRight(date, 20)}  ${padRight(String(s.total_calls), 6)}  ${padRight(fmtCost(s.total_cost), 10)}  ${dim(cwd)}`
    );
  }

  return lines.join("\n");
}

/** Format a single session's per-turn breakdown */
export function formatSessionDetail(records: ApiCallRecord[], sessionId: string): string {
  if (records.length === 0) return dim(`No records found for session ${sessionId}`);

  const lines: string[] = [];
  lines.push(`${bold("Session")} ${cyan(sessionId)}\n`);
  lines.push(
    `  ${padRight("#", 4)}  ${padRight("Model", 20)}  ${padRight("In", 8)}  ${padRight("Out", 8)}  ${padRight("CacheW", 8)}  ${padRight("CacheR", 8)}  ${padRight("Cost", 8)}  Stop`
  );
  lines.push(`  ${"-".repeat(86)}`);

  let totalCost = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    totalCost += r.cost_usd;
    lines.push(
      `  ${padRight(String(i + 1), 4)}  ${padRight(shortModel(r.model), 20)}  ${padRight(fmtTokens(r.input_tokens), 8)}  ${padRight(fmtTokens(r.output_tokens), 8)}  ${padRight(fmtTokens(r.cache_creation_input_tokens), 8)}  ${padRight(fmtTokens(r.cache_read_input_tokens), 8)}  ${padRight(fmtCost(r.cost_usd), 8)}  ${r.stop_reason || "-"}`
    );
  }

  lines.push(`  ${"-".repeat(86)}`);
  lines.push(`  ${bold("Total:")} ${fmtNum(records.length)} calls, ${green(fmtCost(totalCost))}`);

  return lines.join("\n");
}

function shortModel(model: string): string {
  return model.replace("claude-", "").replace(/-\d{8}$/, "");
}

function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/** Format verbose per-call log line */
export function formatVerboseLine(record: ApiCallRecord): string {
  return `${dim("[claudeoo]")} ${shortModel(record.model)} in=${fmtTokens(record.input_tokens)} out=${fmtTokens(record.output_tokens)} cost=${fmtCost(record.cost_usd)} stop=${record.stop_reason || "?"}`;
}
