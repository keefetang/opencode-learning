/**
 * Unit tests for observation construction + JSONL writing.
 *
 * Covers the contract of observation.ts and the redaction-integrated path
 * that the hooks use:
 *  - Each of the 5 observation types serializes to a single JSON line
 *  - writeObservation appends, never overwrites
 *  - Every observation carries `source: "learning"` (self-event filter)
 *  - Redaction is applied to user_message text and tool_call_start args
 *  - Hook-shaped construction stays well under the 5ms latency budget
 *
 * Test framework: bun:test (matches existing test/redaction.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type CompactionObservation,
  type Observation,
  type SessionEndObservation,
  type ToolCallEndObservation,
  type ToolCallStartObservation,
  type UserMessageObservation,
  writeObservation,
} from "../src/observation.js";
import { redactString, redactToolArgs } from "../src/redaction.js";

// ---------------------------------------------------------------------------
// Temp file fixture
// ---------------------------------------------------------------------------

let tempFile: string;

beforeEach(() => {
  // Unique filename per test for isolation across parallel runs.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempFile = path.join(os.tmpdir(), `observation-test-${id}.jsonl`);
});

afterEach(() => {
  try {
    fs.unlinkSync(tempFile);
  } catch {
    // Already gone or never created — fine.
  }
});

// ---------------------------------------------------------------------------
// Helpers — read written JSONL back as parsed objects
// ---------------------------------------------------------------------------

function readObservations(filePath: string): Observation[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  if (raw.length === 0) return [];
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Observation);
}

// Sample observations covering each variant. Constructed via the exported
// types so any schema change is caught at the type level too.
function makeUserMessage(
  overrides: Partial<UserMessageObservation> = {},
): UserMessageObservation {
  return {
    ts: "2026-04-30T12:00:00.000Z",
    type: "user_message",
    session: "sess-1",
    source: "learning",
    agent: "operate",
    parent: null,
    text: "hello world",
    ...overrides,
  };
}

function makeToolCallStart(
  overrides: Partial<ToolCallStartObservation> = {},
): ToolCallStartObservation {
  return {
    ts: "2026-04-30T12:00:01.000Z",
    type: "tool_call_start",
    session: "sess-1",
    source: "learning",
    agent: "operate",
    tool: "bash",
    call_id: "call-abc",
    args: { command: "ls" },
    ...overrides,
  };
}

function makeToolCallEnd(
  overrides: Partial<ToolCallEndObservation> = {},
): ToolCallEndObservation {
  return {
    ts: "2026-04-30T12:00:02.000Z",
    type: "tool_call_end",
    session: "sess-1",
    source: "learning",
    agent: "operate",
    tool: "bash",
    call_id: "call-abc",
    success: true,
    duration_ms: 42,
    ...overrides,
  };
}

function makeSessionEnd(
  overrides: Partial<SessionEndObservation> = {},
): SessionEndObservation {
  return {
    ts: "2026-04-30T12:05:00.000Z",
    type: "session_end",
    session: "sess-1",
    source: "learning",
    duration_ms: 300_000,
    tool_count: 12,
    files_modified: true,
    ...overrides,
  };
}

function makeCompaction(
  overrides: Partial<CompactionObservation> = {},
): CompactionObservation {
  return {
    ts: "2026-04-30T12:10:00.000Z",
    type: "compaction",
    session: "sess-1",
    source: "learning",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Observation type construction — each variant is well-formed
// ---------------------------------------------------------------------------

describe("Observation construction — all 5 variants", () => {
  test("user_message has the locked schema fields", () => {
    const obs = makeUserMessage();
    expect(obs.type).toBe("user_message");
    expect(obs.source).toBe("learning");
    expect(typeof obs.ts).toBe("string");
    expect(typeof obs.session).toBe("string");
    expect(typeof obs.agent).toBe("string");
    expect(obs.parent).toBeNull();
    expect(typeof obs.text).toBe("string");
  });

  test("tool_call_start has args object and call_id", () => {
    const obs = makeToolCallStart();
    expect(obs.type).toBe("tool_call_start");
    expect(obs.source).toBe("learning");
    expect(typeof obs.call_id).toBe("string");
    expect(typeof obs.args).toBe("object");
    // Agent is nullable on tool calls
    expect(obs.agent === null || typeof obs.agent === "string").toBe(true);
  });

  test("tool_call_end carries success and duration_ms", () => {
    const obs = makeToolCallEnd();
    expect(obs.type).toBe("tool_call_end");
    expect(typeof obs.success).toBe("boolean");
    expect(typeof obs.duration_ms).toBe("number");
    expect(obs.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("session_end carries duration, tool_count, files_modified", () => {
    const obs = makeSessionEnd();
    expect(obs.type).toBe("session_end");
    expect(typeof obs.duration_ms).toBe("number");
    expect(typeof obs.tool_count).toBe("number");
    expect(typeof obs.files_modified).toBe("boolean");
  });

  test("compaction has only the base fields", () => {
    const obs = makeCompaction();
    expect(obs.type).toBe("compaction");
    expect(obs.source).toBe("learning");
    // No extra discriminator fields — keep this assertion minimal so the
    // test doesn't break when (if) we add metadata later.
  });
});

// ---------------------------------------------------------------------------
// 2. Self-event filter shape — every observation carries source: "learning"
// ---------------------------------------------------------------------------

describe("Self-event filter — every observation has source: 'learning'", () => {
  test("all 5 variants emit source: 'learning'", () => {
    const all: Observation[] = [
      makeUserMessage(),
      makeToolCallStart(),
      makeToolCallEnd(),
      makeSessionEnd(),
      makeCompaction(),
    ];
    for (const obs of all) {
      expect(obs.source).toBe("learning");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. JSONL serialization — append-only newline-terminated JSON
// ---------------------------------------------------------------------------

describe("writeObservation — JSONL serialization", () => {
  test("a single write produces one line ending in newline", () => {
    const obs = makeUserMessage();
    writeObservation(tempFile, obs);

    const raw = fs.readFileSync(tempFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);

    const parsed = JSON.parse(raw.trim()) as Observation;
    expect(parsed.type).toBe("user_message");
    expect(parsed.source).toBe("learning");
  });

  test("multiple writes accumulate in order, one line each", () => {
    const a = makeUserMessage({ text: "first" });
    const b = makeToolCallStart({ call_id: "call-1" });
    const c = makeToolCallEnd({ call_id: "call-1", duration_ms: 100 });
    const d = makeCompaction();
    writeObservation(tempFile, a);
    writeObservation(tempFile, b);
    writeObservation(tempFile, c);
    writeObservation(tempFile, d);

    const lines = readObservations(tempFile);
    expect(lines).toHaveLength(4);
    expect(lines[0]?.type).toBe("user_message");
    expect(lines[1]?.type).toBe("tool_call_start");
    expect(lines[2]?.type).toBe("tool_call_end");
    expect(lines[3]?.type).toBe("compaction");
  });

  test("each line is valid JSON parseable independently", () => {
    writeObservation(tempFile, makeUserMessage());
    writeObservation(tempFile, makeToolCallStart());
    writeObservation(tempFile, makeSessionEnd());

    const raw = fs.readFileSync(tempFile, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("never throws on a write to a non-existent directory", () => {
    // Hook-handler invariant: writeObservation must swallow disk errors.
    const badPath = path.join(
      os.tmpdir(),
      `does-not-exist-${Date.now()}`,
      "observations.jsonl",
    );
    expect(() => writeObservation(badPath, makeUserMessage())).not.toThrow();
  });

  test("complex nested args round-trip through JSONL", () => {
    const obs = makeToolCallStart({
      args: {
        nested: { a: 1, b: ["x", "y"] },
        flag: true,
        n: 3.14,
      },
    });
    writeObservation(tempFile, obs);
    const lines = readObservations(tempFile);
    expect(lines).toHaveLength(1);
    const first = lines[0];
    expect(first?.type).toBe("tool_call_start");
    if (first?.type === "tool_call_start") {
      expect(first.args).toEqual({
        nested: { a: 1, b: ["x", "y"] },
        flag: true,
        n: 3.14,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Redaction integration — hook-path behavior
// ---------------------------------------------------------------------------

describe("Redaction integration — secrets are scrubbed before write", () => {
  test("user_message text redacts an Anthropic API key (prefix pattern)", () => {
    // Constructed so the prefix detector fires. The redaction.test.ts
    // suite covers detection breadth — we only need to confirm that the
    // hook-path wiring (redactString → writeObservation) preserves it.
    const secret = "sk-ant-api03-" + "A".repeat(95);
    const text = `Here is my key: ${secret}`;
    const obs = makeUserMessage({ text: redactString(text) });
    writeObservation(tempFile, obs);

    const lines = readObservations(tempFile);
    expect(lines).toHaveLength(1);
    const parsed = lines[0];
    expect(parsed?.type).toBe("user_message");
    if (parsed?.type === "user_message") {
      expect(parsed.text).not.toContain(secret);
      expect(parsed.text).toContain("<REDACTED:");
    }
  });

  test("tool_call_start drops content fields for edit tool", () => {
    // Redaction's tool-specific pass drops `oldString`/`newString`/`content`
    // from edit-tool args. Verify the hook-wiring path matches.
    const args = redactToolArgs("edit", {
      filePath: "/tmp/foo.txt",
      oldString: "secret value here",
      newString: "another secret",
    });
    const obs = makeToolCallStart({ tool: "edit", args });
    writeObservation(tempFile, obs);

    const lines = readObservations(tempFile);
    const parsed = lines[0];
    expect(parsed?.type).toBe("tool_call_start");
    if (parsed?.type === "tool_call_start") {
      expect(parsed.args).not.toHaveProperty("oldString");
      expect(parsed.args).not.toHaveProperty("newString");
      expect(parsed.args.filePath).toBe("/tmp/foo.txt");
      expect(parsed.args._content_dropped).toBe(true);
    }
  });

  test("env-var-keyed values get redacted recursively", () => {
    const args = redactToolArgs("bash", {
      command: "deploy.sh",
      env: { DATABASE_PASSWORD: "hunter2hunter2", PATH: "/usr/bin" },
    });
    const obs = makeToolCallStart({ tool: "bash", args });
    writeObservation(tempFile, obs);

    const lines = readObservations(tempFile);
    const parsed = lines[0];
    if (parsed?.type === "tool_call_start") {
      const env = parsed.args.env as Record<string, unknown>;
      expect(env.DATABASE_PASSWORD).toBe("<REDACTED:env-var>");
      expect(env.PATH).toBe("/usr/bin"); // PATH is not a sensitive name
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Latency benchmark — must stay well under the 5ms hook budget
// ---------------------------------------------------------------------------

describe("Hook latency budget", () => {
  test("p99 of construct + serialize + write < 5ms", () => {
    const ITERATIONS = 1000;
    const samples: number[] = [];

    // Representative observation: the heaviest of the five types is
    // tool_call_start with redaction applied. We construct a non-trivial
    // args payload to stress the JSON serializer.
    const baseArgs = {
      command: 'echo "hello world" && grep -r "pattern" .',
      cwd: "/Users/test/project",
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    };

    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const args = redactToolArgs("bash", baseArgs);
      const obs: ToolCallStartObservation = {
        ts: new Date().toISOString(),
        type: "tool_call_start",
        session: "sess-bench",
        source: "learning",
        agent: "operate",
        tool: "bash",
        call_id: `call-${i}`,
        args,
      };
      writeObservation(tempFile, obs);
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(ITERATIONS * 0.5)] ?? 0;
    const p99 = samples[Math.floor(ITERATIONS * 0.99)] ?? 0;
    const max = samples[samples.length - 1] ?? 0;

    // Diagnostic for the test log — visible alongside the redaction perf.
    console.log(
      `[perf] observation hook: p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms over ${ITERATIONS} iterations`,
    );

    // Hook latency budget is 5ms. Allow generous margin in the test (3ms p99)
    // because file I/O on slow CI disks can spike. If this fails, the budget
    // is genuinely at risk.
    expect(p99).toBeLessThan(3);
  });
});
