/**
 * Jest unit tests for ConfigManager — the JSON-file-backed workspace config
 * for custom rules and suppressions.
 *
 * These tests run against real temp directories so the fs promises paths are
 * exercised end-to-end. The `vscode` module is mocked via moduleNameMapper
 * in jest.config.js → src/test/__mocks__/vscode.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../configManager';

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-configmanager-test-'));
}

function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('ConfigManager.getConfig', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    rmTree(workspace);
  });

  it('returns defaults when no config file exists', async () => {
    const config = await ConfigManager.getConfig(workspace);
    expect(config.cdkNagPackage.name).toBe('cdk-nag');
    expect(config.cdkNagPackage.isCustom).toBe(false);
    expect(config.useProjectCdkNag).toBe(true);
    expect(config.defaultRules).toEqual({
      AwsSolutions: true,
      'HIPAA.Security': false,
      'NIST.800-53.R4': false,
      'PCI DSS 321': false,
    });
    expect(config.customRules).toEqual([]);
    expect(config.suppressions).toEqual([]);
  });

  it('returns saved config when file exists', async () => {
    const expected = {
      cdkNagPackage: { name: 'cdk-nag', isCustom: false },
      useProjectCdkNag: false,
      defaultRules: { AwsSolutions: false, 'HIPAA.Security': true },
      customRules: ['rule1'],
      suppressions: ['AwsSolutions-S1'],
    };
    const configDir = path.join(workspace, '.vscode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'cdk-nag-config.json'), JSON.stringify(expected));

    const config = await ConfigManager.getConfig(workspace);
    expect(config).toEqual(expected);
  });

  it('falls back to defaults when config file is malformed JSON', async () => {
    const configDir = path.join(workspace, '.vscode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'cdk-nag-config.json'), '{ this is not valid JSON');

    const config = await ConfigManager.getConfig(workspace);
    // Falls back to defaults without throwing.
    expect(config.cdkNagPackage.name).toBe('cdk-nag');
    expect(config.useProjectCdkNag).toBe(true);
  });
});

describe('ConfigManager.saveConfig', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    rmTree(workspace);
  });

  it('creates .vscode/ directory if missing', async () => {
    const configToSave = {
      cdkNagPackage: { name: 'cdk-nag', isCustom: false },
      useProjectCdkNag: true,
      defaultRules: { AwsSolutions: true },
      customRules: [],
      suppressions: [],
    };

    expect(fs.existsSync(path.join(workspace, '.vscode'))).toBe(false);
    await ConfigManager.saveConfig(workspace, configToSave);
    expect(fs.existsSync(path.join(workspace, '.vscode', 'cdk-nag-config.json'))).toBe(true);
  });

  it('round-trips: saveConfig then getConfig returns the same value', async () => {
    const original = {
      cdkNagPackage: { name: 'my-custom-nag', isCustom: true },
      useProjectCdkNag: false,
      defaultRules: { 'NIST.800-53.R4': true },
      customRules: ['ruleA', 'ruleB'],
      suppressions: ['AwsSolutions-S10'],
    };
    await ConfigManager.saveConfig(workspace, original);
    const loaded = await ConfigManager.getConfig(workspace);
    expect(loaded).toEqual(original);
  });

  it('overwrites an existing config file', async () => {
    const first = {
      cdkNagPackage: { name: 'cdk-nag', isCustom: false },
      useProjectCdkNag: true,
      defaultRules: {},
      customRules: [],
      suppressions: [],
    };
    const second = {
      cdkNagPackage: { name: 'cdk-nag', isCustom: false },
      useProjectCdkNag: false,
      defaultRules: { AwsSolutions: true },
      customRules: ['newRule'],
      suppressions: ['supp1'],
    };
    await ConfigManager.saveConfig(workspace, first);
    await ConfigManager.saveConfig(workspace, second);
    const loaded = await ConfigManager.getConfig(workspace);
    expect(loaded).toEqual(second);
  });
});

describe('ConfigManager.checkProjectCdkNag', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    rmTree(workspace);
  });

  it('returns false when no package.json exists', async () => {
    expect(await ConfigManager.checkProjectCdkNag(workspace, 'cdk-nag')).toBe(false);
  });

  it('returns true when package is in dependencies', async () => {
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ dependencies: { 'cdk-nag': '^2.0.0' } })
    );
    expect(await ConfigManager.checkProjectCdkNag(workspace, 'cdk-nag')).toBe(true);
  });

  it('returns true when package is in devDependencies', async () => {
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ devDependencies: { 'cdk-nag': '^2.0.0' } })
    );
    expect(await ConfigManager.checkProjectCdkNag(workspace, 'cdk-nag')).toBe(true);
  });

  it('returns false when package is not listed', async () => {
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ dependencies: { 'other-pkg': '^1.0.0' } })
    );
    expect(await ConfigManager.checkProjectCdkNag(workspace, 'cdk-nag')).toBe(false);
  });

  it('returns false when package.json is malformed and does not throw', async () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), 'not valid json');
    await expect(ConfigManager.checkProjectCdkNag(workspace, 'cdk-nag')).resolves.toBe(false);
  });

  it('finds a custom-named package', async () => {
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ devDependencies: { 'custom-nag': '^1.0.0' } })
    );
    expect(await ConfigManager.checkProjectCdkNag(workspace, 'custom-nag')).toBe(true);
  });
});

describe('ConfigManager.getCdkNagPackage', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    rmTree(workspace);
  });

  it('returns default cdk-nag when no config exists', async () => {
    const pkg = await ConfigManager.getCdkNagPackage(workspace);
    expect(pkg.name).toBe('cdk-nag');
    expect(pkg.isCustom).toBe(false);
  });

  it('returns saved custom package name', async () => {
    await ConfigManager.saveConfig(workspace, {
      cdkNagPackage: { name: 'internal-nag', isCustom: true },
      useProjectCdkNag: true,
      defaultRules: {},
      customRules: [],
      suppressions: [],
    });
    const pkg = await ConfigManager.getCdkNagPackage(workspace);
    expect(pkg.name).toBe('internal-nag');
    expect(pkg.isCustom).toBe(true);
  });
});

describe('ConfigManager.addSuppression / getSuppressions', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    rmTree(workspace);
  });

  it('adds a rule id to an empty suppressions list', async () => {
    const added = await ConfigManager.addSuppression(workspace, 'AwsSolutions-S1');
    expect(added).toBe(true);
    const list = await ConfigManager.getSuppressions(workspace);
    expect(list).toEqual(['AwsSolutions-S1']);
  });

  it('is idempotent — adding the same rule twice returns false on the second call', async () => {
    await ConfigManager.addSuppression(workspace, 'AwsSolutions-S1');
    const second = await ConfigManager.addSuppression(workspace, 'AwsSolutions-S1');
    expect(second).toBe(false);
    const list = await ConfigManager.getSuppressions(workspace);
    expect(list).toEqual(['AwsSolutions-S1']);
  });

  it('appends without clobbering an existing suppressions list', async () => {
    await ConfigManager.saveConfig(workspace, {
      cdkNagPackage: { name: 'cdk-nag', isCustom: false },
      useProjectCdkNag: true,
      defaultRules: {},
      customRules: [],
      suppressions: ['AwsSolutions-EC23'],
    });
    const added = await ConfigManager.addSuppression(workspace, 'AwsSolutions-S1');
    expect(added).toBe(true);
    const list = await ConfigManager.getSuppressions(workspace);
    expect(list).toEqual(['AwsSolutions-EC23', 'AwsSolutions-S1']);
  });

  it('getSuppressions returns [] when no config file exists', async () => {
    const list = await ConfigManager.getSuppressions(workspace);
    expect(list).toEqual([]);
  });

  it('persists suppressions in the on-disk JSON file', async () => {
    await ConfigManager.addSuppression(workspace, 'AwsSolutions-S1');
    const raw = fs.readFileSync(path.join(workspace, '.vscode', 'cdk-nag-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.suppressions).toEqual(['AwsSolutions-S1']);
  });
});
