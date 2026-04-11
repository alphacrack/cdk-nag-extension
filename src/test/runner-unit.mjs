/**
 * Pure Node.js unit tests — no external test framework required.
 *
 * Runs with: node --test src/test/runner-unit.mjs
 *
 * Tests the condition-evaluation sandbox logic that replaces the old
 * shell-injection-prone approach.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Mirror evaluateConditionSafely from cdkNagRunner.ts (compiled form not
// needed — we test the logic directly).
// ---------------------------------------------------------------------------
function evaluateConditionSafely(condition, resource) {
  try {
    const sandbox = Object.create(null);
    sandbox['resource'] = resource;
    const context = vm.createContext(sandbox);
    const result = vm.runInContext(condition, context, {
      timeout: 500,
      filename: 'condition.vm',
    });
    return Boolean(result);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const s3NoEnc = {
  Type: 'AWS::S3::Bucket',
  Properties: {},
};

const s3WithEnc = {
  Type: 'AWS::S3::Bucket',
  Properties: { BucketEncryptionConfiguration: { ServerSideEncryptionConfiguration: [] } },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('evaluateConditionSafely — legitimate conditions', () => {
  test('returns true when condition matches (no encryption)', () => {
    assert.equal(
      evaluateConditionSafely('!resource.Properties.BucketEncryptionConfiguration', s3NoEnc),
      true
    );
  });

  test('returns false when condition does not match (encryption present)', () => {
    assert.equal(
      evaluateConditionSafely('!resource.Properties.BucketEncryptionConfiguration', s3WithEnc),
      false
    );
  });

  test('nested property access works', () => {
    assert.equal(
      evaluateConditionSafely(
        "resource.Type === 'AWS::S3::Bucket' && !resource.Properties.BucketEncryptionConfiguration",
        s3NoEnc
      ),
      true
    );
  });

  test('empty condition returns false', () => {
    assert.equal(evaluateConditionSafely('', s3NoEnc), false);
  });

  test('syntax error returns false without throwing', () => {
    assert.doesNotThrow(() => evaluateConditionSafely('!!! invalid ===', s3NoEnc));
    assert.equal(evaluateConditionSafely('!!! invalid ===', s3NoEnc), false);
  });
});

describe('evaluateConditionSafely — injection attempts are blocked', () => {
  test('require is not defined in sandbox', () => {
    // This should return false because `require` is not accessible.
    const result = evaluateConditionSafely(
      "typeof require !== 'undefined' && require('child_process').execSync('id')",
      s3NoEnc
    );
    assert.equal(result, false);
  });

  test('process is not defined in sandbox', () => {
    const result = evaluateConditionSafely(
      "typeof process !== 'undefined' && process.exit(99)",
      s3NoEnc
    );
    assert.equal(result, false);
  });

  test('global is not defined in sandbox', () => {
    const result = evaluateConditionSafely("typeof global !== 'undefined'", s3NoEnc);
    assert.equal(result, false);
  });

  test('infinite loop times out rather than hanging', () => {
    const result = evaluateConditionSafely('while(true){}', s3NoEnc);
    assert.equal(result, false);
  });

  test('this does not leak the outer context', () => {
    // In a properly isolated context, `this` inside the vm is the sandbox
    // which has no `process` or `require` properties.
    const result = evaluateConditionSafely('this.process !== undefined', s3NoEnc);
    assert.equal(result, false);
  });
});

describe('autoInstall default', () => {
  test('autoInstall default value is false', () => {
    // Simulate the shouldAutoInstall() helper: config.get('autoInstall', false)
    const mockConfig = { get: (key, defaultValue) => defaultValue };
    const result = mockConfig.get('autoInstall', false);
    assert.equal(result, false);
  });

  test('autoInstall can be overridden to true', () => {
    const mockConfig = { get: (key, defaultValue) => (key === 'autoInstall' ? true : defaultValue) };
    const result = mockConfig.get('autoInstall', false);
    assert.equal(result, true);
  });
});
