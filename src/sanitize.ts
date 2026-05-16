/**
 * sanitize.ts — Field-level sanitization for observation data.
 *
 * Strategy: drop fields known to carry arbitrary file content (edit content,
 * write content) and truncate fields that carry useful signal but may contain
 * secrets (bash commands). Keep structural metadata (file paths, tool flags,
 * offsets). Unknown tools and fields are kept as-is.
 *
 * No pattern-based redaction — the observations file lives locally in the
 * user's own repo. User message text is truncated to a short summary.
 */

/** Maximum length for user message text summaries. */
export const TEXT_SUMMARY_LIMIT = 100;

/**
 * Truncate user message text to a summary. No pattern-based redaction —
 * the truncation itself limits exposure, and the text is the user's own
 * input written to a local file they already have access to.
 */
export function summarizeText(text: string): string {
  if (text.length <= TEXT_SUMMARY_LIMIT) return text;
  return text.slice(0, TEXT_SUMMARY_LIMIT) + `…<${text.length - TEXT_SUMMARY_LIMIT} more>`;
}

// Fields dropped entirely per tool. File contents may contain secrets
// we can't reliably detect via pattern matching.
const DROP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  edit: ["content", "oldString", "newString"],
  write: ["content"],
};

// Fields truncated (not dropped) per tool. Bash commands are the most
// useful signal for pattern extraction — "bun test" vs "curl -H 'Auth..."
// — so we keep a short summary rather than dropping entirely.
const SUMMARIZE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command"],
};

/**
 * Sanitize tool arguments by dropping or truncating sensitive fields.
 *
 * - edit: drops content, oldString, newString (file contents)
 * - write: drops content (file contents)
 * - bash: truncates command to TEXT_SUMMARY_LIMIT (preserves signal, limits exposure)
 * - all others: shallow copy, no modifications
 *
 * Returns a new object — does not mutate input.
 */
export function sanitizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const dropFields = DROP_FIELDS[toolName];
  const summarizeFields = SUMMARIZE_FIELDS[toolName];

  if (dropFields === undefined && summarizeFields === undefined) {
    // Unknown tool — return a shallow copy (no fields to drop or summarize)
    return { ...args };
  }

  const result: Record<string, unknown> = {};
  let dropped = false;
  for (const [key, value] of Object.entries(args)) {
    if (dropFields?.includes(key)) {
      dropped = true;
    } else if (summarizeFields?.includes(key) && typeof value === "string") {
      result[key] = summarizeText(value);
    } else {
      result[key] = value;
    }
  }
  if (dropped) {
    result._content_dropped = true;
  }
  return result;
}
