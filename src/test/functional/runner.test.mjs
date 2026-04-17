/**
 * Functional tests for the compiled cdkNagRunner.
 *
 * These tests drive the actual on-disk runner binary (out/cdkNagRunner.js)
 * with real CloudFormation template fixtures. They verify end-to-end that:
 *
 *  1. Built-in cdk-nag rule packs (AwsSolutionsChecks, etc.) actually emit
 *     findings — this is the regression test for issue #4, where the packs
 *     silently produced zero findings because the runner was misusing the
 *     cdk-nag API (passing a plain YAML-parsed object to a visitor that
 *     expects an IConstruct).
 *  2. Custom rules evaluate safely inside the vm sandbox and emit findings
 *     when conditions match.
 *  3. Injection attempts against the custom-rule sandbox (require, process,
 *     infinite loops) are blocked without crashing the runner.
 *  4. Clean/compliant inputs produce zero findings without spurious output.
 *  5. Malformed input is surfaced via a non-zero exit code, not a silent
 *     success.
 *
 * These run against the built artefact in `out/` — make sure to
 * `npm run compile` first (the `test:functional` script enforces this).
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(REPO_ROOT, 'out', 'cdkNagRunner.js');
const FIXTURES = path.join(__dirname, 'fixtures');

function runRunner(inputObj) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'cdk-nag-func-'));
  const inputPath = path.join(workDir, 'input.json');
  writeFileSync(inputPath, JSON.stringify(inputObj));
  try {
    const result = spawnSync(process.execPath, [RUNNER, inputPath], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    let parsed = null;
    if (result.stdout && result.stdout.trim().length > 0) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = null;
      }
    }
    return {
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      findings: parsed,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function templatePath(name) {
  return path.join(FIXTURES, name);
}

describe('cdkNagRunner — pre-flight', () => {
  before(() => {
    if (!existsSync(RUNNER)) {
      throw new Error(
        `Runner binary not found at ${RUNNER}. Run \`npm run compile\` before invoking functional tests.`
      );
    }
  });

  test('runner binary is present on disk', () => {
    assert.ok(existsSync(RUNNER), 'out/cdkNagRunner.js missing');
  });
});

describe('cdkNagRunner — built-in rule packs (regression for issue #4)', () => {
  test('AwsSolutionsChecks emits at least one finding against an unencrypted S3 bucket', () => {
    const result = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: ['AwsSolutionsChecks'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });

    assert.equal(result.exitCode, 0, `runner exited ${result.exitCode}; stderr: ${result.stderr}`);
    assert.ok(Array.isArray(result.findings), `findings must be an array, got: ${result.stdout}`);
    assert.ok(
      result.findings.length > 0,
      'AwsSolutionsChecks produced zero findings against an unencrypted S3 bucket + open SG — ' +
        'this is the original issue #4 bug (pack.visit(yaml_parsed) silently did nothing).'
    );
  });

  test('AwsSolutionsChecks flags S3 SSL-only policy missing (S10) on unencrypted bucket', () => {
    const { findings } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: ['AwsSolutionsChecks'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });
    const s10 = findings.find((f) => f.id === 'AwsSolutions-S10');
    assert.ok(s10, `expected AwsSolutions-S10 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(s10.resourceId, 'UnencryptedBucket');
    assert.equal(s10.level, 'ERROR');
  });

  test('AwsSolutionsChecks flags SG open to 0.0.0.0/0 (EC23)', () => {
    const { findings } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: ['AwsSolutionsChecks'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });
    const ec23 = findings.find((f) => f.id === 'AwsSolutions-EC23');
    assert.ok(ec23, `expected AwsSolutions-EC23 finding, got: ${JSON.stringify(findings)}`);
    assert.equal(ec23.resourceId, 'OpenSg');
  });

  test('best-practice S3 bucket produces fewer findings than an empty-properties bucket', () => {
    // A comparative check: the properly-configured bucket should at minimum
    // not trip the access-logging rule (S1), since it has LoggingConfiguration.
    // S10 (SSL-only bucket policy) still needs a separate BucketPolicy resource
    // to satisfy fully, so we don't hard-code its absence — only verify we
    // clear the findings that the properties actually address.
    const insecure = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: ['AwsSolutionsChecks'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });
    const compliant = runRunner({
      templatePath: templatePath('compliant-s3.yaml'),
      rulePacks: ['AwsSolutionsChecks'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });
    assert.equal(insecure.exitCode, 0);
    assert.equal(compliant.exitCode, 0);
    const insecureS3 = insecure.findings.filter((f) => f.id.startsWith('AwsSolutions-S'));
    const compliantS3 = compliant.findings.filter((f) => f.id.startsWith('AwsSolutions-S'));
    assert.ok(
      compliantS3.length < insecureS3.length,
      `best-practice S3 bucket should produce strictly fewer S-rule findings ` +
        `than no-props bucket; got compliant=${JSON.stringify(compliantS3.map((f) => f.id))} ` +
        `vs insecure=${JSON.stringify(insecureS3.map((f) => f.id))}`
    );
    // S1 (access logs) is specifically addressed by LoggingConfiguration —
    // verify that regression.
    const s1 = compliant.findings.find((f) => f.id === 'AwsSolutions-S1');
    assert.equal(
      s1,
      undefined,
      `compliant bucket has LoggingConfiguration but still tripped S1: ${JSON.stringify(s1)}`
    );
  });

  test('empty template produces zero findings and exits cleanly', () => {
    const { findings, exitCode } = runRunner({
      templatePath: templatePath('empty.yaml'),
      rulePacks: ['AwsSolutionsChecks'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(findings, []);
  });

  test('unknown rule pack does not crash the runner', () => {
    const { exitCode, findings, stderr } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: ['ThisPackDoesNotExist'],
      customRules: [],
      workspacePath: REPO_ROOT,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(findings, []);
    assert.match(stderr, /not found in cdk-nag/);
  });
});

describe('cdkNagRunner — custom rules', () => {
  test('matching custom rule emits a finding', () => {
    const { findings, exitCode } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: [],
      customRules: [
        {
          id: 'CUSTOM_S3_ENC',
          name: 'S3 must be encrypted',
          description: 'Custom rule: S3 buckets must declare BucketEncryption',
          level: 'ERROR',
          resourceTypes: ['AWS::S3::Bucket'],
          condition: '!resource.Properties.BucketEncryption',
        },
      ],
      workspacePath: REPO_ROOT,
    });
    assert.equal(exitCode, 0);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'CUSTOM_S3_ENC');
    assert.equal(findings[0].resourceId, 'UnencryptedBucket');
  });

  test('non-matching custom rule emits no finding', () => {
    const { findings, exitCode } = runRunner({
      templatePath: templatePath('compliant-s3.yaml'),
      rulePacks: [],
      customRules: [
        {
          id: 'CUSTOM_S3_ENC',
          name: 'S3 must be encrypted',
          description: 'Custom rule: S3 buckets must declare BucketEncryption',
          level: 'ERROR',
          resourceTypes: ['AWS::S3::Bucket'],
          condition: '!resource.Properties.BucketEncryption',
        },
      ],
      workspacePath: REPO_ROOT,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(findings, []);
  });

  test('custom rule with non-matching resourceType is skipped', () => {
    const { findings } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: [],
      customRules: [
        {
          id: 'NEVER_MATCHES',
          name: 'Only matches DynamoDB tables',
          description: 'test',
          level: 'ERROR',
          resourceTypes: ['AWS::DynamoDB::Table'],
          condition: 'true',
        },
      ],
      workspacePath: REPO_ROOT,
    });
    assert.deepEqual(findings, []);
  });
});

describe('cdkNagRunner — sandbox hardening (integration)', () => {
  test('condition calling require() is blocked with warning on stderr', () => {
    const { findings, stderr, exitCode } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: [],
      customRules: [
        {
          id: 'EVIL_REQUIRE',
          name: 'injection attempt',
          description: 'should be blocked',
          level: 'ERROR',
          resourceTypes: ['AWS::S3::Bucket'],
          condition: "require('child_process').execSync('id').toString()",
        },
      ],
      workspacePath: REPO_ROOT,
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(findings, []);
    assert.match(stderr, /require is not defined/);
  });

  test('condition reading process.env is blocked', () => {
    const { findings, stderr } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: [],
      customRules: [
        {
          id: 'EVIL_PROCESS',
          name: 'process access',
          description: 'should be blocked',
          level: 'ERROR',
          resourceTypes: ['AWS::S3::Bucket'],
          condition: 'process.env.HOME',
        },
      ],
      workspacePath: REPO_ROOT,
    });
    assert.deepEqual(findings, []);
    assert.match(stderr, /process is not defined/);
  });

  test('infinite-loop condition times out at 500ms without hanging', () => {
    const start = Date.now();
    const { findings, stderr } = runRunner({
      templatePath: templatePath('insecure-s3-and-sg.yaml'),
      rulePacks: [],
      customRules: [
        {
          id: 'INFINITE',
          name: 'infinite loop',
          description: 'should time out',
          level: 'ERROR',
          resourceTypes: ['AWS::S3::Bucket'],
          condition: 'while(true){}; true',
        },
      ],
      workspacePath: REPO_ROOT,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(findings, []);
    assert.match(stderr, /timed out/i);
    // Generous bound — the 500ms vm timeout plus process startup should be
    // well under 10s. This catches true hangs.
    assert.ok(elapsed < 10_000, `runner took ${elapsed}ms — possible hang`);
  });
});

describe('cdkNagRunner — error handling', () => {
  test('missing input path exits non-zero with usage message', () => {
    const result = spawnSync(process.execPath, [RUNNER], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage/);
  });

  test('nonexistent template path exits non-zero with fatal message', () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'cdk-nag-func-'));
    try {
      const inputPath = path.join(workDir, 'input.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          templatePath: '/does/not/exist.yaml',
          rulePacks: ['AwsSolutionsChecks'],
          customRules: [],
          workspacePath: REPO_ROOT,
        })
      );
      const result = spawnSync(process.execPath, [RUNNER, inputPath], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Fatal/i);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
