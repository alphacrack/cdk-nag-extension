/**
 * Unit tests for ConfigManager.checkProjectCdkNag.
 *
 * The helper reads the workspace `package.json` and reports whether the given
 * package is declared in either `dependencies` or `devDependencies`. Since
 * `cdk-nag` is almost always a dev dependency, dropping that branch would ship
 * unnoticed without these tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConfigManager } from '../configManager';

describe('ConfigManager.checkProjectCdkNag', () => {
  let tmpDir: string;

  const writePackageJson = (content: string | object) => {
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), serialized);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves true when cdk-nag is in dependencies', async () => {
    writePackageJson({ dependencies: { 'cdk-nag': '^2.0.0' } });
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'cdk-nag')).resolves.toBe(true);
  });

  it('resolves true when cdk-nag is in devDependencies', async () => {
    writePackageJson({ devDependencies: { 'cdk-nag': '^2.0.0' } });
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'cdk-nag')).resolves.toBe(true);
  });

  it('resolves false when only an unrelated package is present', async () => {
    writePackageJson({ dependencies: { 'aws-cdk-lib': '^2.0.0' } });
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'cdk-nag')).resolves.toBe(false);
  });

  it('resolves false and does not throw when there are no dependency blocks', async () => {
    writePackageJson({});
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'cdk-nag')).resolves.toBe(false);
  });

  it('resolves false when there is no package.json', async () => {
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'cdk-nag')).resolves.toBe(false);
  });

  it('resolves false when package.json contains malformed JSON', async () => {
    writePackageJson('{ dependencies: { not json !!');
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'cdk-nag')).resolves.toBe(false);
  });

  it('resolves true for a custom package name — proving it is not hard-coded to cdk-nag', async () => {
    writePackageJson({ devDependencies: { 'my-org-nag': '1.0.0' } });
    await expect(ConfigManager.checkProjectCdkNag(tmpDir, 'my-org-nag')).resolves.toBe(true);
  });
});
