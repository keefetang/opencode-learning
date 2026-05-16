/**
 * Unit tests for session-state.ts — session manager lifecycle and stale sweep.
 *
 * Tests cover:
 *  - Basic CRUD (getOrCreate, get, delete)
 *  - Stale-entry sweep when Map exceeds 50 entries with >5min idle
 *  - Recently active sessions survive sweep even over threshold
 *  - Sessions under threshold are NOT swept
 */

import { describe, expect, test } from "bun:test";

import { createSessionManager } from "../src/session-state.js";

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe("session manager — basic operations", () => {
  test("getOrCreate returns a new session with expected defaults", () => {
    const mgr = createSessionManager();
    const session = mgr.getOrCreate("sess-1");

    expect(session.sessionId).toBe("sess-1");
    expect(session.toolCallCount).toBe(0);
    expect(session.filesModified).toBe(false);
    expect(session.agent).toBeNull();
    expect(session.toolCallStartTimes.size).toBe(0);
    expect(session.startTime).toBeGreaterThan(0);
    expect(session.lastActivityTime).toBeGreaterThan(0);
  });

  test("getOrCreate returns the same object on second call", () => {
    const mgr = createSessionManager();
    const first = mgr.getOrCreate("sess-1");
    first.toolCallCount = 5;
    const second = mgr.getOrCreate("sess-1");
    expect(second).toBe(first);
    expect(second.toolCallCount).toBe(5);
  });

  test("get returns undefined for non-existent sessions", () => {
    const mgr = createSessionManager();
    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  test("get returns the session after getOrCreate", () => {
    const mgr = createSessionManager();
    mgr.getOrCreate("sess-1");
    const fetched = mgr.get("sess-1");
    expect(fetched).toBeDefined();
    expect(fetched!.sessionId).toBe("sess-1");
  });

  test("delete removes a session", () => {
    const mgr = createSessionManager();
    mgr.getOrCreate("sess-1");
    expect(mgr.get("sess-1")).toBeDefined();
    mgr.delete("sess-1");
    expect(mgr.get("sess-1")).toBeUndefined();
  });

  test("delete on non-existent session does not throw", () => {
    const mgr = createSessionManager();
    expect(() => mgr.delete("ghost")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stale-entry sweep
// ---------------------------------------------------------------------------

describe("session manager — stale entry sweep", () => {
  // Known values from session-state.ts (not exported — hardcoded here to
  // avoid changing the module's API for tests).
  const STALE_THRESHOLD_MS = 5 * 60 * 1_000; // 5 minutes
  const SWEEP_SIZE_THRESHOLD = 50;

  test("sweep removes stale entries when Map exceeds threshold", () => {
    const mgr = createSessionManager();
    const staleTime = Date.now() - STALE_THRESHOLD_MS - 1_000; // 6 min ago

    // Create 51 sessions, all stale
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD + 1; i++) {
      const session = mgr.getOrCreate(`stale-${i}`);
      session.lastActivityTime = staleTime;
    }

    // Creating one more session triggers the sweep inside getOrCreate
    const fresh = mgr.getOrCreate("fresh-trigger");
    expect(fresh).toBeDefined();

    // All stale sessions should be gone
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD + 1; i++) {
      expect(mgr.get(`stale-${i}`)).toBeUndefined();
    }

    // The fresh trigger session should still exist
    expect(mgr.get("fresh-trigger")).toBeDefined();
  });

  test("recently active sessions survive sweep even when over threshold", () => {
    const mgr = createSessionManager();
    const staleTime = Date.now() - STALE_THRESHOLD_MS - 1_000;

    // Create 50 stale sessions
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD; i++) {
      const session = mgr.getOrCreate(`stale-${i}`);
      session.lastActivityTime = staleTime;
    }

    // Add 5 recently-active sessions
    for (let i = 0; i < 5; i++) {
      const session = mgr.getOrCreate(`active-${i}`);
      session.lastActivityTime = Date.now(); // just now
    }

    // Trigger sweep by creating one more session (total > 50)
    mgr.getOrCreate("trigger");

    // Stale sessions should be swept
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD; i++) {
      expect(mgr.get(`stale-${i}`)).toBeUndefined();
    }

    // Active sessions must survive
    for (let i = 0; i < 5; i++) {
      expect(mgr.get(`active-${i}`)).toBeDefined();
    }
    expect(mgr.get("trigger")).toBeDefined();
  });

  test("sessions under threshold are NOT swept", () => {
    const mgr = createSessionManager();
    const staleTime = Date.now() - STALE_THRESHOLD_MS - 1_000;

    // Create exactly 50 sessions (at threshold, not over)
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD; i++) {
      const session = mgr.getOrCreate(`session-${i}`);
      session.lastActivityTime = staleTime;
    }

    // Getting an existing session should not trigger sweep
    const existing = mgr.getOrCreate("session-0");
    expect(existing).toBeDefined();

    // All sessions should still be present — no sweep happened
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD; i++) {
      expect(mgr.get(`session-${i}`)).toBeDefined();
    }
  });

  test("getOrCreate for existing session returns early without sweeping", () => {
    const mgr = createSessionManager();

    // Create 51 sessions that are NOT stale (recently active)
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD + 1; i++) {
      mgr.getOrCreate(`s-${i}`);
      // lastActivityTime is set to Date.now() by default — these are active
    }

    // Now mark them all as stale
    const staleTime = Date.now() - STALE_THRESHOLD_MS - 1_000;
    for (let i = 0; i < SWEEP_SIZE_THRESHOLD + 1; i++) {
      const session = mgr.get(`s-${i}`);
      if (session) session.lastActivityTime = staleTime;
    }

    // Accessing an existing session should return it without sweeping
    const existing = mgr.getOrCreate("s-0");
    expect(existing).toBeDefined();
    expect(existing.sessionId).toBe("s-0");

    // All sessions should still be there — getOrCreate returned early
    expect(mgr.get("s-10")).toBeDefined();

    // Now create a genuinely NEW session — this triggers the sweep
    mgr.getOrCreate("new-session");

    // All stale sessions should be swept
    expect(mgr.get("s-10")).toBeUndefined();
    expect(mgr.get("new-session")).toBeDefined();
  });
});
