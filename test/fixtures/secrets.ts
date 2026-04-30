/**
 * Test fixtures: positive cases (SHOULD redact).
 *
 * Each entry has the secret string and an expected redaction marker name
 * that should appear in the output. Examples are realistic in shape but
 * use bogus values — none of these are real credentials.
 *
 * Where possible, formats are sourced from gitleaks' own test fixtures:
 * https://github.com/gitleaks/gitleaks/tree/master/testdata
 */

export interface PositiveCase {
  /** Description for test output. */
  readonly name: string;
  /** Input string to redact. */
  readonly input: string;
  /** Expected marker label substring (matched against `<REDACTED:LABEL>`). */
  readonly expectedLabel: string;
}

export const POSITIVE_CASES: readonly PositiveCase[] = [
  // ─── AWS ──────────────────────────────────────────────────────────────
  {
    name: "AWS access key ID (AKIA prefix)",
    input: "aws_access_key=AKIAIOSFODNN7EXAMPLE",
    expectedLabel: "aws-access-key",
  },
  {
    name: "AWS STS temp key (ASIA prefix)",
    input: "ASIAIOSFODNN7EXAMPLE",
    expectedLabel: "aws-access-key",
  },
  {
    name: "AWS A3T-prefixed key",
    // Pattern: A3T + [A-Z0-9] + 16 chars from [A-Z2-7] (no 0/1/8/9).
    input: "A3TFOOBARBAZQUX23456",
    expectedLabel: "aws-access-key",
  },

  // ─── GCP ──────────────────────────────────────────────────────────────
  {
    name: "GCP API key",
    input: "key=AIzaSyDx9bC2vZxQpRsT4uVwXyZ-AbCdEfGhIj0",
    expectedLabel: "gcp-api-key",
  },

  // ─── Azure ────────────────────────────────────────────────────────────
  {
    name: "Azure AD client secret",
    input: "secret value abc1Q~xX0yY1zZ2aA3bB4cC5dD6eE7fF8gG9hH0",
    expectedLabel: "azure-ad-secret",
  },

  // ─── OpenAI / Anthropic ───────────────────────────────────────────────
  {
    name: "OpenAI project API key",
    // 74 chars before T3BlbkFJ + 74 chars after
    input:
      "OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcdefghijT3BlbkFJabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcdefghij",
    expectedLabel: "openai-api-key",
  },
  {
    name: "Anthropic API key",
    // 93 alnum/-_ chars between sk-ant-api03- and AA
    input:
      "x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcdefghijklmnopqrstuvwxyzABCAA",
    expectedLabel: "anthropic-api-key",
  },
  {
    name: "Anthropic admin key",
    input:
      "sk-ant-admin01-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcdefghijklmnopqrstuvwxyzABCAA",
    expectedLabel: "anthropic-api-key",
  },

  // ─── GitHub ───────────────────────────────────────────────────────────
  {
    name: "GitHub PAT (ghp_)",
    input: "token: ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
    expectedLabel: "github-token",
  },
  {
    name: "GitHub OAuth (gho_)",
    input: "gho_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
    expectedLabel: "github-token",
  },
  {
    name: "GitHub user-to-server (ghu_)",
    input: "ghu_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
    expectedLabel: "github-token",
  },
  {
    name: "GitHub server-to-server (ghs_)",
    input: "ghs_AbcDefGhiJklMnoPqrStuVwxYz0123456789",
    expectedLabel: "github-token",
  },
  {
    name: "GitHub fine-grained PAT",
    // github_pat_ + 82 word chars
    input: "github_pat_" + "1".repeat(11) + "abcdefghijklmnopqrstuvwxyz".repeat(2) + "ABCDEFGHIJKLMNOPQRS",
    expectedLabel: "github-pat-fine-grained",
  },

  // ─── GitLab ───────────────────────────────────────────────────────────
  {
    name: "GitLab PAT",
    input: "gitlab_token=glpat-xxxxxxxxxxxxxxxxxxxx",
    expectedLabel: "gitlab-token",
  },
  {
    name: "GitLab pipeline trigger token",
    input: "glptt-0123456789abcdef0123456789abcdef01234567",
    expectedLabel: "gitlab-token",
  },
  {
    name: "GitLab session cookie",
    input: "Cookie: _gitlab_session=abcdef0123456789abcdef0123456789",
    expectedLabel: "gitlab-token",
  },

  // ─── npm ──────────────────────────────────────────────────────────────
  {
    name: "npm access token",
    // npm_ + 36 alnum
    input: "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
    expectedLabel: "npm-token",
  },

  // ─── Slack ────────────────────────────────────────────────────────────
  {
    name: "Slack bot token (xoxb)",
    input: "xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx",
    expectedLabel: "slack-token",
  },
  {
    name: "Slack user token (xoxp)",
    input: "xoxp-1234567890-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf",
    expectedLabel: "slack-token",
  },
  {
    name: "Slack webhook URL",
    input: "POST to https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    expectedLabel: "slack-webhook",
  },

  // ─── Stripe ───────────────────────────────────────────────────────────
  {
    name: "Stripe test secret key",
    input: "sk_test_4eC39HqLyjWDarjtT1zdp7dc",
    expectedLabel: "stripe-key",
  },
  {
    name: "Stripe live secret key",
    input: "sk_live_AbCdEfGhIjKlMnOpQrStUvWx",
    expectedLabel: "stripe-key",
  },
  {
    name: "Stripe restricted key",
    input: "rk_test_AbCdEfGhIjKlMnOpQrStUvWx",
    expectedLabel: "stripe-key",
  },

  // ─── JWT ──────────────────────────────────────────────────────────────
  {
    name: "JWT (3 segments)",
    input:
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    expectedLabel: "jwt",
  },

  // ─── PEM ──────────────────────────────────────────────────────────────
  {
    name: "PEM RSA private key block",
    input: `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
-----END RSA PRIVATE KEY-----`,
    expectedLabel: "pem-private-key",
  },
  {
    name: "PEM OpenSSH private key block",
    input: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdz
c2gtcnNhAAAAAwEAAQAAAQEA1234567890abcdefghijklmnopqrstuvwxyzABCD
-----END OPENSSH PRIVATE KEY-----`,
    expectedLabel: "pem-private-key",
  },

  // ─── Connection strings (Pass 2) ──────────────────────────────────────
  {
    name: "MongoDB connection string with auth",
    input: "mongodb://admin:s3cr3tP@ssw0rd@db.example.com:27017/mydb",
    expectedLabel: "db-password",
  },
  {
    name: "Postgres connection string",
    input: "DATABASE_URL=postgres://app:password123@localhost:5432/mydb",
    expectedLabel: "db-password",
  },
  {
    name: "MySQL connection string",
    input: "mysql://root:rootpass@127.0.0.1:3306/test",
    expectedLabel: "db-password",
  },
  {
    name: "Redis connection string with TLS",
    input: "rediss://default:abc123def456@redis.example.com:6380",
    expectedLabel: "db-password",
  },
  {
    name: "AMQP connection with creds",
    input: "amqp://guest:guestpass@rabbitmq:5672/vhost",
    expectedLabel: "db-password",
  },
  {
    name: "HTTPS basic auth in URL",
    input: "Cloning from https://user:tokensecret123@github.com/foo/bar.git",
    expectedLabel: "db-password",
  },

  // ─── Other high-specificity ───────────────────────────────────────────
  {
    name: "Hugging Face token",
    input: "hf_abcdefghijklmnopqrstuvwxyzABCDEFGH",
    expectedLabel: "huggingface-token",
  },
  {
    name: "Sentry user token",
    input: "sntryu_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    expectedLabel: "sentry-token",
  },
  {
    name: "Vault service token (hvs)",
    // hvs. + 90-120 chars [\w-]
    input: "hvs." + "AbCdEf01_-".repeat(10),
    expectedLabel: "vault-token",
  },
  {
    name: "Linear API key",
    // lin_api_ + 40 alnum chars
    input: "lin_api_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd",
    expectedLabel: "linear-api-key",
  },
  {
    name: "Notion API token",
    // ntn_ + 11 digits + 35 alnum
    input: "ntn_12345678901" + "AbCdEfGhIjKlMnOpQrStUvWxYz012345678",
    expectedLabel: "notion-token",
  },
  {
    name: "Doppler token",
    input: "dp.pt.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    expectedLabel: "doppler-token",
  },
  {
    name: "Discord webhook URL",
    input: "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz_-",
    expectedLabel: "discord-webhook",
  },
  {
    name: "Cloudflare Origin CA key",
    // [a-f0-9]{24} + - + [a-f0-9]{146}
    input:
      "v1.0-0123456789abcdef01234567-" + "0123456789abcdef".repeat(9) + "01",
    expectedLabel: "cloudflare-origin-ca",
  },
  {
    name: "1Password secret key",
    input: "A3-ABCDEF-GHIJKLMNOPQ-RSTUV-WXYZA-BCDEF",
    expectedLabel: "1password-secret-key",
  },
  {
    name: "Age secret key",
    // AGE-SECRET-KEY-1 + 58 chars from Bech32 charset
    input: "AGE-SECRET-KEY-1" + "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L".repeat(2).slice(0, 58),
    expectedLabel: "age-secret-key",
  },

  // ─── Pass 3 — Context-aware generic ──────────────────────────────────
  {
    name: "high-entropy value near 'secret' keyword",
    input: "the secret is k8X9pQrSt2vWxYz3aBc4dE5fGhI6jKlMn7oP",
    expectedLabel: "generic-secret",
  },
  {
    name: "API_KEY env-var-style assignment in line",
    input: "API_KEY=k8X9pQrSt2vWxYz3aBc4dE5fGhI6jKlMn7oP8q",
    expectedLabel: "generic-secret",
  },
  {
    name: "bearer token in header line",
    input: "Authorization: Bearer abcXYZ123_lkjhgfdsapoiuytrewqQAZWSXEDC",
    expectedLabel: "generic-secret",
  },
];

/**
 * Multi-secret cases: a single input containing multiple secrets, all of
 * which should be redacted.
 */
export interface MultiSecretCase {
  readonly name: string;
  readonly input: string;
  readonly expectedLabels: readonly string[];
}

export const MULTI_SECRET_CASES: readonly MultiSecretCase[] = [
  {
    name: "AWS key + GitHub token in one config blob",
    input: `AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
GITHUB_TOKEN=ghp_AbcDefGhiJklMnoPqrStuVwxYz0123456789`,
    // env-var rule (from object walker) doesn't fire on plain strings;
    // both prefix patterns will redact in plain redactString
    expectedLabels: ["aws-access-key", "github-token"],
  },
  {
    name: "JWT plus Slack webhook in same string",
    // JWT regex requires {17,} in each of header/payload, so the payload here
    // is full-length, not truncated.
    input:
      "got back eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c and pinged https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    expectedLabels: ["jwt", "slack-webhook"],
  },
];
