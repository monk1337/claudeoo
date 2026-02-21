# claudeoo

Accurate token usage & cost tracker for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Claude Code's built-in usage tracking undercounts output tokens by ~2x because it logs mid-stream SSE snapshots. **claudeoo** intercepts the full API stream and captures the final `message_delta` event — giving you the real numbers.

## Features

- **Accurate token counts** — captures final usage from completed SSE streams, not mid-stream snapshots
- **Real-time cost tracking** — live cost updates in your terminal tab title as tokens stream
- **Per-turn breakdowns** — input, output, cache read/write tokens for every API call
- **Content type tracking** — thinking, text, and tool_use character counts
- **Session reports** — detailed JSON reports saved automatically after each session
- **Full API logs** — optional raw request/response logging for debugging
- **Auto-updated pricing** — fetches latest model pricing from Anthropic's docs on every startup
- **SQLite + JSONL storage** — queryable database with JSONL backup
- **CLI queries** — stats, sessions, export commands to analyze your usage
- **Zero runtime dependencies** — uses Node.js built-in `node:sqlite`

## Installation

```bash
npm install -g claudeoo
```

**Requirements:**
- Node.js >= 22.5.0 (for built-in `node:sqlite`)
- Claude Code installed via npm: `npm install -g @anthropic-ai/claude-code`

## Usage

Use `claudeoo` exactly like you use `claude` — all arguments are passed through:

```bash
# Interactive session
claudeoo

# Single prompt
claudeoo -p "explain this code"

# With Claude flags
claudeoo --dangerously-skip-permissions --model sonnet

# With verbose tracking
claudeoo --coo-verbose -p "hello"
```

### Query Commands

```bash
# Today's usage stats
claudeoo stats --today

# This week / all time
claudeoo stats --week
claudeoo stats --all

# List recent sessions
claudeoo sessions --limit 10

# Per-turn breakdown for a session
claudeoo session <session-id>

# Export all data
claudeoo export --format csv --output usage.csv
claudeoo export --format json

# Show current pricing
claudeoo pricing --show
```

## How It Works

claudeoo finds your npm-installed Claude Code (`cli.js`) and launches it with a `node --require` preload that wraps `globalThis.fetch()`. It observes the Anthropic API's SSE stream without modifying it — Claude works exactly as normal.

```
claudeoo [args...]
  -> node --require interceptor-loader.js <claude-cli.js> ...args
  -> interceptor wraps globalThis.fetch()
  -> filters /v1/messages calls
  -> observes SSE stream via Symbol.asyncIterator monkey-patch
  -> captures message_start (input tokens) + message_delta (output tokens)
  -> writes to ~/.claudeoo/usage.db + JSONL + session reports
  -> updates terminal title with live cost
```

### What Gets Tracked

Each API call records:
- Input, output, cache creation, and cache read tokens
- Thinking, text, and tool_use character counts
- Model, cost, duration, stop reason
- Session ID and turn number

### Live Tracking

Your terminal tab title updates in real-time during streaming:

```
[claudeoo] 💰 $0.47 | ↑125K ↓3.2K | turn 5 | ⏳
```

### Session Summary

After each session ends, you get a summary box plus file paths:

```
╭─────────────────────────────────────────────╮
│ claudeoo session summary                    │
├─────────────────────────────────────────────┤
│ API calls:  12             Duration: 3m 42s │
│ Input:      1.23M          Cache W: 45.2K   │
│ Output:     15.6K          Cache R: 890K    │
├─────────────────────────────────────────────┤
│ Total cost: $0.847                          │
╰─────────────────────────────────────────────╯

Session report: ~/.claudeoo/reports/<session-id>.json
Full API log:   ~/.claudeoo/logs/<session-id>.jsonl
```

## Data Storage

All data is stored in `~/.claudeoo/`:

```
~/.claudeoo/
├── usage.db                    # SQLite database (queryable)
├── pricing.json                # Auto-updated model pricing
├── sessions/
│   └── <session-id>.jsonl      # Per-call JSONL records
├── reports/
│   └── <session-id>.json       # Detailed session report (JSON)
└── logs/
    └── <session-id>.jsonl      # Full API request/response log
```

## Flags

| Flag | Description |
|------|-------------|
| `--coo-verbose` | Real-time per-call logging to stderr |
| `--coo-no-db` | Skip SQLite, write JSONL only |

These flags are consumed by claudeoo and not passed to Claude.

## Pricing

Pricing is auto-fetched from [Anthropic's pricing page](https://docs.anthropic.com/en/docs/about-claude/pricing) on every startup (5s timeout, falls back to cached). Supports all current Claude models including Opus, Sonnet, and Haiku variants with cache pricing.

```bash
claudeoo pricing --show
```

## Why Not Just Use Claude's Built-in Tracking?

Claude Code logs API calls to JSONL transcripts, but these logs capture usage snapshots mid-stream — before the final `message_delta` event arrives. This means:

- **Output tokens are undercounted** by roughly 2x
- **`stop_reason` is always `null`** in the logs (never captured)
- **Cache tokens may be incomplete**

claudeoo reads the complete SSE stream end-to-end and captures the authoritative final usage numbers.

## License

MIT
