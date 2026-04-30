/**
 * safe-execute.ts — Try/catch wrapper for hook handlers.
 *
 * Every hook handler in this plugin MUST be wrapped in safeExecute.
 * A thrown error in most hooks kills the user's session entirely
 * (verified in sst/opencode framework source — see anchor.md A.5).
 * The framework provides NO safety net for most hook types.
 */

import type { PluginInput } from "@opencode-ai/plugin";

type PluginClient = PluginInput["client"];

/**
 * Wraps an async function so thrown errors are caught, logged, and swallowed.
 *
 * @param name - Hook name for log messages (e.g., "tool.execute.after")
 * @param fn - The async function to execute
 * @param client - Plugin client for `client.app.log`
 * @param fallback - Value to return on error (defaults to undefined)
 * @returns The function's return value, or fallback on error
 */
export async function safeExecute<T>(
  name: string,
  fn: () => Promise<T>,
  client: PluginClient,
  fallback?: T,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err: unknown) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    void client.app.log({
      body: {
        service: "opencode-learning",
        level: "error",
        message: `[${name}] Error: ${message}`,
      },
    });
    return fallback;
  }
}
