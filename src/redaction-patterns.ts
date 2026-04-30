/**
 * Pre-compiled regex bundles for redaction.
 *
 * All regexes are compiled ONCE at module load. Hot-path redaction must not
 * allocate new RegExp objects (anchor.md A.4 — sub-5ms hook budget).
 *
 * Patterns are sourced from gitleaks (github.com/gitleaks/gitleaks,
 * config/gitleaks.toml, master). We extract the high-specificity prefix
 * regexes only — gitleaks' generic-keyword scanner is replaced by our own
 * entropy-based pass 3 (simpler, lower false-positive rate for our use
 * case which is observation logs, not source-code scanning).
 *
 * Replacement label format: `<REDACTED:type>` — preserves which detector
 * fired so we can audit redaction quality from observation logs.
 */

// ---------------------------------------------------------------------------
// Pass 1: High-specificity prefix patterns
//
// Each entry is a [name, regex] tuple. Names appear in <REDACTED:name>
// markers. Patterns use the `g` flag for replaceAll-style scanning across
// multiple matches in one string.
//
// Per-category compilation (rather than one giant union) was chosen for
// debuggability: when a redaction misfires, we can disable one category to
// isolate the cause. Cost: ~30 regex tests per call. For the ~1KB inputs we
// see, this stays well under the 5ms budget (benchmarked in tests).
// ---------------------------------------------------------------------------

interface PrefixPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export const PREFIX_PATTERNS: readonly PrefixPattern[] = [
  // AWS access keys (gitleaks: aws-access-token)
  // AKIA = long-lived, ASIA = STS temp, ABIA = AWS Backup, ACCA = context creds, A3T = older
  {
    name: "aws-access-key",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
  },

  // Cloudflare Origin CA Key (gitleaks: cloudflare-origin-ca-key)
  {
    name: "cloudflare-origin-ca",
    pattern: /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}\b/g,
  },

  // GCP API key (gitleaks: gcp-api-key)
  {
    name: "gcp-api-key",
    pattern: /\bAIza[\w-]{35}\b/g,
  },

  // Azure AD Client Secret (gitleaks: azure-ad-client-secret)
  // Format: 3 alnum + digit + Q~ + 31-34 chars
  {
    name: "azure-ad-secret",
    pattern: /\b[a-zA-Z0-9_~.]{3}\dQ~[a-zA-Z0-9_~.-]{31,34}\b/g,
  },

  // OpenAI API keys — proj/svcacct/admin scoped + legacy (gitleaks: openai-api-key)
  {
    name: "openai-api-key",
    pattern:
      /\bsk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|\bsk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}\b/g,
  },

  // Anthropic API & admin keys (gitleaks: anthropic-api-key, anthropic-admin-api-key)
  {
    name: "anthropic-api-key",
    pattern: /\bsk-ant-(?:api03|admin01)-[a-zA-Z0-9_-]{93}AA\b/g,
  },

  // GitHub — all 5 token formats + fine-grained PAT (gitleaks: github-*)
  // ghp_ PAT, gho_ OAuth, ghu_ user-to-server, ghs_ server-to-server, ghr_ refresh
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}\b/g,
  },
  {
    name: "github-pat-fine-grained",
    pattern: /\bgithub_pat_\w{82}\b/g,
  },

  // GitLab — comprehensive token coverage (gitleaks: gitlab-*)
  // glpat = PAT, glrt = runner, gloas = OAuth secret, glptt = pipeline trigger,
  // glcbt = CI/CD job, glsoat = SCIM, glagent = k8s agent, glft = feed,
  // glimt = incoming mail, gldt = deploy, glffct = feature flag,
  // GR1348941 = runner registration, _gitlab_session = session cookie
  {
    name: "gitlab-token",
    pattern:
      /\b(?:glpat-|glrt-|gloas-|glcbt-[0-9a-zA-Z]{1,5}_|glsoat-|glagent-|glft-|glimt-|gldt-|glffct-)[0-9a-zA-Z_-]{20,300}\b|\bglptt-[0-9a-f]{40}\b|\bGR1348941[\w-]{20}\b|_gitlab_session=[0-9a-z]{32}/g,
  },

  // npm access token (gitleaks: npm-access-token)
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },

  // Slack bot/user/app/legacy/config tokens (gitleaks: slack-*)
  // Trailing (?![\w-]) prevents alnum bleed into the match.
  {
    name: "slack-token",
    pattern:
      /(?:\bxoxb-[0-9]{8,14}-[a-zA-Z0-9-]{18,}|\bxoxp-(?:[0-9]{10,13}-){3}[a-zA-Z0-9-]{28,34}|\bxoxe\.xox[bp]-\d-[A-Z0-9]{163,166}|\bxoxe-\d-[A-Z0-9]{146}|\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+|\bxox[ar]-(?:\d-)?[0-9a-zA-Z]{8,48}|\bxox[os]-\d+-\d+-\d+-[a-fA-F\d]+)(?![\w-])/g,
  },

  // Slack webhook URL (gitleaks: slack-webhook-url)
  {
    name: "slack-webhook",
    pattern:
      /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}(?![\w-])/g,
  },

  // Stripe access tokens — sk/rk + test/live/prod (gitleaks: stripe-access-token)
  {
    name: "stripe-key",
    pattern: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/g,
  },

  // JWT — 3 segments, header starting with "ey" (base64 of {"...) (gitleaks: jwt)
  // Conservative bounds: header >=17, payload >=17, signature >=10. We require all 3.
  // Char class is base64url (A-Za-z0-9_-) — no `/` or `\\`. Trailing `(?![\w-])`
  // prevents over-eating into adjacent word characters.
  {
    name: "jwt",
    pattern:
      /\bey[a-zA-Z0-9_-]{17,}\.ey[a-zA-Z0-9_-]{17,}\.[a-zA-Z0-9_-]{10,}={0,2}(?![\w-])/g,
  },

  // PEM private key blocks — covers RSA, DSA, EC, OPENSSH, PGP, etc.
  // Multi-line. We match the entire block including content for full redaction.
  // (gitleaks: private-key) — using a slightly tightened version.
  {
    name: "pem-private-key",
    pattern:
      /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{1,8000}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g,
  },

  // Hugging Face access token (gitleaks: huggingface-access-token)
  {
    name: "huggingface-token",
    pattern: /\bhf_[a-zA-Z]{34}\b/g,
  },

  // 1Password secret key (gitleaks: 1password-secret-key)
  {
    name: "1password-secret-key",
    pattern:
      /\bA3-[A-Z0-9]{6}-(?:[A-Z0-9]{11}|[A-Z0-9]{6}-[A-Z0-9]{5})-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g,
  },

  // Age secret key (gitleaks: age-secret-key)
  // Note: Age uses Bech32 charset, but at this anchor length it's effectively unique.
  {
    name: "age-secret-key",
    pattern: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/g,
  },

  // Sentry user/org tokens (gitleaks: sentry-user-token, sentry-org-token)
  {
    name: "sentry-token",
    pattern: /\bsntryu_[a-f0-9]{64}\b|\bsntrys_eyJ[a-zA-Z0-9+/=_]{50,}(?![\w])/g,
  },

  // HashiCorp Vault tokens (gitleaks: vault-batch-token, vault-service-token)
  {
    name: "vault-token",
    pattern: /\bhv[bs]\.[\w-]{90,300}\b/g,
  },

  // Linear API key (gitleaks: linear-api-key)
  {
    name: "linear-api-key",
    pattern: /\blin_api_[a-zA-Z0-9]{40}\b/g,
  },

  // Notion API token (gitleaks: notion-api-token)
  {
    name: "notion-token",
    pattern: /\bntn_[0-9]{11}[A-Za-z0-9]{35}\b/g,
  },

  // Doppler API token (gitleaks: doppler-api-token)
  {
    name: "doppler-token",
    pattern: /\bdp\.pt\.[a-zA-Z0-9]{43}\b/g,
  },

  // Discord webhook URL — trailing (?![\w-]) keeps the match exact
  {
    name: "discord-webhook",
    pattern:
      /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+(?![\w-])/g,
  },

  // Datadog API key (anchored on keyword) — gitleaks: datadog-access-token
  // We deviate from gitleaks here: their pattern requires "datadog" within 50
  // chars, which won't survive observation truncation. Instead we leave Datadog
  // detection to pass 3 (context-aware), since their tokens are bare 40-char
  // hex with no prefix and high false-positive risk on their own.

  // GitHub OAuth Apps client secret (gho_ already covered above)
  // Asana, Atlassian, Heroku UUID-format keys: deferred to context-aware pass.
];

// ---------------------------------------------------------------------------
// Pass 2: Connection-string scanner
//
// Matches URI patterns with embedded basic auth. Captures:
//   1. scheme://user
//   2. password (the secret)
//   3. @host[:port][/path]
//
// Replacement preserves scheme, user, host — only the password becomes
// <REDACTED:db-password>. The user is not redacted (it's typically not
// secret on its own and helps debugging).
//
// Schemes covered: mongodb, mongodb+srv, postgres/postgresql, mysql, redis,
// rediss, amqp, amqps, http, https. Excludes ftp/ssh/git which use different
// auth shapes.
//
// Password class: greedy across non-whitespace, non-control chars. The
// trailing `@host` is anchored on a host-shaped tail — host must contain a
// dot (TLD) OR be followed by `:port`, `/path`, `?`, or `#`. With the greedy
// password and host-shape requirement, real-world passwords containing
// unencoded `@` symbols (common in copy-paste configs) are fully captured —
// the regex backtracks the password until the host pattern matches the
// rightmost `@`-suffixed substring.
//
// Capture groups: (1) scheme, (2) user, (3) password, (4) host[:port][/path].
// ---------------------------------------------------------------------------

export const CONNECTION_STRING_PATTERN: RegExp =
  /\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|rediss?|amqps?|https?):\/\/([^:/@\s]+):([^\s/]+)@([\w-]+(?:\.[\w-]+)+(?:[:/?#][^\s"'<>]*)?|[\w-]+(?:[:/][^\s"'<>]*))/g;

// ---------------------------------------------------------------------------
// Pass 3: Context-aware generic
//
// Two regexes:
//   1. KEYWORD_PROXIMITY: locates trigger keywords. Used to decide whether
//      to scan a line at all.
//   2. CANDIDATE_VALUE: extracts candidate token-like substrings for entropy
//      check.
//
// Trigger keywords (case-insensitive, word-boundary): secret, token, api_key,
// apikey, password, credential, auth, key, bearer.
//
// Note: we deliberately avoid bare 'auth' inside compound words like
// 'author' by requiring word-boundary on both sides. 'key' alone is highly
// false-positive-prone — but the entropy check downstream is the safety
// net. We still include 'key' because a lot of generic tokens use it.
// ---------------------------------------------------------------------------

export const KEYWORD_REGEX: RegExp =
  /\b(?:secret|token|api[_-]?key|apikey|password|credential|auth|bearer|key)\b/gi;

// Candidate tokens: 20-200 chars of token-like alphanumeric+symbols.
// Excludes '=' so that `KEY=val` splits cleanly into keyword + candidate
// (and assignment-style detection works). Excludes whitespace, quotes,
// parens, semicolons by character class. The 16+ base64-shape branch
// handles shorter tokens common in API keys (B64 encoded GUIDs etc.) and
// allows trailing '=' as base64 padding.
export const CANDIDATE_VALUE_REGEX: RegExp =
  /[A-Za-z0-9+/]{16,}={0,3}|[\w./+-]{20,200}/g;

// Proximity window for context-aware match (chars between keyword and candidate).
export const PROXIMITY_WINDOW = 50;

// Entropy threshold for context-aware redaction (bits/char).
// 3.5 is gitleaks' default and well-tested. Below: placeholders, hashes, low-info.
// Above: real tokens, random keys, encrypted blobs.
export const ENTROPY_THRESHOLD = 3.5;

// ---------------------------------------------------------------------------
// Bonus rule: Env-var name heuristic
//
// Matches keys structured like environment variables with a sensitive suffix:
//   API_KEY, DB_PASSWORD, GITHUB_TOKEN, MY_AUTH_TOKEN, etc.
//
// Requires:
//   - All-uppercase (or starts with uppercase letter)
//   - Underscores allowed
//   - Ends with a sensitive-suffix word: TOKEN, KEY, SECRET, PASSWORD, CRED,
//     CREDS, AUTH, PASS, PWD, PRIVATE
//
// Does NOT match: 'description', 'apiEndpoint', 'private' (too short / lowercase),
// 'public_key' (excluded since lowercase), 'pubkey'.
//
// The trade-off: we miss camelCase keys like `apiKey`. This is intentional —
// camelCase is JavaScript's native object key style and hits too many false
// positives ('keyboard', 'monkey', etc.). Keys redacted by this rule are
// almost always actual env-var-style names.
// ---------------------------------------------------------------------------

export const ENV_VAR_KEY_REGEX: RegExp =
  /^[A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD|CRED|CREDS|AUTH|PASS|PWD|PRIVATE)$|^(?:TOKEN|KEY|SECRET|PASSWORD|CRED|CREDS|AUTH|PASS|PWD)$/;
