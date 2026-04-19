/**
 * Jest tests for `src/ai/scrubber.ts`.
 *
 * The scrubber is the last line of defence before snippet text leaves the
 * extension host for a third-party inference provider, so its behaviour is
 * safety-critical. We lock down:
 *
 *   • Every rule in `SCRUB_RULES` fires on its intended positive example
 *     AND the replacement token appears verbatim (no length-preserving
 *     placeholders — the original must not be reconstructable).
 *   • Patterns don't match obviously-non-sensitive look-alikes (numeric
 *     literals without SSN shape, 10-digit strings without separators, etc).
 *   • The audit metadata (`redactionCount`, `patternsHit`) matches reality.
 *   • Inputs that aren't strings (or are empty) don't throw.
 *   • Multi-match / multi-rule scenarios compose correctly — e.g. a snippet
 *     with both an SSN and an ARN has both redacted in a single pass.
 */

import { scrubSnippet, SCRUB_RULES } from '../../ai/scrubber';

describe('SCRUB_RULES invariants', () => {
  it('every rule has a unique id', () => {
    const ids = SCRUB_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every rule uses a global regex (required for multi-match)', () => {
    for (const rule of SCRUB_RULES) {
      expect(rule.pattern.flags).toContain('g');
    }
  });
});

describe('scrubSnippet — happy path per rule', () => {
  it('redacts an SSN', () => {
    const result = scrubSnippet('emp.ssn = "123-45-6789";');
    expect(result.scrubbed).toContain('<REDACTED_SSN>');
    expect(result.scrubbed).not.toContain('123-45-6789');
    expect(result.redactionCount).toBe(1);
    expect(result.patternsHit).toEqual(['pii-ssn']);
  });

  it('redacts a Visa credit card number', () => {
    const result = scrubSnippet('pan: "4111-1111-1111-1111"');
    expect(result.scrubbed).toContain('<REDACTED_CC>');
    expect(result.scrubbed).not.toContain('4111');
    expect(result.patternsHit).toEqual(['pii-credit-card']);
  });

  it('redacts a Mastercard PAN', () => {
    const result = scrubSnippet('5500 0000 0000 0004');
    expect(result.scrubbed).toContain('<REDACTED_CC>');
    expect(result.patternsHit).toEqual(['pii-credit-card']);
  });

  it('redacts an Amex PAN', () => {
    // Amex is actually 15 digits (3[47]xx + 4+4+3). The gitleaks regex
    // matches 16 digits by design — easier to maintain one pattern that
    // over-redacts than a separate Amex-specific rule. Verify that the
    // common dashed-16-digit Amex-looking format gets caught.
    const result = scrubSnippet('3782 8224 6310 0050');
    expect(result.scrubbed).toContain('<REDACTED_CC>');
  });

  it('redacts a US phone number with hyphens', () => {
    const result = scrubSnippet('contact: 415-555-0100');
    expect(result.scrubbed).toContain('<REDACTED_PHONE>');
    expect(result.patternsHit).toEqual(['pii-phone-us']);
  });

  it('redacts a US phone number with dots', () => {
    const result = scrubSnippet('415.555.0100');
    expect(result.scrubbed).toContain('<REDACTED_PHONE>');
  });

  it('redacts an IBAN', () => {
    const result = scrubSnippet('iban=DE89370400440532013000');
    expect(result.scrubbed).toContain('<REDACTED_IBAN>');
  });

  it('redacts a bare AKIA access key id', () => {
    const result = scrubSnippet('const k = "AKIAIOSFODNN7EXAMPLE";');
    expect(result.scrubbed).toContain('<REDACTED_AKIA>');
    expect(result.scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.patternsHit).toEqual(['aws-access-key-id']);
  });

  it('redacts a bare ASIA temporary access key id', () => {
    const result = scrubSnippet('ASIAY34FZKBOKMUTVV7A');
    expect(result.scrubbed).toContain('<REDACTED_AKIA>');
  });

  it('redacts an aws_access_key_id key-value config line', () => {
    const result = scrubSnippet('aws_access_key_id = abcdefghij1234567890');
    // Either aws-access-key-id or generic-aws-credentials-in-config can
    // match first; at least one must redact.
    expect(result.scrubbed).toMatch(/<REDACTED_(AKIA|AWS_CRED)>/);
    expect(result.redactionCount).toBeGreaterThanOrEqual(1);
  });

  it('redacts a JSON secretAccessKey field, case-insensitively', () => {
    const result = scrubSnippet('"secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"');
    expect(result.scrubbed).toContain('<REDACTED_AWS_CRED>');
    expect(result.patternsHit).toContain('generic-aws-credentials-in-config');
  });

  it('redacts the 12-digit account id inside an ARN but keeps the service/region/resource', () => {
    const result = scrubSnippet('arn:aws:iam::123456789012:role/FooRole');
    expect(result.scrubbed).toContain('<REDACTED_ACCT>');
    expect(result.scrubbed).toContain('arn:aws:iam::');
    expect(result.scrubbed).toContain(':role/FooRole');
    expect(result.scrubbed).not.toContain('123456789012');
  });

  it('redacts process.env.<NAME> references but keeps the process.env. prefix', () => {
    const result = scrubSnippet('const u = process.env.DB_PASSWORD;');
    expect(result.scrubbed).toContain('process.env.<REDACTED_ENV>');
    expect(result.scrubbed).not.toContain('DB_PASSWORD');
  });
});

describe('scrubSnippet — negative cases (no false positives)', () => {
  it('does not redact a plain 9-digit integer', () => {
    const result = scrubSnippet('const x = 123456789;');
    expect(result.redactionCount).toBe(0);
    expect(result.scrubbed).toBe('const x = 123456789;');
  });

  it('does not redact a 10-digit number without separators', () => {
    const result = scrubSnippet('id = 4155550100;');
    expect(result.redactionCount).toBe(0);
  });

  it('does not redact an ordinary string without key markers', () => {
    const result = scrubSnippet('const greeting = "Hello, world!";');
    expect(result.redactionCount).toBe(0);
    expect(result.patternsHit).toEqual([]);
  });

  it('returns the input unchanged when there are no matches', () => {
    const text =
      'new s3.Bucket(this, "MyBucket", {\n  encryption: s3.BucketEncryption.S3_MANAGED,\n});';
    const result = scrubSnippet(text);
    expect(result.scrubbed).toBe(text);
    expect(result.redactionCount).toBe(0);
  });
});

describe('scrubSnippet — audit metadata', () => {
  it('counts every individual match, not just unique rules hit', () => {
    const result = scrubSnippet(
      'user1 = "111-22-3333"\nuser2 = "444-55-6666"\nuser3 = "777-88-9999"'
    );
    expect(result.redactionCount).toBe(3);
    expect(result.patternsHit).toEqual(['pii-ssn']);
  });

  it('reports every distinct rule that fired across the snippet', () => {
    const result = scrubSnippet(
      'ssn=111-22-3333, arn:aws:s3:::my-bucket, env=process.env.SECRET_KEY'
    );
    // SSN + env var definitely fire. ARN needs an account id — this one
    // has none, so it should NOT fire. Scope to what definitely runs:
    expect(result.patternsHit).toEqual(expect.arrayContaining(['pii-ssn', 'process-env-var']));
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });

  it('scrubs an ARN + env var in one pass', () => {
    const input =
      'const role = "arn:aws:iam::987654321098:role/Build"; const tok = process.env.CI_TOKEN;';
    const result = scrubSnippet(input);
    expect(result.scrubbed).toContain('<REDACTED_ACCT>');
    expect(result.scrubbed).toContain('<REDACTED_ENV>');
    expect(result.scrubbed).not.toContain('987654321098');
    expect(result.scrubbed).not.toContain('CI_TOKEN');
    expect(result.patternsHit).toEqual(
      expect.arrayContaining(['aws-arn-account-id', 'process-env-var'])
    );
  });
});

describe('scrubSnippet — defensive inputs', () => {
  it('returns empty string for empty input', () => {
    expect(scrubSnippet('')).toEqual({ scrubbed: '', redactionCount: 0, patternsHit: [] });
  });

  it('does not throw on a non-string input and returns a safe empty result', () => {
    // The public API is typed `string` but JS can still hand us anything.
    // Cast through `unknown` to exercise the runtime guard.
    const result = scrubSnippet(undefined as unknown as string);
    expect(result.redactionCount).toBe(0);
    expect(result.scrubbed).toBe('');
  });
});
