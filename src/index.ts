/**
 * opencode-learning — Plugin entry point.
 *
 * Observes session events (chat messages, tool calls, session lifecycle)
 * and writes append-only JSONL to .opencode/learning/observations.jsonl
 * for later pattern extraction.
 *
 * CRITICAL SAFETY INVARIANT: Every hook handler is wrapped in safeExecute.
 * A thrown error in most hooks kills the user's session (verified in
 * sst/opencode framework source — anchor.md A.5). The framework provides
 * NO safety net for most hook types.
 *
 * SELF-EVENT FILTERING (anchor.md A.6): Every observation written includes
 * `source: "learning"`. The `event` handler is structurally filtered to
 * only `session.idle` and `session.compacted` event types — all other
 * events (including ones potentially emitted by future versions of this
 * plugin) are ignored without inspection.
 */

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";

import {
  type CompactionObservation,
  type SessionEndObservation,
  type ToolCallEndObservation,
  type ToolCallStartObservation,
  type UserMessageObservation,
  writeObservation,
} from "./observation.js";
import { detectProject } from "./project-id.js";
import { redactString, redactToolArgs } from "./redaction.js";
import { safeExecute } from "./safe-execute.js";
import { createSessionManager } from "./session-state.js";
import { initStorage, storagePath } from "./storage.js";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const LearningPlugin: Plugin = async (ctx) => {
  const directory = ctx.directory;
  const client = ctx.client;

  // Detect project identity
  const project = detectProject(directory);

  // Initialize storage (.opencode/learning/ dir, meta.json, .gitignore).
  // Side effect only — meta.json is consumed by the extraction process,
  // not by the plugin at runtime.
  initStorage(directory, project);

  // Resolved path for the observation log. Computed once at plugin init
  // so the per-hook path is a constant string.
  const observationsPath = storagePath(directory, "observations.jsonl");

  // Session state manager (in-memory, not persisted)
  const sessionManager = createSessionManager();

  // Diagnostic log — confirms plugin loaded (visible in --print-logs)
  void client.app.log({
    body: {
      service: "opencode-learning",
      level: "info",
      message: `opencode-learning loaded (project: ${project.projectName}, id: ${project.projectId})`,
    },
  });

  // -----------------------------------------------------------------------
  // Hooks — all wrapped in safeExecute
  // -----------------------------------------------------------------------

  const chatMessage: Hooks["chat.message"] = async (input, output) => {
    await safeExecute(
      "chat.message",
      async () => {
        const session = sessionManager.getOrCreate(input.sessionID);
        session.lastActivityTime = Date.now();

        // Canonical agent source: output.message.agent is required by the
        // SDK type (UserMessage.agent: string). We trust the type rather
        // than layering nullable fallbacks that would mask a real SDK
        // breakage with silent observation drops.
        const agent = output.message.agent;
        session.agent = agent;

        const text = extractMessageText(output.parts);
        if (text === "") return; // No textual content — nothing to observe

        const obs: UserMessageObservation = {
          ts: new Date().toISOString(),
          type: "user_message",
          session: input.sessionID,
          source: "learning",
          agent,
          parent: null, // v1 limitation — see observation.ts
          text: redactString(text),
        };
        writeObservation(observationsPath, obs);
      },
      client,
    );
  };

  const toolExecuteBefore: Hooks["tool.execute.before"] = async (
    input,
    output,
  ) => {
    await safeExecute(
      "tool.execute.before",
      async () => {
        const session = sessionManager.getOrCreate(input.sessionID);
        const startTime = Date.now();
        session.lastActivityTime = startTime;
        session.toolCallStartTimes.set(input.callID, startTime);

        // The args mutate live: `output.args` is what the framework will
        // pass to the tool. We capture a redacted snapshot — args is
        // typed as `any`, but we treat it as `Record<string, unknown>`
        // for redaction purposes.
        const rawArgs = (output.args ?? {}) as Record<string, unknown>;

        const obs: ToolCallStartObservation = {
          ts: new Date(startTime).toISOString(),
          type: "tool_call_start",
          session: input.sessionID,
          source: "learning",
          agent: session.agent,
          tool: input.tool,
          call_id: input.callID,
          args: redactToolArgs(input.tool, rawArgs),
        };
        writeObservation(observationsPath, obs);
      },
      client,
    );
  };

  const toolExecuteAfter: Hooks["tool.execute.after"] = async (
    input,
    output,
  ) => {
    await safeExecute(
      "tool.execute.after",
      async () => {
        const session = sessionManager.getOrCreate(input.sessionID);
        const endTime = Date.now();
        session.lastActivityTime = endTime;
        session.toolCallCount++;
        if (input.tool === "edit" || input.tool === "write") {
          session.filesModified = true;
        }

        // Compute duration from the matching tool_call_start. If no start
        // time was recorded (e.g., this is the first hook fired post-restart
        // for an in-flight call), fall back to 0.
        const startTime = session.toolCallStartTimes.get(input.callID);
        const duration_ms = startTime !== undefined ? endTime - startTime : 0;
        session.toolCallStartTimes.delete(input.callID);

        // Best-effort success detection. The hook output exposes
        // `{title, output, metadata}` — there's no clean error flag. We
        // mark `success: false` only if metadata explicitly carries an
        // error indicator. See observation.ts file-level note.
        const success = !looksLikeError(output);

        const obs: ToolCallEndObservation = {
          ts: new Date(endTime).toISOString(),
          type: "tool_call_end",
          session: input.sessionID,
          source: "learning",
          agent: session.agent,
          tool: input.tool,
          call_id: input.callID,
          success,
          duration_ms,
        };
        writeObservation(observationsPath, obs);
      },
      client,
    );
  };

  const event: Hooks["event"] = async (input) => {
    await safeExecute(
      "event",
      async () => {
        // Structural filter: only two event types are observed. All others
        // (including potential self-emissions from future tool registrations)
        // are ignored without inspection. See anchor.md A.6.
        if (input.event.type === "session.idle") {
          const sessionID = input.event.properties.sessionID;
          const session = sessionManager.get(sessionID);
          if (session !== undefined) {
            const endTime = Date.now();
            const obs: SessionEndObservation = {
              ts: new Date(endTime).toISOString(),
              type: "session_end",
              session: sessionID,
              source: "learning",
              duration_ms: endTime - session.startTime,
              tool_count: session.toolCallCount,
              files_modified: session.filesModified,
            };
            writeObservation(observationsPath, obs);
            // Clear any unmatched in-flight tool starts (defensive — the
            // toolCallStartTimes Map is part of session state that's about
            // to be deleted, but explicit cleanup signals intent).
            session.toolCallStartTimes.clear();
          }
          sessionManager.delete(sessionID);
        } else if (input.event.type === "session.compacted") {
          const sessionID = input.event.properties.sessionID;
          // Bump activity time so a long pause after compaction doesn't
          // make the entry look stale to the periodic sweep before idle
          // arrives.
          const session = sessionManager.get(sessionID);
          if (session !== undefined) session.lastActivityTime = Date.now();
          const obs: CompactionObservation = {
            ts: new Date().toISOString(),
            type: "compaction",
            session: sessionID,
            source: "learning",
          };
          writeObservation(observationsPath, obs);
        }
      },
      client,
    );
  };

  // -----------------------------------------------------------------------
  // Return hooks
  // -----------------------------------------------------------------------

  return {
    event,
    "chat.message": chatMessage,
    "tool.execute.before": toolExecuteBefore,
    "tool.execute.after": toolExecuteAfter,
    // Future: experimental.chat.system.transform for injection
    // Future: experimental.session.compacting for compaction context
  };
};

export default LearningPlugin;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract textual content from a chat.message hook's `output.parts` array.
 *
 * UserMessage parts can include text, file references, agent annotations,
 * etc. — only `TextPart` carries actual prose. We concatenate all text parts
 * with newline separators. Returns empty string if no text parts present
 * (e.g., a message containing only a file attachment).
 */
function extractMessageText(parts: Part[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      texts.push(part.text);
    }
  }
  return texts.join("\n");
}

/**
 * Best-effort detection of whether a tool.execute.after output represents
 * an error. The hook output type is `{title, output, metadata}` with
 * `metadata: any` — there's no canonical error field, so we look for
 * common indicators conservatively. False positives here mean a successful
 * call gets logged as failed; false negatives mean an error gets logged
 * as success. We err on the side of false negatives (missing failures)
 * because they're less misleading than spurious failure markers.
 */
function looksLikeError(output: { title: string; output: string; metadata: unknown }): boolean {
  const meta = output.metadata;
  if (meta !== null && typeof meta === "object") {
    const metaObj = meta as Record<string, unknown>;
    // Conventional fields: `error` or `isError`. Check truthiness.
    if (metaObj.error !== undefined && metaObj.error !== null && metaObj.error !== false) {
      return true;
    }
    if (metaObj.isError === true) return true;
  }
  // Defensive: framework types `metadata: any`, so a future tool could pass
  // a primitive string like "error". Cheap to check.
  if (typeof meta === "string" && meta.toLowerCase().includes("error")) {
    return true;
  }
  return false;
}
