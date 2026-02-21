/**
 * claudeoo export command — export data as CSV or JSON.
 */

import * as fs from "fs";
import { getAllRecords } from "./db";
import type { ApiCallRecord } from "./types";

export function runExport(format: "csv" | "json", output: string | null): void {
  const records = getAllRecords();

  if (records.length === 0) {
    console.log("No records to export.");
    return;
  }

  let content: string;
  if (format === "json") {
    content = JSON.stringify(records, null, 2);
  } else {
    content = toCsv(records);
  }

  if (output) {
    fs.writeFileSync(output, content);
    console.log(`Exported ${records.length} records to ${output}`);
  } else {
    process.stdout.write(content + "\n");
  }
}

function toCsv(records: ApiCallRecord[]): string {
  const headers = [
    "session_id",
    "message_id",
    "model",
    "timestamp",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "thinking_chars",
    "text_chars",
    "tool_use_chars",
    "stop_reason",
    "cost_usd",
    "cwd",
    "turn_number",
    "duration_ms",
  ];

  const lines = [headers.join(",")];
  for (const r of records) {
    const values = headers.map((h) => {
      const v = (r as unknown as Record<string, unknown>)[h];
      if (v === null || v === undefined) return "";
      if (typeof v === "string" && (v.includes(",") || v.includes('"'))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return String(v);
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
}
