/**
 * Unit tests for sanitize.ts — field-level sanitization for observations.
 *
 * Covers:
 *  - summarizeText: truncation with marker, pass-through for short strings
 *  - sanitizeToolArgs: per-tool field drops, _content_dropped marker,
 *    no-mutation guarantee, shallow-copy for unknown tools
 */

import { describe, expect, test } from "bun:test";

import {
  TEXT_SUMMARY_LIMIT,
  sanitizeToolArgs,
  summarizeText,
} from "../src/sanitize.js";

// ---------------------------------------------------------------------------
// summarizeText
// ---------------------------------------------------------------------------

describe("summarizeText", () => {
  test("empty string passes through", () => {
    expect(summarizeText("")).toBe("");
  });

  test("string under limit passes through unchanged", () => {
    const short = "hello world";
    expect(summarizeText(short)).toBe(short);
  });

  test("string exactly at limit passes through unchanged", () => {
    const exact = "a".repeat(TEXT_SUMMARY_LIMIT);
    expect(summarizeText(exact)).toBe(exact);
  });

  test("string over limit is truncated with marker showing count", () => {
    const over = "b".repeat(TEXT_SUMMARY_LIMIT + 50);
    const result = summarizeText(over);
    expect(result.startsWith("b".repeat(TEXT_SUMMARY_LIMIT))).toBe(true);
    expect(result).toContain("…<50 more>");
    expect(result.length).toBeLessThan(over.length);
  });

  test("long multi-line text is truncated", () => {
    const lines = "line of text here\n".repeat(20); // well over 100 chars
    const result = summarizeText(lines);
    expect(result.length).toBeLessThan(lines.length);
    expect(result).toContain("…<");
    expect(result).toContain(" more>");
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolArgs — edit tool
// ---------------------------------------------------------------------------

describe("sanitizeToolArgs — edit", () => {
  test("drops oldString, newString, content and sets _content_dropped", () => {
    const result = sanitizeToolArgs("edit", {
      filePath: "/tmp/foo.ts",
      oldString: "secret old value",
      newString: "secret new value",
      content: "full file content",
      replaceAll: false,
    });
    expect(result.filePath).toBe("/tmp/foo.ts");
    expect(result.replaceAll).toBe(false);
    expect(result._content_dropped).toBe(true);
    expect(result.oldString).toBeUndefined();
    expect(result.newString).toBeUndefined();
    expect(result.content).toBeUndefined();
  });

  test("keeps filePath and other metadata fields", () => {
    const result = sanitizeToolArgs("edit", {
      filePath: "/path/to/file.ts",
      oldString: "x",
    });
    expect(result.filePath).toBe("/path/to/file.ts");
    expect(result._content_dropped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolArgs — write tool
// ---------------------------------------------------------------------------

describe("sanitizeToolArgs — write", () => {
  test("drops content and sets _content_dropped, keeps filePath", () => {
    const result = sanitizeToolArgs("write", {
      filePath: "/output.json",
      content: '{"secret":"value"}',
    });
    expect(result.filePath).toBe("/output.json");
    expect(result.content).toBeUndefined();
    expect(result._content_dropped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolArgs — bash tool
// ---------------------------------------------------------------------------

describe("sanitizeToolArgs — bash", () => {
  test("short command is kept as-is", () => {
    const result = sanitizeToolArgs("bash", {
      command: "bun test",
      description: "run tests",
      timeout: 30000,
    });
    expect(result.command).toBe("bun test");
    expect(result.description).toBe("run tests");
    expect(result.timeout).toBe(30000);
    expect(result._content_dropped).toBeUndefined();
  });

  test("long command is truncated (not dropped)", () => {
    const longCommand = "curl -H 'Authorization: Bearer " + "x".repeat(200) + "' https://api.example.com";
    const result = sanitizeToolArgs("bash", {
      command: longCommand,
      description: "fetch user info",
    });
    expect(typeof result.command).toBe("string");
    expect((result.command as string).length).toBeLessThan(longCommand.length);
    expect((result.command as string)).toContain("…<");
    expect(result.description).toBe("fetch user info");
    expect(result._content_dropped).toBeUndefined();
  });

  test("keeps workdir and other non-command fields", () => {
    const result = sanitizeToolArgs("bash", {
      command: "ls -la",
      workdir: "/home/user/project",
    });
    expect(result.command).toBe("ls -la");
    expect(result.workdir).toBe("/home/user/project");
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolArgs — read tool (no drops)
// ---------------------------------------------------------------------------

describe("sanitizeToolArgs — read (no drops)", () => {
  test("keeps all fields unchanged", () => {
    const result = sanitizeToolArgs("read", {
      filePath: "/path/to/file.md",
      offset: 100,
      limit: 50,
    });
    expect(result.filePath).toBe("/path/to/file.md");
    expect(result.offset).toBe(100);
    expect(result.limit).toBe(50);
    expect(result._content_dropped).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolArgs — unknown tool
// ---------------------------------------------------------------------------

describe("sanitizeToolArgs — unknown tool", () => {
  test("keeps all fields, returns shallow copy", () => {
    const input = { foo: "bar", nested: { a: 1 } };
    const result = sanitizeToolArgs("custom_tool", input);
    expect(result.foo).toBe("bar");
    expect(result.nested).toEqual({ a: 1 });
    expect(result._content_dropped).toBeUndefined();
    // Shallow copy — same nested reference
    expect(result.nested).toBe(input.nested);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("sanitizeToolArgs — does not mutate input", () => {
  test("edit: input object unchanged after sanitization", () => {
    const input = {
      filePath: "/tmp/foo.ts",
      oldString: "x",
      newString: "y",
      content: "z",
    };
    const snapshot = JSON.stringify(input);
    sanitizeToolArgs("edit", input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("unknown tool: input object unchanged after sanitization", () => {
    const input = { foo: "bar" };
    const snapshot = JSON.stringify(input);
    sanitizeToolArgs("whatever", input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
