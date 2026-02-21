/**
 * CommonJS preload script for Node --require.
 * This file MUST stay as .js (not .ts) because it's loaded before
 * any TypeScript compilation occurs.
 *
 * It registers a require hook for .ts files and then initializes
 * the fetch interceptor.
 */

"use strict";

// Suppress experimental SQLite warning
const _origEmit = process.emit;
process.emit = function (event, ...args) {
  if (event === "warning" && args[0] && args[0].name === "ExperimentalWarning") {
    return false;
  }
  return _origEmit.call(process, event, ...args);
};

// Register tsx/ts-node for loading .ts files at runtime
try {
  // Try tsx first (faster, more compatible)
  require("tsx/cjs");
} catch {
  try {
    // Fallback to ts-node
    require("ts-node/register/transpile-only");
  } catch {
    // If running from compiled dist/, .ts imports resolve to .js — no hook needed
  }
}

// Read config from environment variables set by the launcher
const sessionId = process.env.CLAUDEOO_SESSION_ID || "unknown";
const verbose = process.env.CLAUDEOO_VERBOSE === "1";
const noDb = process.env.CLAUDEOO_NO_DB === "1";

// Initialize the interceptor
try {
  const { initInterceptor } = require("./interceptor");
  initInterceptor({ sessionId, verbose, noDb });
} catch (err) {
  // Never crash Claude — log and continue
  if (verbose) {
    process.stderr.write(`[claudeoo] interceptor load failed: ${err}\n`);
  }
}
