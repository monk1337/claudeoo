/**
 * fetch() interceptor for Anthropic API calls.
 * Wraps globalThis.fetch to observe SSE streams via getReader() monkey-patch.
 * Processes chunks incrementally so records are written DURING streaming,
 * not after — ensuring data is captured even if the process exits abruptly.
 */

import { calculateCost } from "./pricing";
import { writeRecord, writeLog } from "./recorder";
import { formatVerboseLine, fmtCost, fmtTokens } from "./format";
import type { ApiCallRecord, ApiUsage, TrackedBlock, ContentBlockType } from "./types";

// ANSI colors for live status line (matching Claude's status bar style)
const S = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

let sessionId: string = "";
let turnCounter = 0;
let verbose = false;
let noDb = false;
const records: ApiCallRecord[] = [];

/** Cumulative session totals for live status */
const session = {
  totalCost: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  turns: 0,
  lastModel: "unknown",
  lastTurnCost: 0,
};

/** Pending streams that haven't finished yet — flushed on process exit */
const pendingStreams: Map<number, PendingStream> = new Map();

interface PendingStream {
  state: StreamState;
  requestModel: string;
  turnNum: number;
  startTime: number;
  buffer: string;
  eventType: string;
}

export function initInterceptor(opts: {
  sessionId: string;
  verbose: boolean;
  noDb: boolean;
}) {
  sessionId = opts.sessionId;
  verbose = opts.verbose;
  noDb = opts.noDb;
  installFetchWrapper();
  installExitHandler();
}

export function getRecords(): ApiCallRecord[] {
  return records;
}

/** Flush any pending streams on process exit */
function installExitHandler() {
  process.on("exit", () => {
    for (const [turnNum, pending] of pendingStreams) {
      try {
        processPendingBuffer(pending);
        finalizeStream(pending);
      } catch {
        // Never crash on exit
      }
    }
    pendingStreams.clear();
    // Restore terminal title
    try {
      setTerminalTitle("");
    } catch { /* ignore */ }
  });
}

/** Set terminal title — updates the tab/window title live without touching Claude's TUI */
function setTerminalTitle(text: string): void {
  try {
    process.stderr.write(`\x1b]2;${text}\x07`);
  } catch { /* ignore */ }
}

/** Format a short model name for display: claude-opus-4-6-20250610 → Opus 4.6 */
function displayModel(model: string): string {
  const m = model.replace("claude-", "").replace(/-\d{8}$/, "");
  // opus-4-6 → Opus 4.6
  const parts = m.split("-");
  if (parts.length >= 3) {
    const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    return `${family} ${parts.slice(1).join(".")}`;
  }
  return m;
}

/** Update live status — terminal title (live) + stderr line (after each turn) */
function updateLiveStatus(isStreaming: boolean): void {
  const model = displayModel(session.lastModel);
  const cost = fmtCost(session.totalCost);
  const inTok = fmtTokens(session.totalInput);
  const outTok = fmtTokens(session.totalOutput);

  // Terminal title — always updates (visible in tab title, non-interfering)
  const titleParts = [
    `[claudeoo]`,
    `💰 ${cost}`,
    `↑${inTok} ↓${outTok}`,
    `turn ${session.turns}`,
  ];
  if (isStreaming) titleParts.push("⏳");
  setTerminalTitle(titleParts.join(" | "));
}

/** Write a styled status line to stderr after each completed turn */
function writeStatusLine(): void {
  const model = displayModel(session.lastModel);
  const cost = fmtCost(session.totalCost);
  const lastCost = fmtCost(session.lastTurnCost);
  const inTok = fmtTokens(session.totalInput);
  const outTok = fmtTokens(session.totalOutput);

  const line = [
    `${S.gray}[${S.cyan}${model}${S.gray}]${S.reset}`,
    `💰 ${S.green}${cost}${S.reset}${S.dim} (${lastCost} last)${S.reset}`,
    `📊 ${S.yellow}${inTok}${S.reset}${S.dim} in${S.reset} ${S.cyan}${outTok}${S.reset}${S.dim} out${S.reset}`,
    `🔄 ${S.dim}turn ${session.turns}${S.reset}`,
  ].join(`${S.gray} │ ${S.reset}`);

  process.stderr.write(`${line}\n`);
}

/** Strip system prompt, tool definitions, and old messages — keep only what's unique per turn */
function trimRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};

  // Keep small config fields
  for (const key of ["model", "max_tokens", "temperature", "stream", "metadata", "thinking", "output_config"]) {
    if (body[key] !== undefined) trimmed[key] = body[key];
  }

  // Messages: only the last user message (not the full conversation history)
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (messages && messages.length > 0) {
    const last = messages[messages.length - 1];
    trimmed.messages_count = messages.length;
    trimmed.last_message = { role: last.role, content: last.content };
  }

  // System: just note its presence and length, don't log the full prompt
  const system = body.system as unknown[] | undefined;
  if (system) {
    trimmed.system_blocks = system.length;
  }

  // Tools: just the count
  const tools = body.tools as unknown[] | undefined;
  if (tools) {
    trimmed.tools_count = tools.length;
  }

  return trimmed;
}

function installFetchWrapper() {
  const originalFetch = globalThis.fetch;

  if (verbose) {
    process.stderr.write(`[claudeoo] fetch wrapper installed\n`);
  }

  globalThis.fetch = async function interceptedFetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Only intercept Anthropic API message calls
    if (!isAnthropicMessagesCall(url)) {
      return originalFetch.call(this, input, init);
    }

    const startTime = Date.now();
    turnCounter++;
    const turnNum = turnCounter;

    // Extract model from request body and log the full request
    let requestModel = "unknown";
    let requestBody: Record<string, unknown> | null = null;
    if (init?.body) {
      try {
        requestBody = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer));
        requestModel = (requestBody as Record<string, unknown>).model as string || "unknown";
      } catch {
        // ignore parse errors
      }
    }

    // Log the request — strip bulky repeated fields (system prompt, tools, full history)
    try {
      const logBody = requestBody ? trimRequestBody(requestBody) : null;
      writeLog(sessionId, {
        type: "request",
        turn: turnNum,
        timestamp: new Date().toISOString(),
        url,
        model: requestModel,
        body: logBody,
      });
    } catch { /* never crash */ }

    const response = await originalFetch.call(this, input, init);

    const contentType = response.headers.get("content-type") || "";

    // Intercept SSE streams by observing getReader().read() calls.
    // We process chunks incrementally (not after stream ends) so records
    // are written synchronously during streaming.
    if (response.body && contentType.includes("text/event-stream")) {
      const pending: PendingStream = {
        state: {
          messageId: null,
          model: requestModel,
          usage: { input_tokens: 0, output_tokens: 0 },
          stopReason: null,
          contentBlocks: [],
        },
        requestModel,
        turnNum,
        startTime,
        buffer: "",
        eventType: "",
      };
      pendingStreams.set(turnNum, pending);

      const body = response.body as any;

      // Wrap getReader — used by some consumers
      const origGR = body.getReader.bind(body);
      body.getReader = function(opts?: any) {
        const reader = origGR(opts);
        return wrapReader(reader, pending, turnNum);
      };

      // Wrap async iterator — used by Anthropic SDK (for await...of)
      const origIter = body[Symbol.asyncIterator]?.bind(body);
      if (origIter) {
        body[Symbol.asyncIterator] = function() {
          const iter = origIter();
          const origNext = iter.next.bind(iter);
          const decoder = new TextDecoder();
          iter.next = async function(...args: any[]) {
            const result = await origNext(...args);
            if (result.value) {
              try {
                const bytes = result.value instanceof Uint8Array
                  ? result.value
                  : new Uint8Array(result.value.buffer || result.value);
                pending.buffer += decoder.decode(bytes, { stream: true });
                processPendingBuffer(pending);
              } catch { /* ignore */ }
            }
            if (result.done) {
              try {
                pending.buffer += decoder.decode();
                processPendingBuffer(pending);
                finalizeStream(pending);
                pendingStreams.delete(turnNum);
              } catch { /* ignore */ }
            }
            return result;
          };
          return iter;
        };
      }
    }

    return response;
  };
}

function wrapReader(reader: any, pending: PendingStream, turnNum: number): any {
  const origRead = reader.read.bind(reader);
  const decoder = new TextDecoder();

  reader.read = async function(...args: any[]) {
    const result = await origRead(...args);
    if (result.value) {
      try {
        const bytes = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value.buffer || result.value);
        pending.buffer += decoder.decode(bytes, { stream: true });
        processPendingBuffer(pending);
      } catch { /* ignore */ }
    }
    if (result.done) {
      try {
        pending.buffer += decoder.decode();
        processPendingBuffer(pending);
        finalizeStream(pending);
        pendingStreams.delete(turnNum);
      } catch { /* ignore */ }
    }
    return result;
  };

  return reader;
}

function isAnthropicMessagesCall(url: string): boolean {
  return url.includes("/v1/messages") && !url.includes("/v1/messages/batches");
}

/** Process complete SSE events from the buffer, leaving incomplete lines */
function processPendingBuffer(pending: PendingStream): void {
  const lines = pending.buffer.split("\n");
  pending.buffer = lines.pop() || ""; // Keep incomplete last line

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      pending.eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const evtType = pending.eventType || parsed.type;
        processSSEEvent(evtType, parsed, pending.state);

        // Log SSE event (skip noisy pings and per-chunk deltas)
        if (evtType !== "ping" && evtType !== "content_block_delta") {
          try {
            writeLog(sessionId, {
              type: "sse_event",
              turn: pending.turnNum,
              timestamp: new Date().toISOString(),
              event_type: evtType,
              data: parsed,
            });
          } catch { /* never crash */ }
        }
      } catch {
        // Skip unparseable events
      }
    } else if (line.trim() === "") {
      pending.eventType = "";
    }
  }
}

/** Write the final record — called synchronously when stream ends or process exits */
function finalizeStream(pending: PendingStream): void {
  const { state } = pending;
  const durationMs = Date.now() - pending.startTime;


  let thinkingChars = 0;
  let textChars = 0;
  let toolUseChars = 0;
  for (const block of state.contentBlocks) {
    switch (block.type) {
      case "thinking": thinkingChars += block.charCount; break;
      case "text": textChars += block.charCount; break;
      case "tool_use": toolUseChars += block.charCount; break;
    }
  }

  const cost = calculateCost(
    state.model,
    state.usage.input_tokens,
    state.usage.output_tokens,
    state.usage.cache_creation_input_tokens || 0,
    state.usage.cache_read_input_tokens || 0
  );

  const record: ApiCallRecord = {
    session_id: sessionId,
    message_id: state.messageId,
    model: state.model,
    timestamp: new Date().toISOString(),
    input_tokens: state.usage.input_tokens,
    output_tokens: state.usage.output_tokens,
    cache_creation_input_tokens: state.usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: state.usage.cache_read_input_tokens || 0,
    thinking_chars: thinkingChars,
    text_chars: textChars,
    tool_use_chars: toolUseChars,
    stop_reason: state.stopReason,
    cost_usd: cost,
    cwd: process.cwd(),
    turn_number: pending.turnNum,
    duration_ms: durationMs,
  };

  records.push(record);

  // Update cumulative session totals
  session.totalCost += cost;
  session.totalInput += state.usage.input_tokens;
  session.totalOutput += state.usage.output_tokens;
  session.totalCacheRead += state.usage.cache_read_input_tokens || 0;
  session.totalCacheWrite += state.usage.cache_creation_input_tokens || 0;
  session.turns++;
  session.lastModel = state.model;
  session.lastTurnCost = cost;

  // Live status: update terminal title only (stderr lines break Claude's TUI)
  updateLiveStatus(false);

  if (verbose) {
    process.stderr.write(formatVerboseLine(record) + "\n");
  }

  // writeRecord is synchronous (fs.appendFileSync + SQLite)
  try {
    writeRecord(record, noDb);
  } catch {
    // Never crash Claude
  }

  // Log stream completion with final summary
  try {
    writeLog(sessionId, {
      type: "stream_end",
      turn: pending.turnNum,
      timestamp: new Date().toISOString(),
      message_id: state.messageId,
      model: state.model,
      usage: state.usage,
      stop_reason: state.stopReason,
      duration_ms: durationMs,
      content_blocks: state.contentBlocks,
      cost_usd: cost,
    });
  } catch { /* never crash */ }
}

/** Mutable state accumulated during SSE stream processing */
interface StreamState {
  messageId: string | null;
  model: string;
  usage: ApiUsage;
  stopReason: string | null;
  contentBlocks: TrackedBlock[];
}

function processSSEEvent(
  eventType: string,
  data: Record<string, unknown>,
  state: StreamState
): void {
  switch (eventType) {
    case "message_start": {
      const msg = data.message as Record<string, unknown> | undefined;
      if (msg) {
        if (msg.id) state.messageId = msg.id as string;
        if (msg.model) state.model = msg.model as string;
        if (msg.usage) {
          const u = msg.usage as Record<string, number>;
          state.usage = {
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0,
          };
        }
        // Update terminal title to show streaming
        session.lastModel = state.model;
        updateLiveStatus(true);
      }
      break;
    }

    case "content_block_start": {
      const block = data.content_block as Record<string, unknown> | undefined;
      const index = (data.index as number) ?? state.contentBlocks.length;
      if (block) {
        state.contentBlocks.push({
          index,
          type: (block.type as ContentBlockType) || "text",
          charCount: 0,
        });
      }
      break;
    }

    case "content_block_delta": {
      const index = data.index as number;
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta && index !== undefined) {
        const block = state.contentBlocks.find((b) => b.index === index);
        if (block) {
          const text =
            (delta.text as string) ||
            (delta.thinking as string) ||
            (delta.partial_json as string) ||
            "";
          block.charCount += text.length;
        }
      }
      break;
    }

    case "message_delta": {
      const deltaUsage = data.usage as Record<string, number> | undefined;
      if (deltaUsage) {
        state.usage.output_tokens = deltaUsage.output_tokens ?? state.usage.output_tokens;
      }
      if (data.delta) {
        const d = data.delta as Record<string, unknown>;
        if (d.stop_reason) {
          state.stopReason = d.stop_reason as string;
        }
      }
      break;
    }
  }
}
