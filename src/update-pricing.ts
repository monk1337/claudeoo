/**
 * Auto-fetch pricing from Anthropic's docs page.
 * Parses the HTML table systematically — no LLM required.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import type { PricingConfig, ModelPricing } from "./types";
import { clearPricingCache } from "./pricing";

const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claudeoo"
);
const CONFIG_PATH = path.join(CONFIG_DIR, "pricing.json");

/** Model name from docs → API model ID */
function toModelId(docName: string): string | null {
  // Strip "(deprecated)" and extra whitespace
  const clean = docName
    .replace(/\(deprecated\)/gi, "")
    .replace(/&amp;/g, "&")
    .trim();

  // "Claude Opus 4.6" → "claude-opus-4-6"
  const match = clean.match(/^Claude\s+(\w+)\s+([\d.]+)$/i);
  if (!match) return null;

  const family = match[1].toLowerCase();
  const version = match[2].replace(/\./g, "-");
  return `claude-${family}-${version}`;
}

/** Parse "$5 / MTok" → 5.0 */
function parseMTokPrice(cell: string): number {
  const match = cell.match(/\$?([\d.]+)\s*\/?\s*MTok/i);
  if (!match) return 0;
  return parseFloat(match[1]);
}

/** Strip HTML tags from a string */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

/** Fetch URL content as string (follows redirects) */
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const doFetch = (fetchUrl: string, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      const proto = fetchUrl.startsWith("https") ? https : require("http");
      proto
        .get(
          fetchUrl,
          { headers: { "User-Agent": "Mozilla/5.0 claudeoo/0.1.0" } },
          (res: import("http").IncomingMessage) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              const newUrl = res.headers.location.startsWith("http")
                ? res.headers.location
                : new URL(res.headers.location, fetchUrl).href;
              doFetch(newUrl, redirects + 1);
              return;
            }

            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }

            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf-8"))
            );
            res.on("error", reject);
          }
        )
        .on("error", reject);
    };

    doFetch(url);
  });
}

/**
 * Parse the model pricing table from HTML.
 *
 * The page renders an HTML table with structure:
 *   <table>
 *     <thead><tr><th>Model</th><th>Base Input Tokens</th>...</tr></thead>
 *     <tbody>
 *       <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td>...</tr>
 *       ...
 *     </tbody>
 *   </table>
 */
function parseModelPricingTable(html: string): Record<string, ModelPricing> {
  const models: Record<string, ModelPricing> = {};

  // Find the first <table> that contains "MTok"
  const firstMtok = html.indexOf("MTok");
  if (firstMtok === -1) return models;

  const tableStart = html.lastIndexOf("<table", firstMtok);
  const tableEnd = html.indexOf("</table>", firstMtok);
  if (tableStart === -1 || tableEnd === -1) return models;

  const table = html.slice(tableStart, tableEnd + 8);

  // Extract all rows
  const rows = table.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
  if (rows.length < 2) return models;

  // Parse header row to find column indices
  const headerCells = (rows[0]!.match(/<t[hd][^>]*>.*?<\/t[hd]>/gs) || []).map(
    stripHtml
  );

  let colInput = -1;
  let colCacheWrite = -1; // 5m cache writes
  let colCacheRead = -1; // Cache Hits & Refreshes
  let colOutput = -1;

  for (let i = 0; i < headerCells.length; i++) {
    const h = headerCells[i].toLowerCase();
    if (h.includes("base input")) colInput = i;
    else if (h.includes("5m cache")) colCacheWrite = i;
    else if (h.includes("cache hit") || h.includes("cache read") || h.includes("refresh"))
      colCacheRead = i;
    else if (h.includes("output")) colOutput = i;
    // Deliberately skip "1h cache writes" — we use 5m as the default
  }

  // Parse data rows (skip header)
  for (let r = 1; r < rows.length; r++) {
    const cells = (rows[r].match(/<t[hd][^>]*>.*?<\/t[hd]>/gs) || []).map(
      stripHtml
    );
    if (cells.length < 3) continue;

    const modelId = toModelId(cells[0]);
    if (!modelId) continue;

    const input = colInput >= 0 ? parseMTokPrice(cells[colInput]) : 0;
    const cacheWrite =
      colCacheWrite >= 0 ? parseMTokPrice(cells[colCacheWrite]) : 0;
    const cacheRead =
      colCacheRead >= 0 ? parseMTokPrice(cells[colCacheRead]) : 0;
    const output = colOutput >= 0 ? parseMTokPrice(cells[colOutput]) : 0;

    if (input > 0 || output > 0) {
      models[modelId] = { input, output, cacheWrite, cacheRead };
    }
  }

  return models;
}

/** Fetch and parse pricing, return the config */
export async function fetchPricing(): Promise<PricingConfig> {
  const content = await fetchText(PRICING_URL);
  const models = parseModelPricingTable(content);

  if (Object.keys(models).length === 0) {
    throw new Error("Failed to parse any models from pricing page");
  }

  return {
    version: new Date().toISOString().slice(0, 10),
    models,
  };
}

/** Save pricing config to ~/.claudeoo/pricing.json */
export function savePricing(config: PricingConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  clearPricingCache();
}

/**
 * Update pricing on startup.
 * - Fetches from Anthropic's docs
 * - On success: saves to ~/.claudeoo/pricing.json
 * - On failure: silently falls back to existing config
 * - 5 second timeout — never blocks Claude startup
 */
export async function updatePricingOnStartup(
  verboseLog: boolean
): Promise<void> {
  try {
    const config = await Promise.race([
      fetchPricing(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 5000)
      ),
    ]);

    const modelCount = Object.keys(config.models).length;
    savePricing(config);

    if (verboseLog) {
      process.stderr.write(
        `[claudeoo] pricing updated: ${modelCount} models (${config.version})\n`
      );
    }
  } catch (err) {
    if (verboseLog) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[claudeoo] pricing update failed (using cached): ${msg}\n`
      );
    }
  }
}
