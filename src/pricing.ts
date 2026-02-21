import * as fs from "fs";
import * as path from "path";
import type { ModelPricing, PricingConfig } from "./types";

let pricingConfig: PricingConfig | null = null;

/** Clear cached pricing so next access reloads from disk */
export function clearPricingCache(): void {
  pricingConfig = null;
}

function loadPricing(): PricingConfig {
  if (pricingConfig) return pricingConfig;

  // Try user config first
  const userPath = path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claudeoo",
    "pricing.json"
  );
  if (fs.existsSync(userPath)) {
    try {
      pricingConfig = JSON.parse(fs.readFileSync(userPath, "utf-8"));
      return pricingConfig!;
    } catch {
      // Fall through to bundled
    }
  }

  // Use bundled pricing
  const bundledPath = path.join(__dirname, "pricing.json");
  if (fs.existsSync(bundledPath)) {
    pricingConfig = JSON.parse(fs.readFileSync(bundledPath, "utf-8"));
    return pricingConfig!;
  }

  // Inline fallback
  pricingConfig = {
    version: "2026-02-21-fallback",
    models: {
      "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
      "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    },
  };
  return pricingConfig!;
}

/** Strip date suffix from model ID: claude-opus-4-6-20250610 → claude-opus-4-6 */
function normalizeModelId(modelId: string): string {
  // Remove date suffix like -20250610 or -20251001
  return modelId.replace(/-\d{8}$/, "");
}

/** Resolve pricing for a model ID with fuzzy matching */
export function resolvePricing(modelId: string): ModelPricing | null {
  const config = loadPricing();
  const normalized = normalizeModelId(modelId);

  // Exact match
  if (config.models[normalized]) {
    return config.models[normalized];
  }

  // Exact match on raw ID
  if (config.models[modelId]) {
    return config.models[modelId];
  }

  // Family match: find by key substring
  const families = ["opus", "sonnet", "haiku"];
  for (const family of families) {
    if (normalized.includes(family)) {
      // Find the latest (first listed) model of this family
      for (const [key, pricing] of Object.entries(config.models)) {
        if (key.includes(family)) {
          return pricing;
        }
      }
    }
  }

  return null;
}

/** Calculate cost in USD for a set of token counts */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number
): number {
  const pricing = resolvePricing(modelId);
  if (!pricing) return 0;

  const M = 1_000_000;
  return (
    (inputTokens / M) * pricing.input +
    (outputTokens / M) * pricing.output +
    (cacheWriteTokens / M) * pricing.cacheWrite +
    (cacheReadTokens / M) * pricing.cacheRead
  );
}

/** Get the full pricing config for display */
export function getPricingConfig(): PricingConfig {
  return loadPricing();
}

/** Get pricing version string */
export function getPricingVersion(): string {
  return loadPricing().version;
}
