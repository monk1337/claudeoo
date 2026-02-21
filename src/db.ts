/**
 * SQLite database for storing API call records and session summaries.
 * Uses Node.js built-in node:sqlite (DatabaseSync) — zero dependencies.
 */

import * as path from "path";
import * as fs from "fs";
import type { ApiCallRecord, SessionSummary, AggregateStats } from "./types";

// node:sqlite types (experimental module)
interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DB_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claudeoo",
  "usage.db"
);

let db: SqliteDatabase | null = null;

function getDb(): SqliteDatabase {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // Use node:sqlite built-in
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(DB_PATH) as SqliteDatabase;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_calls (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id                  TEXT NOT NULL,
      message_id                  TEXT,
      model                       TEXT NOT NULL,
      timestamp                   TEXT NOT NULL,
      input_tokens                INTEGER DEFAULT 0,
      output_tokens               INTEGER DEFAULT 0,
      cache_creation_input_tokens INTEGER DEFAULT 0,
      cache_read_input_tokens     INTEGER DEFAULT 0,
      thinking_chars              INTEGER DEFAULT 0,
      text_chars                  INTEGER DEFAULT 0,
      tool_use_chars              INTEGER DEFAULT 0,
      stop_reason                 TEXT,
      cost_usd                    REAL DEFAULT 0.0,
      cwd                         TEXT,
      turn_number                 INTEGER DEFAULT 0,
      duration_ms                 INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL,
      cwd           TEXT,
      total_calls   INTEGER DEFAULT 0,
      total_cost    REAL DEFAULT 0.0
    );
  `);

  // Indexes (CREATE IF NOT EXISTS)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_calls_session ON api_calls(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_calls(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen)`);

  return db;
}

/** Insert an API call record */
export function insertApiCall(record: ApiCallRecord): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO api_calls (
      session_id, message_id, model, timestamp,
      input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens,
      thinking_chars, text_chars, tool_use_chars,
      stop_reason, cost_usd, cwd, turn_number, duration_ms
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    record.session_id,
    record.message_id,
    record.model,
    record.timestamp,
    record.input_tokens,
    record.output_tokens,
    record.cache_creation_input_tokens,
    record.cache_read_input_tokens,
    record.thinking_chars,
    record.text_chars,
    record.tool_use_chars,
    record.stop_reason,
    record.cost_usd,
    record.cwd,
    record.turn_number,
    record.duration_ms
  );
}

/** Upsert session summary */
export function upsertSession(record: ApiCallRecord): void {
  const d = getDb();

  // Check if session exists
  const existing = d.prepare(
    `SELECT session_id, total_calls, total_cost FROM sessions WHERE session_id = ?`
  ).get(record.session_id);

  if (existing) {
    d.prepare(`
      UPDATE sessions SET
        last_seen = ?,
        total_calls = total_calls + 1,
        total_cost = total_cost + ?
      WHERE session_id = ?
    `).run(record.timestamp, record.cost_usd, record.session_id);
  } else {
    d.prepare(`
      INSERT INTO sessions (session_id, first_seen, last_seen, cwd, total_calls, total_cost)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(record.session_id, record.timestamp, record.timestamp, record.cwd, record.cost_usd);
  }
}

/** Get aggregate stats for a time range */
export function getStats(since?: string): AggregateStats {
  const d = getDb();
  const where = since ? `WHERE timestamp >= ?` : "";
  const params: unknown[] = since ? [since] : [];

  const row = d.prepare(`
    SELECT
      COUNT(*) as total_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) as total_cache_write_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) as total_cache_read_tokens,
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(thinking_chars), 0) as total_thinking_chars,
      COALESCE(SUM(text_chars), 0) as total_text_chars,
      COALESCE(SUM(tool_use_chars), 0) as total_tool_use_chars,
      COUNT(DISTINCT session_id) as session_count
    FROM api_calls ${where}
  `).get(...params) as Record<string, number>;

  // Get per-model breakdown
  const modelRows = d.prepare(`
    SELECT model, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost
    FROM api_calls ${where}
    GROUP BY model ORDER BY cost DESC
  `).all(...params) as Array<{ model: string; calls: number; cost: number }>;

  const models: Record<string, { calls: number; cost: number }> = {};
  for (const m of modelRows) {
    models[m.model] = { calls: Number(m.calls), cost: Number(m.cost) };
  }

  return {
    total_calls: Number(row.total_calls),
    total_input_tokens: Number(row.total_input_tokens),
    total_output_tokens: Number(row.total_output_tokens),
    total_cache_write_tokens: Number(row.total_cache_write_tokens),
    total_cache_read_tokens: Number(row.total_cache_read_tokens),
    total_cost: Number(row.total_cost),
    total_thinking_chars: Number(row.total_thinking_chars),
    total_text_chars: Number(row.total_text_chars),
    total_tool_use_chars: Number(row.total_tool_use_chars),
    models,
    session_count: Number(row.session_count),
  };
}

/** List recent sessions */
export function listSessions(limit: number): SessionSummary[] {
  const d = getDb();
  const rows = d.prepare(`
    SELECT session_id, first_seen, last_seen, cwd, total_calls, total_cost
    FROM sessions
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    session_id: String(r.session_id),
    first_seen: String(r.first_seen),
    last_seen: String(r.last_seen),
    cwd: r.cwd ? String(r.cwd) : null,
    total_calls: Number(r.total_calls),
    total_cost: Number(r.total_cost),
  }));
}

/** Get all records for a session */
export function getSessionRecords(sessionId: string): ApiCallRecord[] {
  const d = getDb();
  // Support prefix matching
  const rows = d.prepare(`
    SELECT * FROM api_calls
    WHERE session_id = ? OR session_id LIKE ?
    ORDER BY turn_number ASC
  `).all(sessionId, `${sessionId}%`) as Array<Record<string, unknown>>;

  return rows.map(rowToRecord);
}

/** Get all records, optionally filtered by time */
export function getAllRecords(since?: string): ApiCallRecord[] {
  const d = getDb();
  let rows: Array<Record<string, unknown>>;
  if (since) {
    rows = d.prepare(
      `SELECT * FROM api_calls WHERE timestamp >= ? ORDER BY timestamp ASC`
    ).all(since) as Array<Record<string, unknown>>;
  } else {
    rows = d.prepare(
      `SELECT * FROM api_calls ORDER BY timestamp ASC`
    ).all() as Array<Record<string, unknown>>;
  }
  return rows.map(rowToRecord);
}

function rowToRecord(r: Record<string, unknown>): ApiCallRecord {
  return {
    session_id: String(r.session_id),
    message_id: r.message_id ? String(r.message_id) : null,
    model: String(r.model),
    timestamp: String(r.timestamp),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cache_creation_input_tokens: Number(r.cache_creation_input_tokens),
    cache_read_input_tokens: Number(r.cache_read_input_tokens),
    thinking_chars: Number(r.thinking_chars),
    text_chars: Number(r.text_chars),
    tool_use_chars: Number(r.tool_use_chars),
    stop_reason: r.stop_reason ? String(r.stop_reason) : null,
    cost_usd: Number(r.cost_usd),
    cwd: r.cwd ? String(r.cwd) : null,
    turn_number: Number(r.turn_number),
    duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
  };
}

/** Close the database connection */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
