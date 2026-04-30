/**
 * Redaction engine — scrubs secrets from observation data before disk write.
 *
 * Three-pass strategy (in order):
 *   1. Prefix patterns — high-specificity, always redact (no context check)
 *   2. Connection strings — preserve scheme/host, redact password segment
 *   3. Context-aware generic — keyword + entropy threshold for the long tail
 *
 * Plus:
 *   - Env-var name heuristic for object keys (DB_PASSWORD, API_KEY, etc.)
 *   - Tool-specific arg redaction (drops content from edit/write/read)
 *   - Truncation at 500 chars with marker
 *
 * Performance note: all regexes are pre-compiled in redaction-patterns.ts.
 * Per-call work allocates only a few small strings. Benchmarked at ~10µs per
 * call on a 1KB input — well under the 5ms hook budget (anchor.md A.4).
 *
 * Conservative bias (anchor.md F): when in doubt, redact. False positives
 * (over-redaction) are cheap. Missed secrets are not.
 */

import { shannonEntropy } from "./entropy.js";
import {
  CANDIDATE_VALUE_REGEX,
  CONNECTION_STRING_PATTERN,
  ENTROPY_THRESHOLD,
  ENV_VAR_KEY_REGEX,
  KEYWORD_REGEX,
  PREFIX_PATTERNS,
  PROXIMITY_WINDOW,
} from "./redaction-patterns.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const TRUNCATION_LIMIT = 500;

// ---------------------------------------------------------------------------
// String redaction — three-pass pipeline
// ---------------------------------------------------------------------------

/**
 * Redact secrets from a string. Applies all three passes in order, then
 * truncates to TRUNCATION_LIMIT.
 *
 * Returns the input unchanged if it contains no detectable secrets and is
 * within the size limit. Empty strings pass through untouched.
 */
export function redactString(s: string): string {
  if (s.length === 0) return s;

  // Pass 1: prefix patterns
  let result = applyPrefixPatterns(s);

  // Pass 2: connection strings
  result = applyConnectionStringPattern(result);

  // Pass 3: context-aware generic (line-by-line for proximity check)
  result = applyContextAwarePass(result);

  // Truncation last so it doesn't split a redaction marker
  result = truncateString(result);

  return result;
}

/**
 * Truncate a string to `max` chars, appending a marker showing how many
 * characters were dropped. Defaults to TRUNCATION_LIMIT.
 */
export function truncateString(s: string, max: number = TRUNCATION_LIMIT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `<TRUNCATED:${s.length - max}>`;
}

// ---------------------------------------------------------------------------
// Object/array recursion
// ---------------------------------------------------------------------------

/**
 * Recursively redact all string values in an object/array. Non-string
 * primitives (numbers, booleans, null) are returned as-is. Object keys
 * matching ENV_VAR_KEY_REGEX trigger unconditional value redaction
 * regardless of pattern matches (catches proprietary token formats).
 *
 * Arrays preserve order. Objects preserve key order (ES2015 guarantee for
 * string keys). Returns a new structure — does not mutate input.
 */
export function redactObject(obj: unknown): unknown {
  return redactObjectInternal(obj, 0);
}

// Depth limit prevents stack overflow on pathological inputs (cycles or
// extremely deep trees). 32 levels is enormously generous for tool args.
const MAX_DEPTH = 32;

function redactObjectInternal(obj: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return "<REDACTED:max-depth>";
  }

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return redactString(obj);
  }

  if (typeof obj !== "object") {
    // numbers, booleans, bigints, symbols — pass through
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObjectInternal(item, depth + 1));
  }

  // Non-plain objects: Date, Error, Map, Set, RegExp, URL, class instances,
  // etc. Object.entries returns own enumerable string-keyed props, which is
  // usually empty for these — silently producing `{}` would lose data.
  // Pass them through unchanged; observation logs serialize via JSON.stringify
  // which handles Date/Error in conventional ways. Plain objects (including
  // Object.create(null)) are walked recursively.
  if (!isPlainObject(obj)) {
    return obj;
  }

  // Plain object
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === "string" && ENV_VAR_KEY_REGEX.test(key)) {
      // Env-var name heuristic: redact unconditionally regardless of value shape
      out[key] = `<REDACTED:env-var>`;
    } else {
      out[key] = redactObjectInternal(value, depth + 1);
    }
  }
  return out;
}

/**
 * True for plain objects: literals, Object.create(null), Object.create({}).
 * False for arrays, Date, Map, Set, RegExp, URL, Error, class instances, and
 * any other constructed object. Mirrors the lodash convention.
 */
function isPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

// ---------------------------------------------------------------------------
// Tool-specific argument redaction
// ---------------------------------------------------------------------------

// Fields that must be dropped (not just redacted) per tool. File contents
// may contain secrets we can't reliably detect, so we observe metadata only.
const DROP_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  edit: ["content", "oldString", "newString"],
  write: ["content"],
};

/**
 * Redact tool arguments with tool-specific handling:
 *
 *   - edit: drop `content`, `oldString`, `newString` (file contents)
 *   - write: drop `content` (file contents)
 *   - read: keep all known fields; we only worry about content if it leaks
 *     into args by mistake (it normally lives in tool output)
 *   - bash: apply standard redaction to all string fields
 *   - everything else: standard recursive redaction
 *
 * Unknown fields on edit/write/read are recursively redacted via redactObject
 * — additions to OpenCode's tool schema get redacted-and-preserved instead
 * of silently dropped. The only fields ever DROPPED are the explicit
 * sensitive-content list above.
 *
 * Always returns a new object — does not mutate input.
 */
export function redactToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // Start from the standard recursive redaction. This handles env-var-style
  // keys, recursion, and unknown fields uniformly.
  const redacted = redactObject(args) as Record<string, unknown>;

  const dropFields = DROP_FIELDS_BY_TOOL[toolName];
  if (dropFields !== undefined) {
    let dropped = false;
    for (const field of dropFields) {
      if (field in redacted) {
        delete redacted[field];
        dropped = true;
      }
    }
    if (dropped) {
      redacted._content_dropped = true;
    }
  }

  return redacted;
}

// ---------------------------------------------------------------------------
// Pass 1: prefix patterns
// ---------------------------------------------------------------------------

function applyPrefixPatterns(s: string): string {
  let result = s;
  // String.prototype.replace with a global regex ignores lastIndex and
  // always scans from the start, so we don't need to reset it here. It's
  // also a no-op when no match exists, so we don't pre-test either.
  for (const { name, pattern } of PREFIX_PATTERNS) {
    result = result.replace(pattern, `<REDACTED:${name}>`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pass 2: connection-string scanner
// ---------------------------------------------------------------------------

function applyConnectionStringPattern(s: string): string {
  return s.replace(
    CONNECTION_STRING_PATTERN,
    (_match, scheme: string, user: string, _password: string, host: string) => {
      return `${scheme}://${user}:<REDACTED:db-password>@${host}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Pass 3: context-aware generic
//
// Strategy:
//   1. Split on newlines (each line evaluated independently)
//   2. For each line, find all keyword positions
//   3. For each candidate value, check if any keyword sits within
//      PROXIMITY_WINDOW chars
//   4. If yes AND entropy >= threshold AND not already a known marker, redact
//
// Exclusions: candidates already inside <REDACTED:...> markers (from earlier
// passes) are skipped to avoid double-redaction.
// ---------------------------------------------------------------------------

function applyContextAwarePass(s: string): string {
  // Fast path: no keyword anywhere → nothing to do
  KEYWORD_REGEX.lastIndex = 0;
  if (!KEYWORD_REGEX.test(s)) return s;

  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const newLine = applyContextAwarePassLine(line);
    if (newLine !== line) lines[i] = newLine;
  }
  return lines.join("\n");
}

function applyContextAwarePassLine(line: string): string {
  // Collect keyword positions and end-positions on this line. The end is
  // needed because we require keyword-left-of-candidate (assignment shape).
  KEYWORD_REGEX.lastIndex = 0;
  const keywordEnds: number[] = [];
  let kwMatch: RegExpExecArray | null;
  while ((kwMatch = KEYWORD_REGEX.exec(line)) !== null) {
    keywordEnds.push(kwMatch.index + kwMatch[0].length);
    // Avoid zero-width infinite loop on degenerate match
    if (kwMatch.index === KEYWORD_REGEX.lastIndex) KEYWORD_REGEX.lastIndex++;
  }
  if (keywordEnds.length === 0) return line;

  // Walk candidate values and redact those near a keyword with high entropy
  CANDIDATE_VALUE_REGEX.lastIndex = 0;
  const replacements: Array<{ start: number; end: number }> = [];
  let cMatch: RegExpExecArray | null;
  while ((cMatch = CANDIDATE_VALUE_REGEX.exec(line)) !== null) {
    const candidate = cMatch[0];
    const start = cMatch.index;
    const end = start + candidate.length;

    if (cMatch.index === CANDIDATE_VALUE_REGEX.lastIndex) {
      CANDIDATE_VALUE_REGEX.lastIndex++;
    }

    // Skip if this candidate is inside an existing <REDACTED:...> marker
    if (isInsideRedactionMarker(line, start, end)) continue;

    // Skip path-like candidates (false-positive on file paths). A path-like
    // candidate is one that contains '/' AND has no '=' assignment on its
    // left side. Real secret assignments look like `KEY=val` or `key: val`.
    if (looksLikePath(candidate)) continue;

    // Require a keyword whose END falls within PROXIMITY_WINDOW chars BEFORE
    // the candidate. This enforces assignment-style shape (`key=value`,
    // `secret: value`, `bearer TOKEN`) and prevents matches where the keyword
    // is embedded inside a file path or URL fragment.
    if (!hasKeywordToLeft(keywordEnds, start)) continue;

    // Entropy gate
    const entropy = shannonEntropy(candidate);
    if (entropy < ENTROPY_THRESHOLD) continue;

    replacements.push({ start, end });
  }

  if (replacements.length === 0) return line;

  // Apply replacements right-to-left so indices stay valid
  let out = line;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end } = replacements[i]!;
    out = out.slice(0, start) + `<REDACTED:generic-secret>` + out.slice(end);
  }
  return out;
}

function hasKeywordToLeft(
  keywordEnds: readonly number[],
  candStart: number,
): boolean {
  // Keyword must end before candidate starts, within proximity window.
  // Right-side and embedded keywords are intentionally NOT matched — they're
  // too false-positive prone (paths, URLs, prose).
  for (const kEnd of keywordEnds) {
    if (kEnd <= candStart && candStart - kEnd <= PROXIMITY_WINDOW) return true;
  }
  return false;
}

/**
 * Heuristic for path-shaped candidates. A candidate is path-like if it
 * starts with '/', './', or '../', or if it contains '/' AND no '='/':' that
 * would suggest assignment. Pure-path candidates almost never contain real
 * secrets — real secrets passed via paths use a flag separator.
 */
function looksLikePath(candidate: string): boolean {
  if (candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../")) {
    return true;
  }
  // Contains slash AND a dot extension (e.g. config/redis.conf, src/foo.ts).
  // Real secrets shaped like base64 or hex don't have this pattern.
  if (candidate.includes("/") && /\.[a-zA-Z]{1,5}$/.test(candidate)) {
    return true;
  }
  return false;
}

function isInsideRedactionMarker(line: string, start: number, end: number): boolean {
  // Look backwards from `start` for an opening "<REDACTED:" without an
  // intervening ">". Cheap heuristic — sufficient because markers are short.
  const before = line.slice(0, start);
  const lastOpen = before.lastIndexOf("<REDACTED:");
  if (lastOpen === -1) return false;
  const closeAfterOpen = before.indexOf(">", lastOpen);
  if (closeAfterOpen !== -1 && closeAfterOpen < start) return false;
  // Marker is open — check that it closes after our candidate
  const closeAfterEnd = line.indexOf(">", end);
  return closeAfterEnd !== -1;
}
