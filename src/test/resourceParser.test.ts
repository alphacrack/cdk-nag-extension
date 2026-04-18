/**
 * Jest tests for the multi-line-aware resource parser. These cases are the
 * realistic shapes of CDK construct declarations we see in user projects —
 * the old single-line regex could not handle most of them.
 */

import { parseResourceDefinitions } from '../resourceParser';

describe('parseResourceDefinitions', () => {
  it('matches a single-line construct with a simple config', () => {
    const src = `new Bucket(this, 'MyBucket', { versioned: true });`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      type: 'Bucket',
      id: 'MyBucket',
      config: ' versioned: true ',
    });
  });

  it('matches a construct that spans multiple lines with nested objects', () => {
    const src = `
      new s3.Bucket(this, 'LogBucket', {
        encryption: s3.BucketEncryption.S3_MANAGED,
        serverAccessLogsPrefix: 'access/',
        lifecycleRules: [
          { expiration: cdk.Duration.days(90) },
        ],
      });
    `;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe('s3.Bucket');
    expect(defs[0].id).toBe('LogBucket');
    expect(defs[0].config).toContain('BucketEncryption.S3_MANAGED');
    expect(defs[0].config).toContain('lifecycleRules');
  });

  it('matches constructs with no third argument (2-arg form)', () => {
    const src = `new Bucket(this, 'UnencryptedBucket');`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      type: 'Bucket',
      id: 'UnencryptedBucket',
      config: null,
    });
  });

  it('matches constructs with a non-object third argument (e.g. variable)', () => {
    const src = `new SecurityGroup(this, 'OpenSg', props);`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      type: 'SecurityGroup',
      id: 'OpenSg',
      config: null,
    });
  });

  it('finds multiple constructs in a stack', () => {
    const src = `
      const bucket = new Bucket(this, 'A', { versioned: true });
      const other = new s3.Bucket(this, 'B');
      new SecurityGroup(this, 'C', { vpc });
    `;
    const defs = parseResourceDefinitions(src);
    expect(defs.map(d => d.id)).toEqual(['A', 'B', 'C']);
    expect(defs.map(d => d.type)).toEqual(['Bucket', 's3.Bucket', 'SecurityGroup']);
  });

  it('ignores `new X` occurrences inside string literals', () => {
    const src = `
      const foo = "new Bucket(this, 'Ghost', {})";
      new Real(this, 'id', {});
    `;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe('id');
  });

  it('ignores `new X` occurrences inside block comments', () => {
    const src = `
      /*
        new Bucket(this, 'Commented', {});
      */
      new Real(this, 'id');
    `;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe('id');
  });

  it('ignores `new X` occurrences inside line comments', () => {
    const src = `
      // new Bucket(this, 'LineCommented', {});
      new Real(this, 'id');
    `;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe('id');
  });

  it('tolerates a closing-brace inside a string inside the config', () => {
    const src = `new Bucket(this, 'B', { tag: "a}b", versioned: true });`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(defs[0].config).toContain('versioned: true');
  });

  it('returns non-overlapping source ranges', () => {
    const src = `new A(this, 'a');new B(this, 'b', { x: 1 });`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(2);
    // First construct's end must not overlap the second's start
    expect(defs[0].end).toBeLessThanOrEqual(defs[1].start);
    // Each range must correspond to the source text
    expect(src.slice(defs[0].start, defs[0].end)).toContain("'a'");
    expect(src.slice(defs[1].start, defs[1].end)).toContain("'b'");
  });

  it('does not match `newBucket(...)` (identifier prefixed with `new`)', () => {
    const src = `newBucket(this, 'X', {});`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(0);
  });

  it('does not match calls whose first arg is not `this`', () => {
    const src = `new Bucket(scope, 'X', {});`;
    const defs = parseResourceDefinitions(src);
    expect(defs).toHaveLength(0);
  });

  it('handles the real insecure-stack sample shape', () => {
    const src = `
      import { Bucket } from 'aws-cdk-lib/aws-s3';
      new Bucket(this, 'UnencryptedBucket');
      const vpc = new Vpc(this, 'Vpc');
      const sg = new SecurityGroup(this, 'OpenSg', { vpc });
      sg.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
    `;
    const defs = parseResourceDefinitions(src);
    expect(defs.map(d => d.id)).toEqual(['UnencryptedBucket', 'Vpc', 'OpenSg']);
  });
});
