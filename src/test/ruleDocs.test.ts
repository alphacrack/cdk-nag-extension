/**
 * Jest tests for the curated rule-doc map.
 *
 * Verifies:
 *   • New HIPAA.Security / NIST.800.53.R5 exact entries resolve via lookupRuleDoc.
 *   • Uncurated ids in those packs still resolve via the prefix-level fallback.
 */

import { lookupRuleDoc, listCuratedRuleIds } from '../ruleDocs';

describe('lookupRuleDoc — HIPAA.Security / NIST.800.53.R5 coverage', () => {
  it('resolves curated HIPAA.Security exact entries', () => {
    const doc = lookupRuleDoc('HIPAA.Security-S3BucketVersioningEnabled');
    expect(doc).toBeDefined();
    expect(doc?.name).toBe('S3 Bucket Versioning Enabled');
    expect(doc?.fix).toContain('versioned: true');
  });

  it('resolves curated NIST.800.53.R5 exact entries', () => {
    const doc = lookupRuleDoc('NIST.800.53.R5-RDSStorageEncrypted');
    expect(doc).toBeDefined();
    expect(doc?.name).toBe('RDS Storage Encrypted');
    expect(doc?.fix).toContain('storageEncrypted: true');
  });

  it('falls back to the NIST.800.53.R5-* prefix default for an uncurated id', () => {
    const doc = lookupRuleDoc('NIST.800.53.R5-SomeUncuratedRule');
    expect(doc).toBeDefined();
    expect(doc?.name).toBe('NIST 800-53 Rule');
  });

  it('falls back to the HIPAA.Security-* prefix default for an uncurated id', () => {
    const doc = lookupRuleDoc('HIPAA.Security-SomeUncuratedRule');
    expect(doc).toBeDefined();
    expect(doc?.name).toBe('HIPAA Security Rule');
  });

  it('includes at least 6 HIPAA.Security and 6 NIST.800.53.R5 curated ids', () => {
    const ids = listCuratedRuleIds();
    const hipaaCount = ids.filter(id => id.startsWith('HIPAA.Security-')).length;
    const nistCount = ids.filter(id => id.startsWith('NIST.800.53.R5-')).length;
    expect(hipaaCount).toBeGreaterThanOrEqual(6);
    expect(nistCount).toBeGreaterThanOrEqual(6);
  });
});
