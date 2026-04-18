// CDK NAG Validator — VS Code extension entry point.
//
// Responsibilities:
//   • Register three user-facing commands (validate, validateWorkspace, configureRules)
//   • Manage a DiagnosticCollection for cdk-nag findings
//   • Fork the sandboxed runner (src/cdkNagRunner.ts) via spawn — no shell, no
//     eval, no interpolation of user input into shell strings
//   • Read all settings from a single namespace (`cdkNagValidator.*`), migrating
//     any legacy keys from `cdk-nag-validator.*` on activation
//   • Route all diagnostic logging through the "CDK NAG" LogOutputChannel
//     (src/outputChannel.ts) rather than console — console output is invisible
//     to users and silently lost at runtime.

import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigManager } from './configManager';
import { getOutputChannel, disposeOutputChannel } from './outputChannel';

const execAsync = promisify(exec);

// DiagnosticCollection is initialised in activate() and cleaned up via
// context.subscriptions.
let diagnosticCollection: vscode.DiagnosticCollection;

// Whitelist of rule packs we support. Must stay in sync with the enum in
// package.json → contributes.configuration.cdkNagValidator.enabledRulePacks.
const AVAILABLE_RULE_PACKS = [
  'AwsSolutionsChecks',
  'HIPAA.SecurityChecks',
  'NIST.800-53.R4Checks',
  'NIST.800-53.R5Checks',
  'PCI.DSS.321Checks',
  'ServerlessChecks',
];

// Static remediation hints keyed by cdk-nag rule ID prefix. Wired into a
// CodeActionProvider in PR 3b (issue tracked in BACKLOG: M2). Kept here so
// the provider has a single source of truth to import.
export const COMMON_FIXES: { [key: string]: string } = {
  S3_BUCKET_ENCRYPTION:
    'Add encryption configuration: new s3.Bucket(this, "Bucket", { encryption: s3.BucketEncryption.S3_MANAGED })',
  S3_BUCKET_VERSIONING: 'Enable versioning: new s3.Bucket(this, "Bucket", { versioned: true })',
  S3_BUCKET_LOGGING:
    'Enable access logging: new s3.Bucket(this, "Bucket", { serverAccessLogsBucket: loggingBucket })',
  DYNAMODB_TABLE_ENCRYPTION:
    'Enable encryption: new dynamodb.Table(this, "Table", { encryption: dynamodb.TableEncryption.AWS_MANAGED })',
  LAMBDA_FUNCTION_LOGGING:
    'Enable logging: new lambda.Function(this, "Function", { logRetention: logs.RetentionDays.ONE_WEEK })',
  API_GATEWAY_LOGGING:
    'Enable logging: new apigateway.RestApi(this, "Api", { deployOptions: { loggingLevel: apigateway.MethodLoggingLevel.INFO } })',
};

// ── Configuration accessors ─────────────────────────────────────────────────
// All settings live under the `cdkNagValidator.*` namespace in settings.json.
// Legacy keys under `cdk-nag-validator.*` are migrated on activation (see
// migrateLegacyConfig below). After v0.3.0 the legacy namespace will be
// dropped entirely.

function getConfiguredRulePacks(): string[] {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  const enabledPacks = config.get<string[]>('enabledRulePacks', ['AwsSolutionsChecks']);
  return enabledPacks.filter(pack => AVAILABLE_RULE_PACKS.includes(pack));
}

function getCustomRules(): unknown[] {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<unknown[]>('customRules', []);
}

export function shouldAutoValidate(): boolean {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<boolean>('autoValidate', true);
}

function shouldAutoInstall(): boolean {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<boolean>('autoInstall', false);
}

// ── Legacy config migration ─────────────────────────────────────────────────
// The original prototype used two settings namespaces: `cdkNagValidator.*`
// (primary, 10 keys) and `cdk-nag-validator.*` (legacy, 2 keys — useProjectCdkNag
// and defaultRules). We've consolidated on `cdkNagValidator.*`. On activation
// we detect any legacy values the user set and copy them to the new namespace,
// surfacing a one-shot information message so they know to update.
//
// NOTE: the legacy keys remain declared in package.json for 2 releases to
// preserve settings-read compatibility. They will be removed in v0.3.0.
export async function migrateLegacyConfig(): Promise<boolean> {
  const channel = getOutputChannel();
  const legacy = vscode.workspace.getConfiguration('cdk-nag-validator');
  const current = vscode.workspace.getConfiguration('cdkNagValidator');

  // [legacyKey, newKey] pairs — kept identical so far; the mapping is 1-to-1.
  const keyMap: Array<[string, string]> = [
    ['useProjectCdkNag', 'useProjectCdkNag'],
    ['defaultRules', 'defaultRules'],
  ];

  let migratedAny = false;
  for (const [legacyKey, newKey] of keyMap) {
    const legacyInspect = legacy.inspect(legacyKey);
    if (!legacyInspect) continue;

    // Only migrate if the user has actually set a value (not a package.json default).
    const userSetLegacy =
      legacyInspect.globalValue !== undefined ||
      legacyInspect.workspaceValue !== undefined ||
      legacyInspect.workspaceFolderValue !== undefined;
    if (!userSetLegacy) continue;

    // Don't clobber a user-set value in the new namespace.
    const currentInspect = current.inspect(newKey);
    const userSetCurrent =
      !!currentInspect &&
      (currentInspect.globalValue !== undefined ||
        currentInspect.workspaceValue !== undefined ||
        currentInspect.workspaceFolderValue !== undefined);
    if (userSetCurrent) {
      channel.warn(
        `Skipping migration of cdk-nag-validator.${legacyKey} — cdkNagValidator.${newKey} is already set.`
      );
      continue;
    }

    // Preserve scope: if the legacy value was workspace-scoped, write workspace;
    // otherwise global.
    const value =
      legacyInspect.workspaceFolderValue ??
      legacyInspect.workspaceValue ??
      legacyInspect.globalValue;
    const target =
      legacyInspect.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : legacyInspect.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    try {
      await current.update(newKey, value, target);
      migratedAny = true;
      channel.info(
        `Migrated cdk-nag-validator.${legacyKey} → cdkNagValidator.${newKey} (scope: ${target}).`
      );
    } catch (err) {
      channel.warn(
        `Failed to migrate cdk-nag-validator.${legacyKey}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (migratedAny) {
    void vscode.window.showInformationMessage(
      'CDK NAG: migrated legacy `cdk-nag-validator.*` settings to `cdkNagValidator.*`. ' +
        'The legacy namespace will be removed in v0.3.0 — please update your settings.'
    );
  }

  return migratedAny;
}

// ── Runner invocation ───────────────────────────────────────────────────────
// Spawn the compiled cdkNagRunner as a child process.
//
// All user-controlled data (template path, custom rule objects) is serialised
// to a temporary JSON file and passed to the runner as a file-system path.
// Nothing is ever interpolated into a shell string, eliminating the
// shell-injection vulnerability that existed in the previous node -e approach.
//
// Custom rule conditions are evaluated inside the runner using
// vm.runInNewContext with a sandboxed context — see src/cdkNagRunner.ts.
async function spawnRunner(inputPath: string, workspacePath: string): Promise<string> {
  const channel = getOutputChannel();
  const runnerScript = path.join(__dirname, 'cdkNagRunner.js');

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    // Use spawn (not exec/execAsync) so that NO shell is involved.
    // argv[2] is the path to the JSON input file — a plain file-system path,
    // not user-supplied data interpolated into a command string.
    const child = spawn(process.execPath, [runnerScript, inputPath], {
      cwd: workspacePath,
      shell: false, // explicit — never invoke a shell
    });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('close', code => {
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`CDK-NAG runner exited with code ${code}: ${stderr}`));
        return;
      }
      if (stderr) {
        channel.warn(`CDK-NAG runner warnings: ${stderr}`);
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    child.on('error', err => reject(err));
  });
}

// Run CDK-NAG with configured rule packs and custom rules
async function runCdkNag(workspacePath: string): Promise<string> {
  const channel = getOutputChannel();
  const rulePacks = getConfiguredRulePacks();
  const customRules = getCustomRules();

  if (rulePacks.length === 0 && customRules.length === 0) {
    throw new Error(
      'No rule packs or custom rules configured. Please enable at least one rule pack or add custom rules in settings.'
    );
  }

  channel.info(`Running CDK-NAG with rule packs: ${rulePacks.join(', ')}`);
  if (customRules.length > 0) {
    channel.info(`Running with ${customRules.length} custom rule(s)`);
  }

  // ── Optional dependency installation (opt-in via cdkNagValidator.autoInstall) ──
  // Auto-running `npm install` in a user's project on every validation is
  // invasive and can break lock-files or trigger unexpected side effects.
  // It is therefore disabled by default; the user must explicitly enable it
  // in settings ("cdkNagValidator.autoInstall": true).
  if (shouldAutoInstall()) {
    try {
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

  // Synthesise the CDK template
  const { stdout: synthOutput, stderr: synthError } = await execAsync('cdk synth --no-staging', {
    cwd: workspacePath,
  });
  if (synthError) {
    channel.error(`CDK synth error: ${synthError}`);
    throw new Error(`CDK synthesis failed: ${synthError}`);
  }
  channel.info('CDK synthesis completed successfully');

  // Write synthesised template to a temp file. Use a unique per-invocation
  // directory so concurrent validations do not race on the same files.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-'));
  const templatePath = path.join(tempDir, 'template.yaml');
  fs.writeFileSync(templatePath, synthOutput);

  // Build the structured input for the runner — pure JSON, no shell escaping.
  const runnerInput = {
    templatePath,
    rulePacks,
    customRules,
    workspacePath,
  };
  const inputPath = path.join(tempDir, 'runner-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(runnerInput, null, 2));

  let stdout: string;
  try {
    stdout = await spawnRunner(inputPath, workspacePath);
  } finally {
    // Always clean up, even on failure.
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  channel.debug(`CDK-NAG output: ${stdout}`);
  return stdout;
}

// ── Finding → source-location mapping ───────────────────────────────────────
// Walks the document text, finds `new XxxCtor(this, 'id', {…})` constructs,
// and attaches the finding's message to the matching construct. Current regex
// only handles single-line constructs; multi-line support is tracked as M3 in
// the BACKLOG and fixed in PR 3b.
async function mapFindingsToSourceLocations(
  document: vscode.TextDocument,
  findings: Array<{
    id: string;
    name: string;
    description: string;
    level: string;
    resourceId: string;
  }>
): Promise<vscode.Diagnostic[]> {
  const channel = getOutputChannel();
  const diagnostics: vscode.Diagnostic[] = [];
  const documentText = document.getText();

  const resourceDefinitions = new Map<
    string,
    { range: vscode.Range; config: string; type: string }
  >();

  const resourceRegex = /new\s+([\w.]+)\s*\(\s*this\s*,\s*['"]([^'"]+)['"]\s*,\s*({[^}]+})/g;
  let match;
  while ((match = resourceRegex.exec(documentText)) !== null) {
    const resourceType = match[1];
    const resourceId = match[2];
    const config = match[3];
    const startPos = document.positionAt(match.index);
    const endPos = document.positionAt(match.index + match[0].length);

    resourceDefinitions.set(resourceId, {
      range: new vscode.Range(startPos, endPos),
      config,
      type: resourceType,
    });
  }

  channel.debug(`Found ${resourceDefinitions.size} resource definition(s) in ${document.fileName}`);

  for (const finding of findings) {
    let foundMatch = false;
    for (const [resourceId, resourceDef] of resourceDefinitions.entries()) {
      // Match by prefix — cdk-nag reports resourceId with an appended hash suffix.
      if (!finding.resourceId.startsWith(resourceId)) continue;
      foundMatch = true;

      // Special-case: for S3 encryption findings, skip diagnostics if the
      // construct config already has encryption set (false positive guard).
      if (finding.id === 'S3_BUCKET_ENCRYPTION' && resourceDef.type.includes('Bucket')) {
        const config = resourceDef.config;
        const hasEncryption =
          config.includes('encryption:') ||
          config.includes('serverSideEncryptionConfiguration:') ||
          config.includes('encryptionConfiguration:');
        if (hasEncryption) {
          channel.debug(`Skipping already-encrypted bucket: ${resourceId}`);
          continue;
        }
      }

      const diagnostic = new vscode.Diagnostic(
        resourceDef.range,
        `${finding.name}: ${finding.description}`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = 'CDK-NAG';
      diagnostic.code = finding.id;
      diagnostics.push(diagnostic);
    }

    if (!foundMatch) {
      channel.debug(`No matching resource in source for finding: ${finding.resourceId}`);
    }
  }

  return diagnostics;
}

// Validate a file
async function validateFile(document: vscode.TextDocument): Promise<void> {
  const channel = getOutputChannel();
  channel.info(`Starting file validation: ${document.fileName}`);

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    throw new Error('No workspace folder found');
  }

  const output = await runCdkNag(workspaceFolder.uri.fsPath);

  // Parse the output (guard against malformed runner output).
  let findings: Array<{
    id: string;
    name: string;
    description: string;
    level: string;
    resourceId: string;
  }>;
  try {
    findings = JSON.parse(output);
  } catch (parseError) {
    const preview = (output ?? '').toString().slice(0, 200);
    const message = `Failed to parse CDK-NAG output as JSON: ${
      parseError instanceof Error ? parseError.message : String(parseError)
    }. Output preview: ${preview}`;
    channel.error(message);
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }

  if (findings.length > 0) {
    const diagnostics = await mapFindingsToSourceLocations(document, findings);
    diagnosticCollection.set(document.uri, diagnostics);
    channel.info(`Set ${diagnostics.length} diagnostic(s) on ${document.fileName}`);
  } else {
    diagnosticCollection.delete(document.uri);
    channel.info('No CDK-NAG findings');
  }
}

// Validate the entire workspace
async function validateWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const channel = getOutputChannel();
  channel.info(`Running CDK-NAG validation for workspace: ${workspaceFolder.uri.fsPath}`);
  const output = await runCdkNag(workspaceFolder.uri.fsPath);

  let findings: Array<{
    id: string;
    name: string;
    description: string;
    level: string;
    resourceId: string;
  }>;
  try {
    findings = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Failed to parse CDK-NAG output: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (findings.length > 0) {
    const files = await vscode.workspace.findFiles('**/*.ts');
    for (const file of files) {
      const document = await vscode.workspace.openTextDocument(file);
      const diagnostics = await mapFindingsToSourceLocations(document, findings);
      if (diagnostics.length > 0) {
        diagnosticCollection.set(document.uri, diagnostics);
      }
    }

    const errorCount = findings.filter(f => f.level === 'ERROR').length;
    const warningCount = findings.filter(f => f.level === 'WARNING').length;
    const infoCount = findings.filter(f => f.level === 'INFO').length;

    let message = `Found ${findings.length} CDK-NAG issues:`;
    if (errorCount > 0) message += ` ${errorCount} errors`;
    if (warningCount > 0) message += ` ${warningCount} warnings`;
    if (infoCount > 0) message += ` ${infoCount} info`;

    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage('No CDK-NAG issues found');
  }
}

// ── Activation ───────────────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = getOutputChannel();
  channel.info('CDK NAG Validator activating…');

  // Ensure the OutputChannel is disposed when the extension deactivates.
  context.subscriptions.push({ dispose: disposeOutputChannel });

  // Initialise the DiagnosticCollection.
  diagnosticCollection = vscode.languages.createDiagnosticCollection('cdk-nag');
  context.subscriptions.push(diagnosticCollection);

  // One-shot migration of legacy `cdk-nag-validator.*` settings.
  try {
    await migrateLegacyConfig();
  } catch (err) {
    channel.warn(
      `Legacy config migration failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Register the three user-facing commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('cdk-nag-validator.validate', async () => {
      channel.info('CDK-NAG validate command triggered');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showErrorMessage('No active editor found');
        return;
      }
      try {
        await validateFile(editor.document);
      } catch (error) {
        channel.error(
          `Error during validation: ${error instanceof Error ? error.message : String(error)}`
        );
        void vscode.window.showErrorMessage(
          `Validation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cdk-nag-validator.validateWorkspace', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage('No workspace folder found');
        return;
      }
      try {
        await validateWorkspace(workspaceFolder);
      } catch (error) {
        channel.error(
          `Error during workspace validation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        void vscode.window.showErrorMessage(
          `Workspace validation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cdk-nag-validator.configureRules', async () => {
      try {
        await ConfigManager.configureRules(context);
      } catch (error) {
        channel.error(
          `Error configuring rules: ${error instanceof Error ? error.message : String(error)}`
        );
        void vscode.window.showErrorMessage(
          `Failed to configure rules: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  // Clear diagnostics when the user starts editing — they're no longer valid
  // for the unsaved version of the document. A save listener that re-runs
  // validation lands in PR 3a (see BACKLOG M1).
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      diagnosticCollection.delete(event.document.uri);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      diagnosticCollection.delete(document.uri);
    })
  );

  channel.info('CDK NAG Validator activated');
}

export function deactivate(): void {
  // DiagnosticCollection and OutputChannel are both registered as context
  // subscriptions, so VS Code disposes them automatically. Nothing to do here.
}
