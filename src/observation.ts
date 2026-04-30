/**
 * observation.ts — Observation event types and JSONL writer.
 *
 * The on-disk schema for `.opencode-learning/observations.jsonl`. Every line
 * is a single JSON object conforming to the discriminated `Observation` union.
 *
 * Schema discipline: this format is consumed by a separate extraction process
 * that reads accumulated observations and clusters patterns. Changes to the
 * schema invalidate prior data — bump a version field or migrate carefully.
 *
 * Self-event filtering (anchor.md A.6): every observation includes
 * `source: "learning"` so future versions of this plugin (or downstream
 * consumers) can identify and exclude self-emitted events.
 *
 * v1 limitations:
 *   - `parent` is always null. Determining the parent session ID for a
 *     subagent requires `client.session.get(...)` which is an HTTP round-trip
 *     and would blow the 5ms hook budget (anchor.md A.4). The SDK's
 *     `chat.message` hook input does NOT expose parentID directly. Defer
 *     proper parent detection to a later phase.
 *   - `tool_call_end.success` is best-effort. The `tool.execute.after` hook
 *     does not receive a clean error signal — the `ToolStateError` shape
 *     described in the SDK types is the persisted message state, not what
 *     reaches the hook. We mark `success: true` unless `output.metadata.error`
 *     is truthy. This may underestimate failures.
 */

import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Common base
// ---------------------------------------------------------------------------

/**
 * Fields shared by every observation. The literal `source: "learning"`
 * is the structural marker for self-event filtering.
 */
export interface ObservationBase {
  /** ISO 8601 timestamp at the moment the observation was constructed. */
  ts: string;
  /** Discriminator selecting one of the variants below. */
  type: ObservationType;
  /** OpenCode session ID this observation belongs to. */
  session: string;
  /**
   * Always the literal `"learning"`. Used by future plugin versions and
   * downstream consumers to filter out self-emitted events without inspecting
   * tags or per-tool metadata. See anchor.md A.6.
   */
  source: "learning";
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** A user message arrived in a chat session. */
export interface UserMessageObservation extends ObservationBase {
  type: "user_message";
  /** Agent that received the message (e.g. "operate", "scope", "execute"). */
  agent: string;
  /** Parent session ID for subagent sessions. v1 always writes null. */
  parent: string | null;
  /** Redacted message text, concatenated from all TextPart entries. */
  text: string;
}

/** A tool call started. Pairs with `tool_call_end` via `call_id`. */
export interface ToolCallStartObservation extends ObservationBase {
  type: "tool_call_start";
  /** Agent triggering the call. Null on cache miss (no chat.message yet). */
  agent: string | null;
  /** Tool name (e.g. "edit", "bash", "read"). */
  tool: string;
  /** OpenCode `callID` — pairs the start and end observations. */
  call_id: string;
  /** Redacted tool args. Tool-specific drops applied (see redaction.ts). */
  args: Record<string, unknown>;
}

/** A tool call ended. Pairs with the matching `tool_call_start`. */
export interface ToolCallEndObservation extends ObservationBase {
  type: "tool_call_end";
  agent: string | null;
  tool: string;
  /** Matches the `call_id` of the corresponding tool_call_start. */
  call_id: string;
  /**
   * Best-effort success flag. False if `output.metadata.error` was truthy.
   * See file-level note on this limitation.
   */
  success: boolean;
  /** Wall-clock duration since the matching tool_call_start, in ms. */
  duration_ms: number;
}

/** Session reached idle — final marker for a session's activity. */
export interface SessionEndObservation extends ObservationBase {
  type: "session_end";
  /** Total session duration from first activity to idle, in ms. */
  duration_ms: number;
  /** Total tool calls observed during this session. */
  tool_count: number;
  /** Whether any edit/write tool fired during this session. */
  files_modified: boolean;
}

/** Compaction boundary — emitted on `session.compacted` event. */
export interface CompactionObservation extends ObservationBase {
  type: "compaction";
}

export type Observation =
  | UserMessageObservation
  | ToolCallStartObservation
  | ToolCallEndObservation
  | SessionEndObservation
  | CompactionObservation;

export type ObservationType = Observation["type"];

// ---------------------------------------------------------------------------
// JSONL writer
// ---------------------------------------------------------------------------

/**
 * Append a single observation as one JSON line to `filePath`.
 *
 * Synchronous append-only write. The hook handler is already wrapped in
 * `safeExecute`, but we add an inner try/catch here for a tighter boundary
 * around disk I/O — disk full, EACCES, ENOSPC, etc. should never propagate.
 *
 * The function is intentionally void: callers cannot recover from a write
 * failure, and observation loss is preferable to disrupting the user's
 * session. Errors are silently swallowed; the outer `safeExecute` will log
 * them via `client.app.log` if they bubble up, but they shouldn't.
 */
export function writeObservation(filePath: string, obs: Observation): void {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obs) + "\n", "utf-8");
  } catch {
    // Disk write failed — best to drop this observation and keep the session
    // healthy. The next observation will retry implicitly.
  }
}
