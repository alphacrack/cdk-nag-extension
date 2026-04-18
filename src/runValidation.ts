// Workspace CDK-NAG validation orchestration.
//
// Extracted from `extension.ts` in PR 6 so both the command handlers
// (`validateFile` / `validateWorkspace`) and the `cdkNag_validateFile`
// Language Model Tool can call the same pipeline without importing each
// other and creating a circular dependency.
//
// Pipeline:
//   1. Read settings (rulePacks + customRules + autoInstall) — can be
//      overridden per-call via the optional `overrides` argument so the tool
//      can accept a `rulePacks` input and still produce a valid runner input.
//   2. Optionally `npm install` the workspace (opt-in via `autoInstall`).
//   3. `cdk synth --no-staging` to produce a CloudFormation template.
//   4. Write the template + runner input to a temp dir.
//   5. Read workspace-level suppressions (via `ConfigManager`).
//   6. Spawn the runner child process (no shell, JSON file input) and return
//      the parsed findings array.
//
// Cancellation is honoured at every awaitable step (so `cmd+.` from the
// progress notification and `token.onCancellationRequested` from a tool
// invocation both stop the work promptly).

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigManager } from './configManager';
import { getOutputChannel } from './outputChannel';
import { spawnRunner, ValidationCancelledError } from './runner';

const execAsync = promisify(exec);

/** Shape of a single finding as emitted by the runner. */
export interface CdkNagFinding {
  id: string;
  name: string;
  description: string;
  level: string;
  resourceId: string;
}

/** Whitelist — must stay in sync with the enum in package.json. */
export const AVAILABLE_RULE_PACKS = [
  'AwsSolutionsChecks',
  'HIPAA.SecurityChecks',
  'NIST.800-53.R4Checks',
  'NIST.800-53.R5Checks',
  'PCI.DSS.321Checks',
  'ServerlessChecks',
];

export interface RunValidationOverrides {
  /** Override the enabled rule packs for this invocation. */
  rulePacks?: string[];
  /** Override custom rules for this invocation. */
  customRules?: unknown[];
  /** Override autoInstall for this invocation. */
  autoInstall?: boolean;
}

function getConfiguredRulePacks(): string[] {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  const enabledPacks = config.get<string[]>('enabledRulePacks', ['AwsSolutionsChecks']);
  return enabledPacks.filter(pack => AVAILABLE_RULE_PACKS.includes(pack));
}

function getCustomRules(): unknown[] {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<unknown[]>('customRules', []);
}

function shouldAutoInstall(): boolean {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<boolean>('autoInstall', false);
}

/**
 * Orchestrate a full workspace validation. Returns the parsed findings array.
 * Callers are responsible for deciding what to do with the findings
 * (mapping to diagnostics, streaming to chat, etc.).
 */
export async function runCdkNagValidation(
  workspacePath: string,
  options: {
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    token?: vscode.CancellationToken;
    overrides?: RunValidationOverrides;
  } = {}
): Promise<CdkNagFinding[]> {
  const { progress, token, overrides } = options;
  const channel = getOutputChannel();

  const rulePacks = overrides?.rulePacks
    ? overrides.rulePacks.filter(p => AVAILABLE_RULE_PACKS.includes(p))
    : getConfiguredRulePacks();
  const customRules = overrides?.customRules ?? getCustomRules();
  const autoInstall = overrides?.autoInstall ?? shouldAutoInstall();

  if (rulePacks.length === 0 && customRules.length === 0) {
    throw new Error(
      'No rule packs or custom rules configured. Please enable at least one rule pack or add custom rules in settings.'
    );
  }

  channel.info(`Running CDK-NAG with rule packs: ${rulePacks.join(', ')}`);
  if (customRules.length > 0) {
    channel.info(`Running with ${customRules.length} custom rule(s)`);
  }

  if (token?.isCancellationRequested) {
    throw new ValidationCancelledError();
  }

  if (autoInstall) {
    try {
      progress?.report({ message: 'Installing workspace dependencies…' });
      channel.info('autoInstall is enabled — installing workspace dependencies...');
      await execAsync('npm install aws-cdk aws-cdk-lib cdk-nag yaml --save-dev', {
        cwd: workspacePath,
      });
      channel.info('Dependencies installed successfully');
    } catch (error) {
      channel.error(
        `Error installing dependencies: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new Error(
        `Failed to install required dependencies: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (token?.isCancellationRequested) {
    throw new ValidationCancelledError();
  }

  progress?.report({ message: 'Synthesising CDK template…' });
  const { stdout: synthOutput, stderr: synthError } = await execAsync('cdk synth --no-staging', {
    cwd: workspacePath,
  });
  if (synthError) {
    channel.error(`CDK synth error: ${synthError}`);
    throw new Error(`CDK synthesis failed: ${synthError}`);
  }
  channel.info('CDK synthesis completed successfully');

  if (token?.isCancellationRequested) {
    throw new ValidationCancelledError();
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cdk-nag-'));
  const templatePath = path.join(tempDir, 'template.yaml');
  await fs.promises.writeFile(templatePath, synthOutput);

  let suppressions: string[] = [];
  try {
    suppressions = await ConfigManager.getSuppressions(workspacePath);
  } catch (err) {
    channel.warn(
      `Failed to read suppressions — proceeding without: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const runnerInput = {
    templatePath,
    rulePacks,
    customRules,
    workspacePath,
    suppressions,
  };
  const inputPath = path.join(tempDir, 'runner-input.json');
  await fs.promises.writeFile(inputPath, JSON.stringify(runnerInput, null, 2));

  let stdout: string;
  try {
    progress?.report({ message: `Applying ${rulePacks.length} rule pack(s)…` });
    stdout = await spawnRunner(inputPath, workspacePath, token);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(err => {
      channel.warn(
        `Failed to clean up temp dir ${tempDir}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  channel.debug(`CDK-NAG output: ${stdout}`);

  let findings: CdkNagFinding[];
  try {
    findings = JSON.parse(stdout);
  } catch (parseError) {
    const preview = (stdout ?? '').toString().slice(0, 200);
    const message = `Failed to parse CDK-NAG output as JSON: ${
      parseError instanceof Error ? parseError.message : String(parseError)
    }. Output preview: ${preview}`;
    channel.error(message);
    throw new Error(message);
  }

  return findings;
}
