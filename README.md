# opencode-learning

OpenCode plugin that observes session events and writes append-only JSONL for later pattern extraction.

## What it does

Watches your OpenCode sessions and captures structured observations:

- **User messages** — what you asked, with secrets redacted
- **Tool calls** — which tools ran, args (content stripped from `write`/`edit`), duration, success
- **Compaction** — when the session compacted
- **Session end** — total tool count, whether files were modified, session duration

Observations are written to `.opencode-learning/observations.jsonl` in your project root. Nothing is sent anywhere. Nothing is auto-applied. This is the raw signal you can mine later for patterns about how you and your agents actually work.

## Install

```bash
npm install opencode-learning
```

Add to your `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-learning"]
}
```

## What lands in your repo

On first load, the plugin creates:

```
.opencode-learning/
  .gitignore         # excludes everything by default
  meta.json          # project ID, name, git remote, timestamps
  observations.jsonl # append-only event log
```

The `.gitignore` keeps observations out of git by default. Opt-in to commit specific extracted patterns when you've reviewed them.

## Safety

- **Every hook is wrapped in `safeExecute`.** A throw in most OpenCode hooks kills your session — this plugin catches and logs all errors instead.
- **Self-event filtering.** Every observation carries `source: "learning"`. The event handler is structurally filtered to only `session.idle` and `session.compacted` — every other event type is ignored without inspection. This prevents feedback loops if a future version emits its own events.
- **Redaction.** User message text and tool args are scanned for high-entropy strings (likely tokens), API key patterns (Anthropic, OpenAI, GitHub, Cloudflare, etc.), URL credentials, and emails. Matches are replaced with `[REDACTED]`.
- **`write` and `edit` content is dropped.** Tool args for these tools strip `content` and `replacement` fields entirely (replaced with `_content_dropped: true`) — file contents never enter the log.

## Observation shape

```jsonl
{"ts":"2026-04-30T01:23:45.678Z","type":"user_message","session":"abc","source":"learning","agent":"operate","parent":null,"text":"Read foo.ts"}
{"ts":"...","type":"tool_call_start","session":"abc","source":"learning","agent":"operate","tool":"read","call_id":"xyz","args":{"filePath":"/path/to/foo.ts"}}
{"ts":"...","type":"tool_call_end","session":"abc","source":"learning","agent":"operate","tool":"read","call_id":"xyz","success":true,"duration_ms":12}
{"ts":"...","type":"compaction","session":"abc","source":"learning"}
{"ts":"...","type":"session_end","session":"abc","source":"learning","duration_ms":300000,"tool_count":42,"files_modified":true}
```

## Performance

Hook handlers are budgeted to <5ms p99 (well below OpenCode's per-hook budget). Measured: p50=0.045ms, p99=0.117ms, max=0.299ms over 1000 iterations. Storage is sync `fs.appendFileSync` — observed cost dominates the budget (still well under 5ms).

## License

MIT
