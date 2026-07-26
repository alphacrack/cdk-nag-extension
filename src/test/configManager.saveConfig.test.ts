import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../configManager';

const firstConfig = {
  cdkNagPackage: { name: 'cdk-nag', isCustom: false },
  useProjectCdkNag: true,
  defaultRules: { AwsSolutions: true },
  customRules: [],
  suppressions: [],
};

const updatedConfig = {
  cdkNagPackage: { name: 'custom-nag', isCustom: true },
  useProjectCdkNag: false,
  defaultRules: { AwsSolutions: false, 'HIPAA.Security': true },
  customRules: ['CustomRule'],
  suppressions: ['AwsSolutions-S1'],
};

describe('ConfigManager.saveConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-save-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function configPath(): string {
    return path.join(tmpDir, '.vscode', 'cdk-nag-config.json');
  }

  it('creates the .vscode directory and writes pretty-printed config JSON', async () => {
    await ConfigManager.saveConfig(tmpDir, firstConfig);

    const vscodeDir = path.join(tmpDir, '.vscode');
    expect(fs.existsSync(vscodeDir)).toBe(true);
    expect(fs.existsSync(configPath())).toBe(true);

    const raw = fs.readFileSync(configPath(), 'utf8');
    expect(raw).toBe(JSON.stringify(firstConfig, null, 2));
    expect(JSON.parse(raw)).toEqual(firstConfig);
  });

  it('overwrites the existing config when .vscode already exists', async () => {
    await ConfigManager.saveConfig(tmpDir, firstConfig);
    await expect(ConfigManager.saveConfig(tmpDir, updatedConfig)).resolves.toBeUndefined();

    const raw = fs.readFileSync(configPath(), 'utf8');
    expect(raw).toBe(JSON.stringify(updatedConfig, null, 2));
    expect(JSON.parse(raw)).toEqual(updatedConfig);
  });
});
