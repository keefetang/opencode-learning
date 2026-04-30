/**
 * Unit tests for the redaction engine.
 *
 * Goals:
 *  - Verify all three passes redact what they should
 *  - Verify negative cases pass through unchanged
 *  - Verify object recursion, env-var rule, tool-specific behavior
 *  - Verify performance budget (< 50µs per call on 1KB input)
 *
 * Test framework: bun:test (OpenCode runs on Bun).
 */

import { describe, expect, test } from "bun:test";

import {
  TRUNCATION_LIMIT,
  redactObject,
  redactString,
  redactToolArgs,
  truncateString,
} from "../src/redaction.js";
import { shannonEntropy } from "../src/entropy.js";

import { MULTI_SECRET_CASES, POSITIVE_CASES } from "./fixtures/secrets.js";
import { NEGATIVE_CASES, OBJECT_NEGATIVE_CASES } from "./fixtures/non-secrets.js";

// ---------------------------------------------------------------------------
// Pass 1 + Pass 2 + Pass 3 — positive cases (should redact)
// ---------------------------------------------------------------------------

describe("redactString — positive cases (should redact)", () => {
  for (const c of POSITIVE_CASES) {
    test(c.name, () => {
      const out = redactString(c.input);
      expect(out).toContain(`<REDACTED:${c.expectedLabel}>`);
      // The original secret content should not survive intact. We sample by
      // checking that the input string is not equal to the output.
      expect(out).not.toBe(c.input);
    });
  }
});

describe("redactString — multi-secret cases", () => {
  for (const c of MULTI_SECRET_CASES) {
    test(c.name, () => {
      const out = redactString(c.input);
      for (const label of c.expectedLabels) {
        expect(out).toContain(`<REDACTED:${label}>`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Negative cases — should NOT redact
// ---------------------------------------------------------------------------

describe("redactString — negative cases (should not redact)", () => {
  for (const c of NEGATIVE_CASES) {
    test(c.name, () => {
      const out = redactString(c.input);
      expect(out).toBe(c.input);
      expect(out).not.toContain("<REDACTED:");
    });
  }
});

describe("redactObject — object-shaped negative cases", () => {
  for (const c of OBJECT_NEGATIVE_CASES) {
    test(c.name, () => {
      const out = redactObject(c.input);
      // Output should equal input in structure, with no REDACTED markers
      expect(JSON.stringify(out)).toBe(JSON.stringify(c.input));
      expect(JSON.stringify(out)).not.toContain("<REDACTED:");
    });
  }
});

// ---------------------------------------------------------------------------
// Connection-string Pass 2 — verify scheme/user preservation
// ---------------------------------------------------------------------------

describe("connection-string redaction preserves scheme and host", () => {
  test("MongoDB: preserves scheme, user, host; redacts password", () => {
    const out = redactString(
      "mongodb://admin:s3cr3tP%40ssw0rd@db.example.com:27017/mydb",
    );
    expect(out).toContain("mongodb://admin:");
    expect(out).toContain("<REDACTED:db-password>");
    expect(out).toContain("@db.example.com:27017/mydb");
    expect(out).not.toContain("s3cr3tP");
  });

  test("HTTPS basic auth: user preserved, password redacted", () => {
    const out = redactString("https://alice:s3kr3tval@example.com/path");
    expect(out).toContain("https://alice:");
    expect(out).toContain("<REDACTED:db-password>");
    expect(out).toContain("@example.com/path");
  });

  test("plain HTTPS URL without auth not affected", () => {
    const url = "https://example.com/api/v1/things";
    expect(redactString(url)).toBe(url);
  });

  test("password containing unencoded @ is fully redacted", () => {
    // Real-world hazard: copy-pasted configs leave @ unencoded inside the
    // password. Greedy-with-host-shape regex must consume the entire
    // password tail, not stop at the first @.
    const out = redactString(
      "mongodb://admin:s3cr3tP@ssw0rd@db.example.com:27017/mydb",
    );
    expect(out).toContain("mongodb://admin:");
    expect(out).toContain("<REDACTED:db-password>");
    expect(out).toContain("@db.example.com:27017/mydb");
    // The whole password (including the tail past the embedded @) must be gone.
    expect(out).not.toContain("s3cr3tP");
    expect(out).not.toContain("ssw0rd");
  });
});

// ---------------------------------------------------------------------------
// Object recursion + env-var rule
// ---------------------------------------------------------------------------

describe("redactObject — recursion and env-var rule", () => {
  test("env-var-style key redacts value unconditionally", () => {
    const out = redactObject({
      API_KEY: "low_entropy_value",
      DB_PASSWORD: "anything",
      MY_SECRET: "x",
    }) as Record<string, unknown>;

    expect(out.API_KEY).toBe("<REDACTED:env-var>");
    expect(out.DB_PASSWORD).toBe("<REDACTED:env-var>");
    expect(out.MY_SECRET).toBe("<REDACTED:env-var>");
  });

  test("camelCase keys do not trigger env-var rule", () => {
    const out = redactObject({
      apiKey: "regular_value_no_secret",
      authToken: "another_value",
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe("regular_value_no_secret");
    expect(out.authToken).toBe("another_value");
  });

  test("3-level nested redaction works", () => {
    const out = redactObject({
      level1: {
        level2: {
          level3: {
            API_KEY: "value",
            note: "ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
          },
        },
      },
    });
    const json = JSON.stringify(out);
    expect(json).toContain("<REDACTED:env-var>");
    expect(json).toContain("<REDACTED:github-token>");
  });

  test("array of strings is redacted element-wise", () => {
    const out = redactObject([
      "ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
      "normal string",
      "AKIAIOSFODNN7EXAMPLE",
    ]) as string[];

    expect(out[0]).toContain("<REDACTED:github-token>");
    expect(out[1]).toBe("normal string");
    expect(out[2]).toContain("<REDACTED:aws-access-key>");
  });

  test("non-string primitives pass through", () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
  });

  test("Date instance passes through unchanged (not destroyed)", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const out = redactObject(d);
    expect(out).toBeInstanceOf(Date);
    expect((out as Date).getTime()).toBe(d.getTime());
  });

  test("Error instance passes through unchanged (not destroyed)", () => {
    const e = new Error("boom");
    const out = redactObject(e);
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe("boom");
  });

  test("null-prototype plain objects are walked normally", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.API_KEY = "secret";
    const out = redactObject(obj) as Record<string, unknown>;
    expect(out.API_KEY).toBe("<REDACTED:env-var>");
  });

  test("env-var rule only fires on string values", () => {
    const out = redactObject({
      API_KEY: 42,
      DB_PASSWORD: true,
    }) as Record<string, unknown>;

    expect(out.API_KEY).toBe(42);
    expect(out.DB_PASSWORD).toBe(true);
  });

  test("does not mutate input", () => {
    const input = { API_KEY: "value", nested: { other: "x" } };
    const snapshot = JSON.stringify(input);
    redactObject(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("max depth bound prevents stack overflow", () => {
    // Build a deeply nested structure beyond the 32-level limit.
    type N = { next?: N };
    const deep: N = {};
    let cursor = deep;
    for (let i = 0; i < 50; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    // Should not throw.
    const out = redactObject(deep);
    expect(out).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tool-specific argument redaction
// ---------------------------------------------------------------------------

describe("redactToolArgs — tool-specific handling", () => {
  test("edit drops content fields, keeps filePath", () => {
    const out = redactToolArgs("edit", {
      filePath: "/path/to/file.ts",
      oldString: "secret_token_xyz",
      newString: "ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
      replaceAll: false,
    });

    expect(out.filePath).toBe("/path/to/file.ts");
    expect(out.replaceAll).toBe(false);
    expect(out._content_dropped).toBe(true);
    expect(out.oldString).toBeUndefined();
    expect(out.newString).toBeUndefined();
  });

  test("edit preserves unknown fields (schema-evolution safe)", () => {
    // If OpenCode adds a new flag to `edit`, we want it observed (redacted),
    // not silently dropped. Only the explicit content fields are dropped.
    const out = redactToolArgs("edit", {
      filePath: "/p/f.ts",
      futureFlag: "v1",
      oldString: "x",
    });
    expect(out.futureFlag).toBe("v1");
    expect(out.oldString).toBeUndefined();
  });

  test("write drops content, keeps filePath", () => {
    const out = redactToolArgs("write", {
      filePath: "/path/to/output.json",
      content: '{"API_KEY":"secret"}',
    });
    expect(out.filePath).toBe("/path/to/output.json");
    expect(out.content).toBeUndefined();
    expect(out._content_dropped).toBe(true);
  });

  test("read keeps known and unknown fields, applies redaction", () => {
    // We deliberately preserve unknown fields (with redaction applied) so
    // that schema additions in OpenCode's `read` tool aren't silently lost.
    const out = redactToolArgs("read", {
      filePath: "/path/to/file.md",
      offset: 100,
      limit: 50,
      futureFlag: "some-value",
    });
    expect(out.filePath).toBe("/path/to/file.md");
    expect(out.offset).toBe(100);
    expect(out.limit).toBe(50);
    expect(out.futureFlag).toBe("some-value");
  });

  test("bash redacts command field for embedded secrets", () => {
    const out = redactToolArgs("bash", {
      command: "curl -H 'Authorization: Bearer ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789' https://api.github.com",
      description: "fetch user info",
      timeout: 30000,
    });
    expect(typeof out.command).toBe("string");
    expect(out.command).toContain("<REDACTED:github-token>");
    expect(out.description).toBe("fetch user info");
    expect(out.timeout).toBe(30000);
  });

  test("unknown tool falls through to standard redactObject", () => {
    const out = redactToolArgs("custom_tool", {
      API_KEY: "sensitive",
      normal: "value",
    });
    expect(out.API_KEY).toBe("<REDACTED:env-var>");
    expect(out.normal).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("truncateString", () => {
  test("strings within limit pass through", () => {
    expect(truncateString("short")).toBe("short");
    expect(truncateString("a".repeat(TRUNCATION_LIMIT))).toBe(
      "a".repeat(TRUNCATION_LIMIT),
    );
  });

  test("strings over limit get truncation marker", () => {
    const overlong = "a".repeat(TRUNCATION_LIMIT + 100);
    const result = truncateString(overlong);
    expect(result.length).toBeLessThan(overlong.length);
    expect(result).toContain("<TRUNCATED:100>");
    expect(result.startsWith("a".repeat(TRUNCATION_LIMIT))).toBe(true);
  });

  test("custom limit honored", () => {
    expect(truncateString("hello world", 5)).toBe("hello<TRUNCATED:6>");
  });

  test("redactString applies truncation", () => {
    const overlong = "Just normal text. ".repeat(50); // ~900 chars, no secrets
    const result = redactString(overlong);
    expect(result.length).toBeLessThan(overlong.length);
    expect(result).toContain("<TRUNCATED:");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("redactString — edge cases", () => {
  test("empty string returns empty string", () => {
    expect(redactString("")).toBe("");
  });

  test("multi-line string evaluates each line independently", () => {
    const input = `line one is just normal text
secret value is k8X9pQrSt2vWxYz3aBc4dE5fGhI6jKlMn7oP
line three is also normal`;
    const out = redactString(input);
    expect(out).toContain("line one is just normal text");
    expect(out).toContain("line three is also normal");
    expect(out).toContain("<REDACTED:generic-secret>");
  });

  test("mixed content: secrets redacted, rest preserved", () => {
    const input =
      "Hello world! GitHub token is ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789, please don't share.";
    const out = redactString(input);
    expect(out).toContain("Hello world!");
    expect(out).toContain("please don't share.");
    expect(out).toContain("<REDACTED:github-token>");
  });

  test("redaction marker not double-redacted on second pass", () => {
    // A real prefix-pattern secret near a keyword. Should redact ONCE, with
    // the prefix label, not the generic-secret label.
    const input = "the auth token is ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789";
    const out = redactString(input);
    expect(out).toContain("<REDACTED:github-token>");
    expect(out).not.toContain("<REDACTED:generic-secret>");
  });

  test("JWT match does not bleed into adjacent words", () => {
    // Trailing word boundary keeps the match exact.
    const input =
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c moreText";
    const out = redactString(input);
    expect(out).toContain("<REDACTED:jwt>");
    expect(out).toContain(" moreText");
  });

  test("Discord webhook match does not bleed into adjacent text", () => {
    const input =
      "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz extraText";
    const out = redactString(input);
    expect(out).toContain("<REDACTED:discord-webhook>");
    expect(out).toContain(" extraText");
  });
});

// ---------------------------------------------------------------------------
// Shannon entropy unit tests (sanity checks on the helper)
// ---------------------------------------------------------------------------

describe("shannonEntropy", () => {
  test("empty string returns 0", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  test("uniform string has zero entropy", () => {
    expect(shannonEntropy("xxxxxxxxxx")).toBe(0);
  });

  test("random-looking high-entropy string >= 3.5", () => {
    expect(shannonEntropy("k8X9pQrSt2vWxYz3aBc4dE5fGhI")).toBeGreaterThanOrEqual(3.5);
  });

  test("low-entropy hex string still decent", () => {
    // 16 chars 0-9a-f uniform-ish: entropy ~3.8
    const e = shannonEntropy("0123456789abcdef0123456789abcdef");
    expect(e).toBeLessThan(4.1);
    expect(e).toBeGreaterThan(3.5);
  });
});

// ---------------------------------------------------------------------------
// Performance benchmark
// ---------------------------------------------------------------------------

describe("performance", () => {
  test("redactString averages <50µs on 1000-char mixed input", () => {
    // Mixed-content fixture representative of real observation data:
    // multi-line prose, several secret families across all 3 passes,
    // connection strings, file paths, tool-call-shaped fragments.
    // Target size: ~1KB (the original delegation's "1KB input" goal).
    const fixture =
      "User logged in via SSO. Authorization header sent: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c. " +
      "Connecting to mongodb://app:s3cr3tP@ssw0rd@cluster.example.com:27017/db. " +
      "Cloned from https://user:tokenval@github.com/foo/bar.git. " +
      "Made request with curl -H 'X-Key: ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789'. " +
      "Posted to Slack via xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx for the release notification. " +
      "Charged via stripe with sk_live_AbCdEfGhIjKlMnOpQrStUvWx and the response came back nominal. " +
      "Then ran ls /Users/keefe/Documents/keys.txt and read /etc/hosts for the " +
      "key insights. The API_KEY environment variable was unset, so the script " +
      "fell back to reading from ~/.config/credentials. " +
      "Got back AKIAIOSFODNN7EXAMPLE in the AWS metadata response and proceeded. " +
      "Sentry token sntryu_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef recorded the trace. " +
      "GitLab CI fetched glpat-xxxxxxxxxxxxxxxxxxxx during pipeline init. " +
      "The user pasted secret = k8X9pQrSt2vWxYz3aBc4dE5fGhI6jKlMn7oP into chat by mistake. " +
      "Logged 1234 bytes written, no error. Closed connection cleanly. " +
      "And finally a few normal lines of prose without any secret content at all, just plain text " +
      "describing what happened during the session, to round out the input to roughly one kilobyte.";

    // Sanity: ensure we're testing on >= 1000 chars (1KB target per delegation)
    expect(fixture.length).toBeGreaterThanOrEqual(1000);

    const iterations = 10_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      redactString(fixture);
    }
    const elapsedMs = performance.now() - start;
    const perCallMicros = (elapsedMs * 1000) / iterations;

    // Print for visibility regardless of pass/fail
    // eslint-disable-next-line no-console
    console.log(
      `[perf] redactString: ${perCallMicros.toFixed(2)}µs/call (${elapsedMs.toFixed(1)}ms over ${iterations} iterations)`,
    );

    // Assertion: total under 500ms. Generous enough to absorb GC noise and
    // CI variance, while still validating the 5ms hook budget can absorb
    // redaction comfortably.
    expect(elapsedMs).toBeLessThan(500);
  });

  test("redactString correctly handles fixture (correctness alongside perf)", () => {
    // The same fixture, redacted once, must contain expected markers.
    const fixture =
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c " +
      "mongodb://app:passwd@cluster.example.com/db " +
      "ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789 " +
      "AKIAIOSFODNN7EXAMPLE";
    const out = redactString(fixture);
    expect(out).toContain("<REDACTED:jwt>");
    expect(out).toContain("<REDACTED:db-password>");
    expect(out).toContain("<REDACTED:github-token>");
    expect(out).toContain("<REDACTED:aws-access-key>");
  });
});
