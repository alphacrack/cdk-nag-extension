import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface CdkNagConfig {
  useProjectCdkNag: boolean;
  defaultRules: {
    [key: string]: boolean;
  };
  customRules: string[];
  suppressions: string[];
}

export class ConfigManager {
  private static readonly CONFIG_FILE = '.vscode/cdk-nag-config.json';
  private static readonly DEFAULT_RULES = {
    'AwsSolutions': true,
    'HIPAA.Security': false,
    'NIST.800-53.R4': false,
    'PCI DSS 321': false
  };

  public static async getConfig(workspaceRoot: string): Promise<CdkNagConfig> {
    const configPath = path.join(workspaceRoot, this.CONFIG_FILE);
    
    try {
      if (fs.existsSync(configPath)) {
        const configContent = await fs.promises.readFile(configPath, 'utf8');
        return JSON.parse(configContent);
      }
    } catch (error) {
      console.error('Error reading config file:', error);
    }

    return {
      useProjectCdkNag: true,
      defaultRules: { ...this.DEFAULT_RULES },
      customRules: [],
      suppressions: []
    };
  }

  public static async saveConfig(workspaceRoot: string, config: CdkNagConfig): Promise<void> {
    const configPath = path.join(workspaceRoot, this.CONFIG_FILE);
    const configDir = path.dirname(configPath);

    try {
      if (!fs.existsSync(configDir)) {
        await fs.promises.mkdir(configDir, { recursive: true });
      }
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error saving config file:', error);
      throw error;
    }
  }

  public static async checkProjectCdkNag(workspaceRoot: string): Promise<boolean> {
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
        return packageJson.dependencies?.['cdk-nag'] !== undefined || 
               packageJson.devDependencies?.['cdk-nag'] !== undefined;
      }
    } catch (error) {
      console.error('Error checking project CDK-NAG:', error);
    }
    return false;
  }

  public static async configureRules(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const hasProjectCdkNag = await this.checkProjectCdkNag(workspaceRoot);
    const config = await this.getConfig(workspaceRoot);

    // Show quick pick for rule selection
    const ruleItems = Object.entries(config.defaultRules).map(([rule, enabled]) => ({
      label: rule,
      description: enabled ? 'Enabled' : 'Disabled',
      picked: enabled
    }));

    const selectedRules = await vscode.window.showQuickPick(ruleItems, {
      canPickMany: true,
      placeHolder: 'Select CDK-NAG rules to apply'
    });

    if (selectedRules) {
      // Update config with selected rules
      const newConfig: CdkNagConfig = {
        useProjectCdkNag: hasProjectCdkNag,
        defaultRules: {},
        customRules: config.customRules,
        suppressions: config.suppressions
      };

      // Set all rules to false first
      Object.keys(config.defaultRules).forEach(rule => {
        newConfig.defaultRules[rule] = false;
      });

      // Enable selected rules
      selectedRules.forEach(rule => {
        newConfig.defaultRules[rule.label] = true;
      });

      await this.saveConfig(workspaceRoot, newConfig);
      vscode.window.showInformationMessage('CDK-NAG rules configured successfully');
    }
  }
} 