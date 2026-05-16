# AGENTS.md -- opencode-learning

## What This Is

An OpenCode plugin that observes session events (chat messages, tool calls, session lifecycle) and writes append-only JSONL to `.opencode/learning/observations.jsonl` for later pattern extraction via the `/extract` command.

## Architecture

Five source files. `index.ts` is the plugin entry point — hooks, event handlers, and the safe-execution wrapper. `observation.ts` handles JSONL serialization, write rotation, and size caps. `sanitize.ts` provides field-level content dropping and text truncation (replaces the removed 700-line redaction engine). `session-state.ts` tracks per-session tool counts, file modifications, and timing. `storage.ts` resolves and initializes the `.opencode/learning/` directory.

Entry point: `src/index.ts` exports `LearningPlugin`.

## Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | ~343 | Plugin entry, hooks, event handlers, safeExecute wrapper |
| `src/observation.ts` | ~203 | JSONL serialization, writeObservation(), rotation, size caps, dropped-count tracking |
| `src/sanitize.ts` | ~77 | sanitizeToolArgs() (field-level drops), summarizeText() (truncation) |
| `src/session-state.ts` | ~115 | Per-session state: tool counts, file modifications, timing, session manager factory |
| `src/storage.ts` | ~65 | Directory resolution, initStorage(), storagePath() |

## Plugin Hooks

| Hook | Purpose |
|------|---------|
| `tool.execute.before` | Record tool call start (name, args with sensitive fields dropped) |
| `tool.execute.after` | Record tool call end (result summary, duration, success/error) |
| `experimental.chat.system.transform` | Record user messages from chat input |
| `experimental.session.compacting` | Record compaction event |

### Event Handler

Listens for `session.idle` and `session.compacted`. On idle: writes session-end observation with tool count, file count, duration. On compacted: writes compaction-complete observation.

## Conventions

- **Pure JS only** — no native dependencies. Runtime dep is `@opencode-ai/plugin` only.
- **Source ships as `.ts`** — Bun transpiles natively. No build step. (Also has a `tsconfig.build.json` for dist/ generation.)
- **Every hook wrapped in safeExecute** — thrown errors in hooks kill the user's session. The framework provides no safety net.
- **Self-event filtering** — every observation includes `source: "learning"`. Event handler only processes `session.idle` and `session.compacted`.
- **Sensitive field drops, not redaction** — `sanitizeToolArgs` drops entire fields (`content`, `oldString`, `newString`, `value`, `text`) with a `_content_dropped: true` marker. No regex-based redaction.
- **Append-only JSONL** — observations are never modified or deleted. Rotation at 5 MB.
- **Size caps** — individual observation capped at 50 KB. File rotation at 5 MB. Total daily cap at 50 MB.
- **`/extract` is human-initiated only** — agents should not run it automatically.

## Testing

```
bun test
```

74 tests across 4 files covering observation serialization, sanitization, session state, and storage initialization.

## Git Conventions

- **Always confirm with the user before pushing to remote.** No autonomous pushes.
- **Squash related commits before pushing** when possible.
- **CI:** `tsc --noEmit` + `bun test` on every push to main and on PRs. Auto-publish to npm on version tags (`v*`).
- **Dependabot:** Patch/minor PRs can be merged if CI passes. Major version bumps should be tested locally first.

See `~/.config/opencode/context/opencode-plugins.md` for SDK reference and cross-plugin conventions.
