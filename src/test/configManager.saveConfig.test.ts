import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../configManager';

// The file-wide mock lets saveConfig tests spy on its blocking existsSync use.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: jest.fn(actual.existsSync) };
});

describe('ConfigManager.saveConfig', () => {
  it('creates the config directory without a blocking existsSync check', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-config-'));

    try {
      await ConfigManager.saveConfig(workspaceRoot, {
        cdkNagPackage: { name: 'cdk-nag', isCustom: false },
        useProjectCdkNag: true,
        defaultRules: { AwsSolutions: true },
        customRules: [],
        suppressions: [],
      });

      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspaceRoot, '.vscode', 'cdk-nag-config.json'))).toBe(true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('overwrites the config when the directory already exists', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-config-'));
    const configDir = path.join(workspaceRoot, '.vscode');
    const configPath = path.join(configDir, 'cdk-nag-config.json');
    const config = {
      cdkNagPackage: { name: 'custom-cdk-nag', isCustom: true },
      useProjectCdkNag: false,
      defaultRules: { AwsSolutions: false },
      customRules: ['CustomRule'],
      suppressions: ['Existing suppression'],
    };

    try {
      fs.mkdirSync(configDir);
      await fs.promises.writeFile(configPath, 'old config');

      await expect(ConfigManager.saveConfig(workspaceRoot, config)).resolves.toBeUndefined();

      expect(JSON.parse(await fs.promises.readFile(configPath, 'utf8'))).toEqual(config);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
