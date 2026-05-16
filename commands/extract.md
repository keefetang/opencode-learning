---
description: Extract patterns from accumulated learning observations into proposals
agent: operate
---

Analyze observation data accumulated by the opencode-learning plugin. Surface repeating workflow patterns and produce proposals for codifying them into the framework.

## Discovery

Find observation files. Each project with the learning plugin installed has `.opencode/learning/observations.jsonl` in its root.

1. Check the current working directory first
2. Scan sibling projects: `find "$(dirname "$PWD")" -maxdepth 2 -path '*/.opencode/learning/observations.jsonl' -type f 2>/dev/null`
3. If the user passed a directory path as an argument, scan that instead

The project name is the directory containing `.opencode/learning/`.

Before processing, check total line counts and file sizes. If the combined data exceeds 10,000 observations, summarize per-project first and focus cross-project analysis on the top 3-5 projects by volume.

## Analysis

Use bash with inline python3 to parse the JSONL and answer these questions. The schema reference at the end of this command describes every field.

**About the user:**
- What kinds of requests does the user make? Collect `user_message` text where the message is a direct user request (not a subagent delegation — filter out messages starting with `## Task` or `**Task`). Look for recurring phrasing, request types, and conversational patterns.
- Does the user ask for assessment before approving changes, or approve immediately?

**About workflows:**
- What tool sequences appear between user messages? Group `tool_call_start` events between `user_message` events, compress repeated consecutive tools (e.g., `read,read,read` → `read×3`). Look for sequences that repeat across sessions.
- Which tool pairs appear together most often? (Adjacent `tool_call_start` events within a session — bigrams.)
- Does the user follow a consistent multi-step flow across projects? (e.g., orient → assess → fix → review)

**About delegation:**
- How often does Operate delegate to subagents (`task` tool) vs doing work directly?
- Which agents handle which tools? (Agent-tool matrix from `tool_call_start`.)
- What is the ratio of Operate tool calls to subagent tool calls?

**About sessions:**
- Typical session duration and tool count (from `session_end` events)
- Ratio of reading tools (`read`, `grep`, `glob`) to writing tools (`edit`, `write`)

Check what's already in the hub AGENTS.md (`~/.config/opencode/AGENTS.md`) and the current project's AGENTS.md if it exists. Don't propose patterns that are already codified — look for explicit workflow conventions, collaboration preferences, and behavioral rules that match observed patterns.

## Proposals

For each repeating pattern worth codifying, produce:

```
### [Category] Pattern title

**Evidence:** Which projects, how many sessions/occurrences, concrete examples from the data
**Pattern:** What the user or agent consistently does
**Proposal:** What to codify and where (AGENTS.md convention, new command, skill addition, or awareness only)
**Confidence:** High (>5 occurrences, cross-project) / Medium (3-5 occurrences) / Low (2 occurrences, worth watching)
```

Present proposals in the conversation organized by confidence (high first). These are starting points for discussion — the user decides what to accept, modify, or defer.

## Constraints

- Do NOT write to any files — present everything in conversation
- Do NOT modify AGENTS.md, skills, commands, or any framework files
- Do NOT propose patterns already captured in existing AGENTS.md files
- Abstract to pattern-level — no project-specific details (ticket numbers, file names) in proposals
- If the data is too thin (<50 observations or <3 sessions total), say so instead of forcing patterns from noise

## Observation Schema Reference

Each line in `observations.jsonl` is one JSON object. Example:

```jsonl
{"ts":"2026-05-15T13:05:08Z","type":"tool_call_start","session":"ses_abc123","source":"learning","agent":"operate","tool":"bash","call_id":"call_xyz","args":{"command":"bun test","description":"run tests","workdir":"/path/to/project"}}
```

**Base fields** (all types): `ts` (ISO 8601), `type` (discriminator), `session` (OpenCode session ID), `source` (always `"learning"`)

**Types:**

| Type | Key fields | Notes |
|------|-----------|-------|
| `user_message` | `agent`, `text`, `parent` | `parent` always null in v1. Text truncated to 100 chars (v0.3.0+) or 500 chars (older). |
| `tool_call_start` | `agent`, `tool`, `call_id`, `args` | `agent` is null if no `chat.message` preceded this tool call in the session. |
| `tool_call_end` | `agent`, `tool`, `call_id`, `success`, `duration_ms` | `success` is best-effort (may miss some failures). |
| `session_end` | `duration_ms`, `tool_count`, `files_modified`, `observations_dropped` | A single session ID can have multiple `session_end` events (one per idle cycle). `observations_dropped` present in v0.3.0+ only. |
| `compaction` | _(base fields only)_ | Rare. |

**Args sanitization:** `edit` drops `content`/`oldString`/`newString`. `write` drops `content`. Both set `_content_dropped: true`. `bash` truncates `command` to 100 chars but preserves `description` and `workdir`. All other tools: args preserved as-is.

**Cross-project activity:** `bash` args may have a `workdir` pointing to a different project. `read`/`edit`/`write` args contain absolute `filePath` values that may reference other projects.

**Version differences:** Older data (pre-v0.3.0) may contain `<REDACTED:*>` markers and `<TRUNCATED:N>` suffixes from a previous redaction engine. Current data uses `…<N more>` for truncation.

$ARGUMENTS

Arguments can be a focus area ("delegation", "tool usage", "workflows"), a directory path to scan, or a project name to limit analysis to.
