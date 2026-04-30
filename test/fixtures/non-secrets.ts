/**
 * Test fixtures: negative cases (should NOT redact).
 *
 * These exercise common false-positive sources: file paths, hashes, UUIDs,
 * prose mentioning sensitive words, low-entropy placeholders, etc.
 */

export interface NegativeCase {
  /** Description for test output. */
  readonly name: string;
  /** Input string that must pass through unchanged. */
  readonly input: string;
}

export const NEGATIVE_CASES: readonly NegativeCase[] = [
  // ─── Prose & documentation ────────────────────────────────────────────
  {
    name: "normal English mentioning 'key'",
    input: "Please read the documentation, it has the key insights.",
  },
  {
    name: "documentation referencing API_KEY env var name",
    input: "Set the API_KEY environment variable before running this script.",
  },
  {
    name: "tool output success message",
    input: "Successfully wrote 1234 bytes to output.json",
  },
  {
    name: "user message about authentication",
    input: "I tried to authenticate but got a 401 error",
  },

  // ─── File paths & filenames ───────────────────────────────────────────
  {
    name: "file path containing 'keys'",
    input: "/Users/keefe/Documents/keys.txt",
  },
  {
    name: "ssh key file path",
    input: "Read /home/user/.ssh/id_rsa.pub for the public key",
  },
  {
    name: "secrets directory mention",
    input: "config/secrets/redis.conf",
  },

  // ─── Identifiers & hashes (no context keyword) ───────────────────────
  {
    name: "git short hash",
    input: "Reverting commit abc123d",
  },
  {
    name: "git long hash without context keyword",
    input: "abc123def456789012345678901234567890abcd",
  },
  {
    name: "UUID without context keyword",
    input: "user_id=f47ac10b-58cc-4372-a567-0e02b2c3d479",
  },
  {
    name: "ISO timestamp",
    input: "2026-04-29T12:34:56.789Z",
  },

  // ─── Low-entropy placeholders ────────────────────────────────────────
  {
    name: "uniform x placeholder",
    input: "API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    name: "envvar shell substitution",
    input: "secret = $SECRET_FROM_VAULT",
  },
  {
    name: "envvar interpolation reference",
    input: "password = ${DB_PASSWORD}",
  },
  {
    name: "all-zero placeholder near keyword",
    input: "token: 00000000000000000000000000000000",
  },

  // ─── Short / low-info base64 ─────────────────────────────────────────
  {
    name: "short base64 'Hello World' (low specificity)",
    input: "SGVsbG8gV29ybGQ=",
  },
  {
    name: "snippet of Markdown headers",
    input: "## Authentication\n\nUse the `--token` flag to authenticate.",
  },

  // ─── Tool-call-shaped strings ────────────────────────────────────────
  {
    name: "read tool path argument shape",
    input: 'read("/path/to/file.md")',
  },
  {
    name: "bash command without secrets",
    input: "git log --oneline --since=yesterday",
  },

  // ─── Numbers and IDs that LOOK secret-ish ────────────────────────────
  {
    name: "ISBN-like number string",
    input: "978-0-13-468599-1",
  },
  {
    name: "phone number with extension",
    input: "+1-555-0123-x4567",
  },

  // ─── EXAMPLE-suffixed AWS key (allowlisted in gitleaks) ──────────────
  // Note: gitleaks allowlists AWS keys ending in EXAMPLE. We match strictly
  // on prefix + 16 chars, so EXAMPLE-suffixed keys still match. Document
  // this as known over-redaction rather than excluding — conservative bias.
];

/**
 * Object-shaped negative cases — keys that LOOK env-var-ish but should not
 * trigger the env-var rule, and ordinary fields with no secrets.
 */
export interface ObjectNegativeCase {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export const OBJECT_NEGATIVE_CASES: readonly ObjectNegativeCase[] = [
  {
    name: "lowercase camelCase keys with sensitive names",
    input: {
      apiEndpoint: "https://api.example.com",
      keyPrefix: "v1_",
      authMethod: "oauth",
      privateField: "value",
    },
  },
  {
    name: "ordinary description fields",
    input: {
      description: "the API key is required",
      label: "Authentication settings",
      type: "credential_test",
    },
  },
  {
    name: "key fields with non-string values",
    input: {
      MAX_RETRIES: 5,
      DEBUG: true,
      TIMEOUT_MS: 30_000,
    },
  },
];
