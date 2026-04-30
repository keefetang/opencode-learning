/**
 * session-state.ts — In-memory session state tracking.
 *
 * Tracks per-session metadata (tool calls, file modifications, timing)
 * in a closure-scoped Map. Entries are cleaned up on session.idle events
 * and via a sweep when the Map grows beyond a threshold.
 *
 * This data is NOT persisted — it's used to annotate observations
 * and detect session boundaries.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string;
  /**
   * First observed activity time for this session, NOT the true session
   * creation time. If a session begins with `tool.execute.before` (e.g.,
   * a subagent invocation that fires a tool before any chat.message),
   * `startTime` will be the tool start, not the session creation. This
   * means `session_end.duration_ms` may undercount for tool-first sessions.
   * The true creation time would require an HTTP `client.session.get(...)`
   * which would blow the 5ms hook latency budget — accepted limitation
   * for v1.
   */
  startTime: number;
  toolCallCount: number;
  filesModified: boolean;
  lastActivityTime: number;
  /**
   * Agent name (e.g. "operate", "scope", "execute") cached from the most
   * recent `chat.message` hook. Null until the first chat.message in this
   * session — tool.execute.* hooks may fire with `agent: null` if no
   * chat.message preceded them. Acceptable per delegation.
   */
  agent: string | null;
  /**
   * Map of `callID -> startTime ms` for in-flight tool calls. Set on
   * `tool.execute.before`, read+deleted on `tool.execute.after` to compute
   * `duration_ms`. Any unmatched entries (tool started but never ended) are
   * cleared on session.idle to prevent unbounded growth.
   */
  toolCallStartTimes: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Session Map with idle cleanup
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 5 * 60 * 1_000; // 5 minutes
const SWEEP_SIZE_THRESHOLD = 50;

/**
 * Create a session state manager with automatic stale-entry cleanup.
 *
 * The cleanup pattern matches context-guard: sweep entries older than
 * 5 minutes when the Map grows beyond 50 entries. Primary cleanup
 * happens via session.idle event; the sweep is a safety net.
 */
export function createSessionManager() {
  const sessions = new Map<string, SessionState>();

  /**
   * Sweep stale entries from the Map.
   * Called when Map size exceeds threshold to prevent unbounded growth.
   */
  function sweepStale(): void {
    if (sessions.size <= SWEEP_SIZE_THRESHOLD) return;

    const cutoff = Date.now() - STALE_THRESHOLD_MS;
    for (const [id, session] of sessions) {
      if (session.lastActivityTime < cutoff) {
        sessions.delete(id);
      }
    }
  }

  return {
    /**
     * Get or create a SessionState for the given session ID.
     * Triggers a stale-entry sweep if the Map has grown too large.
     */
    getOrCreate(sessionId: string): SessionState {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) return existing;

      sweepStale();

      const now = Date.now();
      const session: SessionState = {
        sessionId,
        startTime: now,
        toolCallCount: 0,
        filesModified: false,
        lastActivityTime: now,
        agent: null,
        toolCallStartTimes: new Map(),
      };
      sessions.set(sessionId, session);
      return session;
    },

    /** Get a session without creating one. */
    get(sessionId: string): SessionState | undefined {
      return sessions.get(sessionId);
    },

    /** Remove a session (typically on session.idle). */
    delete(sessionId: string): void {
      sessions.delete(sessionId);
    },
  };
}
