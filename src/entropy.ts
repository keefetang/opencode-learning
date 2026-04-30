/**
 * Shannon entropy calculation for redaction pass 3.
 *
 * Used to distinguish high-information secrets (likely real tokens, API keys,
 * passwords) from low-information placeholders ("xxxxxxxx", "TODO_FILL_IN",
 * commit hashes, base64-encoded English text).
 *
 * Threshold: ~3.5 bits/char is the conventional cutoff used by gitleaks and
 * similar scanners. Random alphanumeric strings hit ~5 bits/char; uniform
 * placeholders score near 0; English text averages ~4 but usually doesn't
 * hit the length minimums for context-aware pass.
 *
 * This is the ONLY exported function — pre-compiled patterns live in
 * redaction-patterns.ts.
 */

/**
 * Compute Shannon entropy of a string in bits per character.
 * Returns 0 for empty strings.
 *
 * Implementation note: uses a plain object with a code-point key and Math.log
 * (rather than Math.log2) for portability — converted at the end. Avoids
 * Map allocation overhead in the hot path.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const freq: Record<string, number> = Object.create(null);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    freq[ch] = (freq[ch] ?? 0) + 1;
  }

  const len = s.length;
  let entropy = 0;
  for (const ch in freq) {
    const p = freq[ch]! / len;
    entropy -= p * Math.log(p);
  }
  // Convert from nats to bits (log_2 = log_e / log_e(2))
  return entropy / Math.LN2;
}
