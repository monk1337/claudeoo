/**
 * Writes API call records to JSONL files and optionally SQLite.
 * Also writes full API logs (requests + SSE events) to a separate log file.
 */

import * as fs from "fs";
import * as path from "path";
import type { ApiCallRecord } from "./types";
import { insertApiCall, upsertSession } from "./db";

const baseDir = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claudeoo"
);
const sessionsDir = path.join(baseDir, "sessions");
const logsDir = path.join(baseDir, "logs");

let initialized = false;

function ensureDirs() {
  if (initialized) return;
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  initialized = true;
}

/** Append a raw log entry to the full session log file */
export function writeLog(sessionId: string, entry: Record<string, unknown>): void {
  ensureDirs();
  const logPath = path.join(logsDir, `${sessionId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/** Write a record to JSONL and optionally SQLite */
export function writeRecord(record: ApiCallRecord, noDb: boolean): void {
  ensureDirs();

  // Always write JSONL backup
  const jsonlPath = path.join(sessionsDir, `${record.session_id}.jsonl`);
  fs.appendFileSync(jsonlPath, JSON.stringify(record) + "\n");

  // Write to SQLite unless disabled
  if (!noDb) {
    try {
      insertApiCall(record);
      upsertSession(record);
    } catch {
      // SQLite failure is non-fatal — JSONL backup exists
    }
  }
}
