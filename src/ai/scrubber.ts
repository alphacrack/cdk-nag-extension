// PII / secret scrubber for AI-assisted fix suggestions.
//
// Before sending any code snippet to a third-party language model (Copilot),
// every string pass-through is run through this module to redact the highest-
// risk token classes. The patterns are sourced from our `.gitleaks.toml`
// (SSN, PAN, US phone, IBAN, AWS credential key-value) and extended with a
// few AI-send-specific additions that gitleaks does NOT cover because they
// are rarely genuine secrets at commit time but DO carry meaningful signal
// to an LLM inference provider:
//
//   • Bare AKIA / ASIA access key IDs (20 chars, distinct alphabet).
//   • ARN account IDs (12-digit account number inside an AWS ARN).
//   • `process.env.<NAME>` references (the NAME leaks deployment-variable
//     semantics even when the value is obviously not committed).
//
// Redaction is deterministic and lossy by design: we do NOT try to preserve
// the structure of the removed token (no hashing, no length-preserving
// placeholders) because the goal is to prevent reconstruction, not to let
// the model reason about what was removed. The replacement tokens are
// self-documenting (`<REDACTED_SSN>`, `<REDACTED_AKIA>`, …) so the model
// still understands that "something sensitive went here" and produces a
// contextually-appropriate fix.
//
// The module is pure — no VS Code imports — so it can be unit-tested without
// the extension host. The `scrubSnippet` function returns both the sanitized
// text AND a count + list of rule ids that fired, which the orchestrator in
// `suggestFix.ts` logs to the OutputChannel so users can audit what was
// actually sent.

export interface ScrubResult {
  /** The sanitized text, safe to send to a third-party inference provider. */
  scrubbed: string;
  /** Total number of individual token replacements across all patterns. */
  redactionCount: number;
  /** Unique list of pattern ids that matched at least once (for audit logs). */
  patternsHit: string[];
}

interface ScrubRule {
  /** Stable id — shown in the OutputChannel when this rule fires. */
  id: string;
  /** Global regex — MUST have the `g` flag or `replace` will only hit the first match. */
  pattern: RegExp;
  /** Either a literal string or a callable — mirrors the `String.replace` signature. */
  replacement: string | ((match: string, ...groups: string[]) => string);
  /** Short human-readable label for docs / tests. */
  description: string;
}

/**
 * The full pattern set. Ordering matters: the more-specific ARN-account
 * pattern runs before the generic 12-digit catcher would, for example. Keep
 * this list in lock-step with `.gitleaks.toml` plus the AI-specific
 * extensions documented in the module header.
 */
export const SCRUB_RULES: ScrubRule[] = [
  {
    id: 'pii-ssn',
    description: 'US Social Security Number (XXX-XX-XXXX)',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '<REDACTED_SSN>',
  },
  {
    id: 'pii-credit-card',
    description: 'Credit card PAN (Visa / MC / Amex / Discover)',
    // Same alternation as .gitleaks.toml — Visa (4xxx), Mastercard (5[1-5]xx),
    // Amex (3[47]xx), Discover (6011 / 65xx). Optional `-`/space separators.
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
    replacement: '<REDACTED_CC>',
  },
  {
    id: 'pii-phone-us',
    description: 'US phone number with separators',
    pattern: /\b[2-9]\d{2}[-. ]\d{3}[-. ]\d{4}\b/g,
    replacement: '<REDACTED_PHONE>',
  },
  {
    id: 'pii-iban',
    description: 'International Bank Account Number',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    replacement: '<REDACTED_IBAN>',
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID (AKIA / ASIA)',
    // 20-char AKIA/ASIA prefix. Runs before the generic credential-kv rule
    // so bare keys in comments / strings get their own redaction token.
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '<REDACTED_AKIA>',
  },
  {
    id: 'generic-aws-credentials-in-config',
    description: 'AWS credential key-value in config / JSON',
    // `aws_access_key_id = AKIA...` (CLI credentials file, aws-prefixed) or
    // `"secretAccessKey": "..."` (SDK/JSON response, no aws prefix). The
    // `aws[_-]?` prefix is optional so both idiomatic forms redact.
    // Case-insensitive — JS regex uses the `i` flag, not gitleaks' `(?i)`.
    pattern:
      /((?:aws[_-]?)?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key))\s*["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{16,}["']?/gi,
    replacement: '<REDACTED_AWS_CRED>',
  },
  {
    id: 'aws-arn-account-id',
    description: 'AWS account id inside an ARN',
    // `arn:aws:SERVICE:REGION:123456789012:RESOURCE` — redact ONLY the account
    // id so the service / region / resource naming still informs the model.
    // Capture group 1 is the account id; callable replacement keeps the rest.
    pattern: /(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)(\d{12})(:)/gi,
    replacement: (_match, prefix: string, _accountId: string, suffix: string) =>
      `${prefix}<REDACTED_ACCT>${suffix}`,
  },
  {
    id: 'process-env-var',
    description: 'process.env.* reference (name leaks deployment semantics)',
    pattern: /process\.env\.([A-Z][A-Z0-9_]*)/g,
    replacement: 'process.env.<REDACTED_ENV>',
  },
];

/**
 * Run every `SCRUB_RULES` pattern across the input. Returns the scrubbed
 * text along with audit metadata. Pure function — no I/O, no globals,
 * deterministic.
 */
export function scrubSnippet(text: string): ScrubResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { scrubbed: text ?? '', redactionCount: 0, patternsHit: [] };
  }

  let scrubbed = text;
  let redactionCount = 0;
  const patternsHit: string[] = [];

  for (const rule of SCRUB_RULES) {
    // `matchAll` needs a fresh regex state; pattern is `g`-flagged so
    // every occurrence is iterated. Count first, then replace — two passes
    // is cleaner than a replacer-callback that mutates an outer counter.
    const matches = Array.from(scrubbed.matchAll(rule.pattern));
    if (matches.length === 0) continue;

    redactionCount += matches.length;
    patternsHit.push(rule.id);

    // `as never` lets TS accept the string-or-callable union — the runtime
    // types match `String.prototype.replace` exactly.
    scrubbed = scrubbed.replace(rule.pattern, rule.replacement as never);
  }

  return { scrubbed, redactionCount, patternsHit };
}
