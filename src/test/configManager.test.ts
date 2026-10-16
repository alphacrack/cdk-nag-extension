import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../configManager';

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
});
