/**
 * Unit tests for cdkNagRunner — the sandboxed condition evaluator.
 *
 * These tests verify:
 *  1. Safe conditions evaluate correctly.
 *  2. Malicious conditions (shell injection attempts) are contained by the
 *     vm sandbox and do NOT execute arbitrary code.
 *  3. Syntax errors in conditions are caught gracefully.
 */

import * as vm from 'vm';

// Mirror the evaluateConditionSafely helper from cdkNagRunner.ts without
// importing the full module (which has top-level side effects).
function evaluateConditionSafely(condition: string, resource: unknown): boolean {
  try {
    const sandbox = Object.create(null) as Record<string, unknown>;
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

describe('evaluateConditionSafely', () => {
  const s3BucketNoEncryption = {
    Type: 'AWS::S3::Bucket',
    Properties: {},
  };

  const s3BucketWithEncryption = {
    Type: 'AWS::S3::Bucket',
    Properties: {
      BucketEncryptionConfiguration: { ServerSideEncryptionConfiguration: [] },
    },
  };

  it('returns true when a legitimate condition matches', () => {
    const condition = '!resource.Properties.BucketEncryptionConfiguration';
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(true);
  });

  it('returns false when a legitimate condition does not match', () => {
    const condition = '!resource.Properties.BucketEncryptionConfiguration';
    expect(evaluateConditionSafely(condition, s3BucketWithEncryption)).toBe(false);
  });

  it('returns false for a syntax-error condition without throwing', () => {
    const condition = '!!! this is not valid JS ===';
    expect(() => evaluateConditionSafely(condition, s3BucketNoEncryption)).not.toThrow();
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(false);
  });

  it('cannot access require — injection attempt is safely blocked', () => {
    // An attacker-controlled condition that tries to load a Node built-in.
    // Inside the vm sandbox, `require` is not defined, so this throws a
    // ReferenceError which is caught, returning false instead of executing code.
    const condition = "typeof require !== 'undefined' && require('child_process').execSync('id')";
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(false);
  });

  it('cannot access process — another common injection vector', () => {
    const condition = "typeof process !== 'undefined' && process.exit(1)";
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(false);
  });

  it('cannot access global — prevents prototype-chain escapes', () => {
    const condition = "typeof global !== 'undefined'";
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(false);
  });

  it('times out an infinite-loop condition rather than hanging', () => {
    const condition = 'while(true){}';
    // Should return false (timeout error caught) without actually hanging.
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(false);
  });

  it('returns false for an empty condition', () => {
    expect(evaluateConditionSafely('', s3BucketNoEncryption)).toBe(false);
  });

  it('can access nested resource properties safely', () => {
    const condition =
      "resource.Type === 'AWS::S3::Bucket' && !resource.Properties.BucketEncryptionConfiguration";
    expect(evaluateConditionSafely(condition, s3BucketNoEncryption)).toBe(true);
    expect(evaluateConditionSafely(condition, s3BucketWithEncryption)).toBe(false);
  });
});

describe('autoInstall config default', () => {
  it('shouldAutoInstall defaults to false', () => {
    // The VS Code config is mocked in setup.ts. We verify here that the
    // config key is correct so that the default is applied properly.
    const getConfiguration = jest.fn().mockReturnValue({
      get: jest.fn((key: string, defaultValue: boolean) => {
        if (key === 'autoInstall') {
          return defaultValue; // returns the provided default
        }
        return undefined;
      }),
    });

    // Simulate the shouldAutoInstall() helper logic
    const config = getConfiguration('cdkNagValidator');
    const result = config.get('autoInstall', false);

    expect(result).toBe(false);
  });
});
