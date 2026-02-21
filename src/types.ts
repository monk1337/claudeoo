/** Pricing for a single model (USD per million tokens) */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Full pricing configuration */
export interface PricingConfig {
  version: string;
  models: Record<string, ModelPricing>;
}

/** Content block types from the Anthropic SSE stream */
export type ContentBlockType = "thinking" | "text" | "tool_use" | "tool_result";

/** Tracked content block during streaming */
export interface TrackedBlock {
  index: number;
  type: ContentBlockType;
  charCount: number;
}

/** Usage data from the API response */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A single recorded API call */
export interface ApiCallRecord {
  session_id: string;
  message_id: string | null;
  model: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  thinking_chars: number;
  text_chars: number;
  tool_use_chars: number;
  stop_reason: string | null;
  cost_usd: number;
  cwd: string | null;
  turn_number: number;
  duration_ms: number | null;
}

/** Session summary */
export interface SessionSummary {
  session_id: string;
  first_seen: string;
  last_seen: string;
  cwd: string | null;
  total_calls: number;
  total_cost: number;
}

/** Aggregate stats result */
export interface AggregateStats {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_write_tokens: number;
  total_cache_read_tokens: number;
  total_cost: number;
  total_thinking_chars: number;
  total_text_chars: number;
  total_tool_use_chars: number;
  models: Record<string, { calls: number; cost: number }>;
  session_count: number;
}

/** Detailed per-session JSON report saved to ~/.claudeoo/reports/ */
export interface SessionReport {
  session_id: string;
  timestamp_start: string;
  timestamp_end: string;
  duration_secs: number;
  cwd: string | null;
  total_api_calls: number;
  total_cost_usd: number;
  tokens: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
    total: number;
  };
  output_breakdown: {
    thinking_chars: number;
    text_chars: number;
    tool_use_chars: number;
  };
  models_used: Record<string, { calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
  turns: Array<{
    turn: number;
    model: string;
    timestamp: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    thinking_chars: number;
    text_chars: number;
    tool_use_chars: number;
    cost_usd: number;
    duration_ms: number | null;
    stop_reason: string | null;
  }>;
}

/** CLI options parsed from arguments */
export interface CliOptions {
  command: "run" | "stats" | "sessions" | "session" | "export" | "pricing" | "help" | "version";
  claudeArgs: string[];
  verbose: boolean;
  noDb: boolean;
  // stats options
  statsRange: "today" | "week" | "all";
  // sessions options
  sessionsLimit: number;
  sessionId: string | null;
  // export options
  exportFormat: "csv" | "json";
  exportOutput: string | null;
  // pricing options
  pricingShow: boolean;
}
