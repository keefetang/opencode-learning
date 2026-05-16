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
 *  - Storage init creates .opencode/learning/ + .gitignore
 *  - Self-event filter (every observation has source: "learning")
 *  - call_id pairing across before/after
 *  - duration_ms is computed (>= 0)
 *  - tool_count / files_modified accumulate into session_end
 *  - agent attribution flows from chat.message → tool hooks
 *  - Write tool args have content stripped via sanitization
 *  - Bash tool args have command truncated via sanitization
 *  - safeExecute swallows malformed input without throwing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import LearningPlugin from "../src/index.js";
import { storagePath } from "../src/storage.js";

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
  observationsPath = path.join(tmpDir, ".opencode", "learning", "observations.jsonl");
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
  test("creates .opencode/learning/ directory", () => {
    expect(fs.existsSync(path.join(tmpDir, ".opencode", "learning"))).toBe(true);
  });

  test("creates .gitignore inside .opencode/", () => {
    const gi = path.join(tmpDir, ".opencode", ".gitignore");
    expect(fs.existsSync(gi)).toBe(true);
    expect(fs.readFileSync(gi, "utf-8")).toContain("*");
  });

  test("does not create meta.json (removed)", () => {
    const metaPath = path.join(tmpDir, ".opencode", "learning", "meta.json");
    expect(fs.existsSync(metaPath)).toBe(false);
  });

  test("logs a load message", () => {
    const loaded = logCalls.find((c) => c.message.includes("opencode-learning loaded"));
    expect(loaded).toBeDefined();
    expect(loaded!.level).toBe("info");
  });
});

describe("integration — storagePath path traversal protection", () => {
  test("storagePath strips directory components from filename", () => {
    const result = storagePath("/home/user/project", "../../etc/passwd");
    // Should resolve to /home/user/project/.opencode/learning/passwd
    expect(result).not.toContain("../../");
    expect(result.endsWith("passwd")).toBe(true);
    expect(result).toContain(".opencode/learning/");
  });

  test("storagePath handles normal filenames unchanged", () => {
    const result = storagePath("/home/user/project", "observations.jsonl");
    expect(result).toBe(path.join("/home/user/project", ".opencode/learning", "observations.jsonl"));
  });

  test("storagePath strips subdirectory from filename", () => {
    const result = storagePath("/project", "subdir/file.txt");
    expect(result).not.toContain("subdir/");
    expect(result.endsWith("file.txt")).toBe(true);
  });
});

describe("integration — init failure resilience", () => {
  test("plugin loads even when directory is non-writable (hooks still register)", async () => {
    // Use a path that will cause initStorage to fail (non-existent deep path
    // where mkdir would fail because we can't write to /nonexistent)
    const { ctx, logCalls: calls } = makeMockContext("/nonexistent/path/that/fails");
    const hooks = await LearningPlugin(ctx);

    // Hooks must still be registered
    expect(hooks["chat.message"]).toBeDefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["tool.execute.after"]).toBeDefined();
    expect(hooks.event).toBeDefined();

    // Should have logged the init failure
    const errorLog = calls.find((c) => c.message.includes("init failed"));
    expect(errorLog).toBeDefined();
    expect(errorLog!.level).toBe("error");

    // Hooks should run without throwing (silently no-op on write)
    let didThrow = false;
    try {
      await hooks["chat.message"]!(
        { sessionID: "s1", agent: "test" },
        {
          message: { agent: "test", id: "m1", role: "user" } as never,
          parts: [{ type: "text", text: "hi" }] as never,
        },
      );
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);
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

  test("bash tool truncates command in args (not dropped)", async () => {
    const sessionID = "test-session-bash";
    const callID = "test-call-bash";

    await plugin["tool.execute.before"]!(
      { tool: "bash", sessionID, callID },
      { args: { command: "bun test", description: "run tests", timeout: 5000 } },
    );

    await plugin["tool.execute.after"]!(
      { tool: "bash", sessionID, callID, args: { command: "bun test" } },
      { title: "bash", output: "ok", metadata: {} },
    );

    const lines = fs.readFileSync(observationsPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const startEvent = events[0];
    expect(startEvent.tool).toBe("bash");
    // Short commands pass through unchanged
    expect(startEvent.args.command).toBe("bun test");
    expect(startEvent.args.description).toBe("run tests");
    expect(startEvent.args.timeout).toBe(5000);
    // No content was dropped — command was just truncated (short enough to pass through)
    expect(startEvent.args._content_dropped).toBeUndefined();
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

  test("session_end includes observations_dropped field", async () => {
    const sessionID = "test-session-dropped";

    await plugin["chat.message"]!(
      { sessionID, agent: "operate" },
      {
        message: { agent: "operate", id: "m1", role: "user" } as never,
        parts: [{ type: "text", text: "hello" }] as never,
      },
    );

    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID } } as never,
    });

    const lines = fs.readFileSync(observationsPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    const sessionEnd = events.find((e: { type: string }) => e.type === "session_end");
    expect(sessionEnd).toBeDefined();
    expect(typeof sessionEnd.observations_dropped).toBe("number");
    expect(sessionEnd.observations_dropped).toBe(0);
  });

  test("session.idle without a tracked session does not write session_end", async () => {
    // No prior chat.message → no session created. Idle event should be a no-op.
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "ghost" } } as never,
    });

    expect(fs.existsSync(observationsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// looksLikeError — tested through tool.execute.after hook's success field
// ---------------------------------------------------------------------------

describe("integration — looksLikeError via tool.execute.after success field", () => {
  /**
   * Helper: fire tool.execute.before + after with given metadata, return
   * the `success` field from the tool_call_end observation.
   */
  async function getSuccessForMetadata(metadata: unknown): Promise<boolean> {
    const sessionID = `err-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const callID = `call-${sessionID}`;

    await plugin["tool.execute.before"]!(
      { tool: "bash", sessionID, callID },
      { args: { command: "test" } },
    );
    await plugin["tool.execute.after"]!(
      { tool: "bash", sessionID, callID, args: { command: "test" } },
      { title: "bash", output: "ok", metadata },
    );

    const lines = fs.readFileSync(observationsPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    const endEvent = events.filter((e: { type: string }) => e.type === "tool_call_end").pop();
    expect(endEvent).toBeDefined();
    return endEvent.success as boolean;
  }

  test("metadata: { error: 'some error' } → detected as error", async () => {
    expect(await getSuccessForMetadata({ error: "some error" })).toBe(false);
  });

  test("metadata: { error: true } → detected as error", async () => {
    expect(await getSuccessForMetadata({ error: true })).toBe(false);
  });

  test("metadata: { error: false } → NOT detected as error", async () => {
    expect(await getSuccessForMetadata({ error: false })).toBe(true);
  });

  test("metadata: { error: null } → NOT detected as error", async () => {
    expect(await getSuccessForMetadata({ error: null })).toBe(true);
  });

  test("metadata: { isError: true } → detected as error", async () => {
    expect(await getSuccessForMetadata({ isError: true })).toBe(false);
  });

  test("metadata: { isError: false } → NOT detected as error", async () => {
    expect(await getSuccessForMetadata({ isError: false })).toBe(true);
  });

  test("metadata: 'error occurred' (string) → detected as error", async () => {
    expect(await getSuccessForMetadata("error occurred")).toBe(false);
  });

  test("metadata: {} → NOT detected as error", async () => {
    expect(await getSuccessForMetadata({})).toBe(true);
  });

  test("metadata: null → NOT detected as error", async () => {
    expect(await getSuccessForMetadata(null)).toBe(true);
  });

  test("metadata: undefined → NOT detected as error", async () => {
    expect(await getSuccessForMetadata(undefined)).toBe(true);
  });
});
