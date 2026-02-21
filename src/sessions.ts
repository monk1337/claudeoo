/**
 * claudeoo sessions command — list sessions and show per-turn breakdown.
 */

import { listSessions, getSessionRecords } from "./db";
import { formatSessionsList, formatSessionDetail } from "./format";

export function runSessionsList(limit: number): void {
  const sessions = listSessions(limit);
  console.log(formatSessionsList(sessions));
}

export function runSessionDetail(sessionId: string): void {
  const records = getSessionRecords(sessionId);
  console.log(formatSessionDetail(records, sessionId));
}
