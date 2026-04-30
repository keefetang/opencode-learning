/**
 * Integration test — drives every hook handler end-to-end against a mocked
 * PluginInput, confirming the full pipeline wiring works:
 *
 *   chat.message      → user_message observation
 *   tool.execute.before → tool_call_start observation
 *   tool.execute.after  → tool_call_end observation (with duration_ms, agent)
 *   event(compacted)   → compaction observation
 *   event(idle)        → session_end observation (with summary fields)
 *
 * Verifies cross-hook behaviour the unit tests can't:
 *  - Storage init creates .opencode-learning/ + meta.json + .gitignore
 *  - Self-event filter (every observation has source: "learning")
 *  - call_id pairing across before/after
 *  - duration_ms is computed (>= 0)
 *  - tool_count / files_modified accumulate into session_end
 *  - agent attribution flows from chat.message → tool hooks
 *  - Write tool args have content stripped via redaction
 *  - safeExecute swallows malformed input without throwing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import LearningPlugin from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock PluginInput
// ---------------------------------------------------------------------------

/**
 * The plugin only touches `ctx.directory` and `ctx.client.app.log`. Other
 * PluginInput fields (project, worktree, serverUrl, $, experimental_workspace)
 * are referenced only via type — never read at runtime. Casting through
 * `unknown` to the plugin's expected shape keeps the test honest about the
 * mock surface while satisfying the type checker.
 */
function makeMockContext(directory: string) {
  const logCalls: Array<{ level: string; message: string }> = [];
  const mockClient = {
    app: {
      log: async (req: { body: { level: string; message: string } }) => {
        logCalls.push({ level: req.body.level, message: req.body.message });
        return { data: undefined };
      },
    },
  };
  return {
    ctx: {
      directory,
      client: mockClient,
    } as unknown as Parameters<typeof LearningPlugin>[0],
    logCalls,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let observationsPath: string;
let plugin: Awaited<ReturnType<typeof LearningPlugin>>;
let logCalls: Array<{ level: string; message: string }>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oclearn-int-"));
  observationsPath = path.join(tmpDir, ".opencode-learning", "observations.jsonl");
  const { ctx, logCalls: calls } = makeMockContext(tmpDir);
  logCalls = calls;
  plugin = await LearningPlugin(ctx);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration — storage init", () => {
  test("creates .opencode-learning/ directory", () => {
    expect(fs.existsSync(path.join(tmpDir, ".opencode-learning"))).toBe(true);
  });

  test("creates .gitignore inside storage dir", () => {
    const gi = path.join(tmpDir, ".opencode-learning", ".gitignore");
    expect(fs.existsSync(gi)).toBe(true);
    expect(fs.readFileSync(gi, "utf-8")).toContain("*");
  });

  test("creates meta.json with expected shape", () => {
    const metaPath = path.join(tmpDir, ".opencode-learning", "meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.version).toBeDefined();
    expect(typeof meta.projectId).toBe("string");
    expect(meta.projectId.length).toBeGreaterThan(0);
    expect(typeof meta.projectName).toBe("string");
    expect(meta.projectRoot).toBe(tmpDir);
    expect(meta.lastExtractionAt).toBeNull();
    expect(typeof meta.createdAt).toBe("string");
  });

  test("logs a load message", () => {
    const loaded = logCalls.find((c) => c.message.includes("opencode-learning loaded"));
    expect(loaded).toBeDefined();
    expect(loaded!.level).toBe("info");
  });
});

describe("integration — full hook pipeline", () => {
  test("full session lifecycle produces all 5 observation types", async () => {
    const sessionID = "test-session-abc";
    const callID = "test-call-xyz";

    // 1. chat.message — user sends a message
    await plugin["chat.message"]!(
      { sessionID, agent: "operate" },
      {
        message: { agent: "operate", id: "m1", role: "user" } as never,
        parts: [{ type: "text", text: "Read the file foo.ts" }] as never,
      },
    );

    // 2. tool.execute.before — read tool starts
    await plugin["tool.execute.before"]!(
      { tool: "read", sessionID, callID },
      { args: { filePath: "/path/to/foo.ts" } },
    );

    // Force a measurable elapsed time so duration_ms > 0
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 3. tool.execute.after — read tool finishes
    await plugin["tool.execute.after"]!(
      { tool: "read", sessionID, callID, args: { filePath: "/path/to/foo.ts" } },
      { title: "read", output: "file contents", metadata: {} },
    );

    // 4. event filtered to session.compacted
    await plugin.event!({
      event: { type: "session.compacted", properties: { sessionID } } as never,
    });

    // 5. event filtered to session.idle (final)
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID } } as never,
    });

    // Verify all observations written
    const lines = fs.readFileSync(observationsPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    expect(events.length).toBe(5);
    expect(events[0].type).toBe("user_message");
    expect(events[1].type).toBe("tool_call_start");
    expect(events[2].type).toBe("tool_call_end");
    expect(events[3].type).toBe("compaction");
    expect(events[4].type).toBe("session_end");

    // Self-event filter: every observation has source: "learning"
    for (const ev of events) {
      expect(ev.source).toBe("learning");
    }

    // Pairing: tool_call_start and tool_call_end have matching call_id
    expect(events[1].call_id).toBe(callID);
    expect(events[2].call_id).toBe(callID);

    // Duration computed correctly (we slept 5ms — must be > 0)
    expect(events[2].duration_ms).toBeGreaterThan(0);

    // Session end summary correct
    expect(events[4].tool_count).toBe(1);
    expect(events[4].files_modified).toBe(false); // read doesn't modify
    // Total session duration must reflect the sleep (>0), not be a hardcoded 0.
    expect(events[4].duration_ms).toBeGreaterThan(0);

    // Compaction observation must carry the session ID — guards against a
    // typo (sessionId vs sessionID) in the event handler that the loose
    // `as never` cast on the test payload otherwise wouldn't surface.
    expect(events[3].session).toBe(sessionID);

    // Agent attribution flows: tool_call_start/end inherit from the chat.message
    // session.agent. (events[0] trivially has the agent from the input.)
    expect(events[1].agent).toBe("operate");
    expect(events[2].agent).toBe("operate");
  });

  test("event filter ignores non-tracked event types", async () => {
    // Drop an event type we don't care about — must not write anything
    await plugin.event!({
      event: { type: "message.updated", properties: {} } as never,
    });

    expect(fs.existsSync(observationsPath)).toBe(false);
  });

  test("write tool sets files_modified and drops content from args", async () => {
    const sessionID = "test-session-write";
    const callID = "test-call-write";

    await plugin["chat.message"]!(
      { sessionID, agent: "implement" },
      {
        message: { agent: "implement", id: "m1", role: "user" } as never,
        parts: [{ type: "text", text: "create a file" }] as never,
      },
    );

    await plugin["tool.execute.before"]!(
      { tool: "write", sessionID, callID },
      { args: { filePath: "/foo.ts", content: "secret content here" } },
    );

    await plugin["tool.execute.after"]!(
      { tool: "write", sessionID, callID, args: { filePath: "/foo.ts", content: "secret content here" } },
      { title: "write", output: "ok", metadata: {} },
    );

    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID } } as never,
    });

    const lines = fs.readFileSync(observationsPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const startEvent = events[1];
    expect(startEvent.tool).toBe("write");
    expect(startEvent.args.filePath).toBe("/foo.ts");
    expect(startEvent.args.content).toBeUndefined();
    expect(startEvent.args._content_dropped).toBe(true);

    // session_end should reflect the write
    const sessionEnd = events.at(-1);
    expect(sessionEnd.type).toBe("session_end");
    expect(sessionEnd.files_modified).toBe(true);
    expect(sessionEnd.tool_count).toBe(1);
  });

  test("tool errors are detected via metadata.isError", async () => {
    const sessionID = "test-session-err";
    const callID = "test-call-err";

    await plugin["tool.execute.before"]!(
      { tool: "bash", sessionID, callID },
      { args: { command: "false" } },
    );

    await plugin["tool.execute.after"]!(
      { tool: "bash", sessionID, callID, args: { command: "false" } },
      { title: "bash", output: "exit 1", metadata: { isError: true } },
    );

    const lines = fs.readFileSync(observationsPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    const endEvent = events[1];
    expect(endEvent.type).toBe("tool_call_end");
    expect(endEvent.success).toBe(false);
  });

  test("hook errors do not throw out of the handler (safeExecute swallows)", async () => {
    // Pass clearly malformed input. Hooks should swallow errors via
    // safeExecute, not throw to the caller (which would be the framework).
    let didThrow = false;
    try {
      await plugin["chat.message"]!(null as never, null as never);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);

    didThrow = false;
    try {
      await plugin["tool.execute.before"]!(null as never, null as never);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);

    didThrow = false;
    try {
      await plugin["tool.execute.after"]!(null as never, null as never);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);

    didThrow = false;
    try {
      await plugin.event!(null as never);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);

    // The errors must be logged once per handler — exactly four. A loose
    // `> 0` would silently miss a regression where one of the four handlers
    // dropped its safeExecute wrapper. The "must not throw" invariant is
    // the single most critical safety property in this plugin (see
    // src/index.ts header).
    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors.length).toBe(4);

    // Each hook's name must appear in a logged message — locks in the
    // diagnostic value of safeExecute's `name` parameter so reviewers can
    // tell which handler failed from the logs alone.
    const errorMessages = errors.map((e) => e.message);
    expect(errorMessages.some((m) => m.includes("[chat.message]"))).toBe(true);
    expect(errorMessages.some((m) => m.includes("[tool.execute.before]"))).toBe(true);
    expect(errorMessages.some((m) => m.includes("[tool.execute.after]"))).toBe(true);
    expect(errorMessages.some((m) => m.includes("[event]"))).toBe(true);
  });

  test("session.idle without a tracked session does not write session_end", async () => {
    // No prior chat.message → no session created. Idle event should be a no-op.
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "ghost" } } as never,
    });

    expect(fs.existsSync(observationsPath)).toBe(false);
  });
});
