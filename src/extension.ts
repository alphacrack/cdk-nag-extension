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
import { createSaveListener } from './saveListener';
import { parseResourceDefinitions } from './resourceParser';
import {
  CdkNagCodeActionProvider,
  CDK_NAG_DIAGNOSTIC_SOURCE,
  SUPPRESS_COMMAND_ID,
} from './providers/codeActionProvider';
import { CdkNagHoverProvider } from './providers/hoverProvider';
import { createCdkNagChatParticipant } from './chat/participant';

const execAsync = promisify(exec);

/** Thrown when the user cancels a validation via the progress notification. */
class ValidationCancelledError extends Error {
  constructor() {
    super('Validation cancelled by user');
    this.name = 'ValidationCancelledError';
  }
}

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

// Remediation hints + rule documentation now live in `src/ruleDocs.ts`,
// keyed by the actual cdk-nag rule IDs (e.g. `AwsSolutions-S1`). The old
// made-up-category table never matched real diagnostic.code values, so
// quick-fixes were silently unreachable. See `lookupRuleDoc` / `lookupRuleFix`.

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
//
// If `token` is provided and fires cancellation, the child process is killed
// with SIGTERM and the promise rejects with a ValidationCancelledError.
export async function spawnRunner(
  inputPath: string,
  workspacePath: string,
  token?: vscode.CancellationToken
): Promise<string> {
  const channel = getOutputChannel();
  const runnerScript = path.join(__dirname, 'cdkNagRunner.js');

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let cancelled = false;

    // Use spawn (not exec/execAsync) so that NO shell is involved.
    // argv[2] is the path to the JSON input file — a plain file-system path,
    // not user-supplied data interpolated into a command string.
    const child = spawn(process.execPath, [runnerScript, inputPath], {
      cwd: workspacePath,
      shell: false, // explicit — never invoke a shell
    });

    const cancelSub = token?.onCancellationRequested(() => {
      cancelled = true;
      channel.warn('Validation cancelled — sending SIGTERM to runner');
      // SIGTERM gives the runner a chance to clean up; if it ignores, the
      // 'close' handler below still resolves the promise.
      try {
        child.kill('SIGTERM');
      } catch (err) {
        channel.warn(
          `Failed to kill runner process: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('close', code => {
      cancelSub?.dispose();
      if (cancelled) {
        reject(new ValidationCancelledError());
        return;
      }
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

    child.on('error', err => {
      cancelSub?.dispose();
      reject(err);
    });
  });
}

// Run CDK-NAG with configured rule packs and custom rules.
//
// `progress` — if supplied, receives pack-by-pack report() updates so the
// notification surface can show what stage the validation is at.
// `token`    — if supplied, kills the runner child process on cancel. The
// async fs operations in this function check the token at awaitable points
// so we can abort between steps rather than only at the runner step.
async function runCdkNag(
  workspacePath: string,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken
): Promise<string> {
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

  if (token?.isCancellationRequested) {
    throw new ValidationCancelledError();
  }

  // ── Optional dependency installation (opt-in via cdkNagValidator.autoInstall) ──
  // Auto-running `npm install` in a user's project on every validation is
  // invasive and can break lock-files or trigger unexpected side effects.
  // It is therefore disabled by default; the user must explicitly enable it
  // in settings ("cdkNagValidator.autoInstall": true).
  if (shouldAutoInstall()) {
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

  // Synthesise the CDK template
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

  // Write synthesised template to a temp file. Use a unique per-invocation
  // directory so concurrent validations do not race on the same files.
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cdk-nag-'));
  const templatePath = path.join(tempDir, 'template.yaml');
  await fs.promises.writeFile(templatePath, synthOutput);

  // Read workspace-level suppressions so the runner can filter findings
  // before emitting them. Never throws — missing/empty is the happy path.
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

  // Build the structured input for the runner — pure JSON, no shell escaping.
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
    // Always clean up, even on failure or cancellation.
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(err => {
      channel.warn(
        `Failed to clean up temp dir ${tempDir}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  channel.debug(`CDK-NAG output: ${stdout}`);
  return stdout;
}

// ── Finding → source-location mapping ───────────────────────────────────────
// Uses `parseResourceDefinitions` (multi-line, nested-brace aware) to locate
// `new TypeName(this, 'id'[, {...}])` constructs and attach each finding's
// message to the matching construct. Constructs with no options object are
// also matched so e.g. `new Bucket(this, 'UnencryptedBucket')` still gets a
// diagnostic rather than being silently dropped.
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

  // Resource ids can repeat in practice (e.g. "Role" across multiple stacks
  // in one file), so store a list per id and attach each matching finding.
  const resourceDefinitions = new Map<
    string,
    Array<{ range: vscode.Range; config: string | null; type: string }>
  >();

  for (const def of parseResourceDefinitions(documentText)) {
    const range = new vscode.Range(document.positionAt(def.start), document.positionAt(def.end));
    const existing = resourceDefinitions.get(def.id) ?? [];
    existing.push({ range, config: def.config, type: def.type });
    resourceDefinitions.set(def.id, existing);
  }

  channel.debug(`Found ${resourceDefinitions.size} unique resource id(s) in ${document.fileName}`);

  for (const finding of findings) {
    let foundMatch = false;
    for (const [resourceId, defs] of resourceDefinitions.entries()) {
      // cdk-nag sometimes appends a hash to the resource id, so match by prefix.
      if (!finding.resourceId.startsWith(resourceId)) continue;
      foundMatch = true;

      for (const resourceDef of defs) {
        // False-positive guard: S3 encryption findings on a construct whose
        // options already have an encryption key. We only have confidence in
        // this check when a config was actually parsed; skip otherwise.
        if (
          /S3Bucket.*Encryption/i.test(finding.id) &&
          resourceDef.type.includes('Bucket') &&
          resourceDef.config &&
          (resourceDef.config.includes('encryption:') ||
            resourceDef.config.includes('serverSideEncryptionConfiguration:') ||
            resourceDef.config.includes('encryptionConfiguration:'))
        ) {
          channel.debug(`Skipping already-encrypted bucket: ${resourceId}`);
          continue;
        }

        const diagnostic = new vscode.Diagnostic(
          resourceDef.range,
          `${finding.name}: ${finding.description}`,
          diagnosticSeverity(finding.level)
        );
        diagnostic.source = CDK_NAG_DIAGNOSTIC_SOURCE;
        diagnostic.code = finding.id;
        diagnostics.push(diagnostic);
      }
    }

    if (!foundMatch) {
      channel.debug(`No matching resource in source for finding: ${finding.resourceId}`);
    }
  }

  return diagnostics;
}

function diagnosticSeverity(level: string): vscode.DiagnosticSeverity {
  switch (level.toUpperCase()) {
    case 'ERROR':
      return vscode.DiagnosticSeverity.Error;
    case 'WARNING':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

// Validate a file
async function validateFile(
  document: vscode.TextDocument,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken
): Promise<void> {
  const channel = getOutputChannel();
  channel.info(`Starting file validation: ${document.fileName}`);

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    throw new Error('No workspace folder found');
  }

  const output = await runCdkNag(workspaceFolder.uri.fsPath, progress, token);

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
async function validateWorkspace(
  workspaceFolder: vscode.WorkspaceFolder,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken
): Promise<void> {
  const channel = getOutputChannel();
  channel.info(`Running CDK-NAG validation for workspace: ${workspaceFolder.uri.fsPath}`);
  const output = await runCdkNag(workspaceFolder.uri.fsPath, progress, token);

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

// ── Progress + cancellation wrapper ─────────────────────────────────────────
// Every validation entry-point (command, save listener) funnels through this
// so the user always sees a notification with a cancel button. Cancellation
// throws ValidationCancelledError, which we swallow silently — the user asked
// to stop, not to see an error.
async function runValidationWithProgress(
  title: string,
  task: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) => Promise<void>,
  failureContext: string
): Promise<void> {
  const channel = getOutputChannel();
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, token) => {
        await task(progress, token);
      }
    );
  } catch (error) {
    if (error instanceof ValidationCancelledError) {
      channel.info(`${failureContext} cancelled by user`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    channel.error(`Error during ${failureContext}: ${message}`);
    void vscode.window.showErrorMessage(`${failureContext} failed: ${message}`);
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
      await runValidationWithProgress(
        'CDK NAG: Validating current file…',
        (progress, token) => validateFile(editor.document, progress, token),
        'validation'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cdk-nag-validator.validateWorkspace', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage('No workspace folder found');
        return;
      }
      await runValidationWithProgress(
        'CDK NAG: Validating workspace…',
        (progress, token) => validateWorkspace(workspaceFolder, progress, token),
        'workspace validation'
      );
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

  // Suppress-finding command — invoked from the CodeActionProvider's
  // "Suppress this finding" quick-fix. Writes the rule ID to
  // `.vscode/cdk-nag-config.json` so the runner filters it on future runs.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      SUPPRESS_COMMAND_ID,
      async (payload?: { ruleId?: string; uri?: string; message?: string }) => {
        try {
          const ruleId = payload?.ruleId;
          if (!ruleId) {
            void vscode.window.showErrorMessage('CDK NAG: missing rule id — cannot suppress.');
            return;
          }
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            void vscode.window.showErrorMessage(
              'CDK NAG: no workspace folder — cannot persist suppression.'
            );
            return;
          }
          const added = await ConfigManager.addSuppression(workspaceFolder.uri.fsPath, ruleId);
          if (added) {
            channel.info(`Suppressed rule ${ruleId} for ${workspaceFolder.name}`);
            void vscode.window.showInformationMessage(
              `CDK NAG: suppressed "${ruleId}" for this workspace. Remove it from .vscode/cdk-nag-config.json to re-enable.`
            );
            // Drop the diagnostic immediately from the current document so the
            // user sees the effect without re-running validation.
            if (payload?.uri) {
              try {
                const uri = vscode.Uri.parse(payload.uri);
                const remaining = vscode.languages
                  .getDiagnostics(uri)
                  .filter(d => !(d.source === CDK_NAG_DIAGNOSTIC_SOURCE && d.code === ruleId));
                diagnosticCollection.set(uri, remaining);
              } catch {
                // Non-fatal — next validation run will pick up the change.
              }
            }
          } else {
            void vscode.window.showInformationMessage(
              `CDK NAG: "${ruleId}" was already suppressed.`
            );
          }
        } catch (err) {
          channel.error(
            `Failed to suppress finding: ${err instanceof Error ? err.message : String(err)}`
          );
          void vscode.window.showErrorMessage(
            `CDK NAG: failed to suppress finding: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    )
  );

  // Register CodeAction + Hover providers for TS/JS. The providers are
  // stateless, so a single instance of each is reused across documents.
  const codeActionProvider = new CdkNagCodeActionProvider();
  const hoverProvider = new CdkNagHoverProvider();
  for (const language of ['typescript', 'javascript']) {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider({ language }, codeActionProvider, {
        providedCodeActionKinds: CdkNagCodeActionProvider.providedCodeActionKinds,
      })
    );
    context.subscriptions.push(vscode.languages.registerHoverProvider({ language }, hoverProvider));
  }

  // Clear diagnostics when the user starts editing — they're no longer valid
  // for the unsaved version of the document.
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

  // Auto-validate on save — gated by cdkNagValidator.autoValidate (default
  // true). Debounces per-URI so rapid "Save All" or format-on-save loops
  // coalesce into a single validation run.
  context.subscriptions.push(
    createSaveListener({
      shouldAutoValidate,
      validate: document =>
        runValidationWithProgress(
          `CDK NAG: Validating ${path.basename(document.fileName)}…`,
          (progress, token) => validateFile(document, progress, token),
          'auto-validate on save'
        ),
      log: {
        info: msg => channel.info(msg),
        warn: msg => channel.warn(msg),
        error: msg => channel.error(msg),
      },
    })
  );

  // Register the @cdk-nag Copilot Chat participant. Returns undefined on
  // hosts without the chat API (older VS Code, non-Copilot forks), in which
  // case we skip registration silently so the rest of the extension keeps
  // working.
  try {
    const chatDisposable = createCdkNagChatParticipant();
    if (chatDisposable) {
      context.subscriptions.push(chatDisposable);
      channel.info('Registered @cdk-nag chat participant');
    } else {
      channel.info(
        'Chat API not available on this host — skipping @cdk-nag participant registration'
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channel.warn(`Failed to register @cdk-nag chat participant: ${msg}`);
  }

  channel.info('CDK NAG Validator activated');
}

export function deactivate(): void {
  // DiagnosticCollection and OutputChannel are both registered as context
  // subscriptions, so VS Code disposes them automatically. Nothing to do here.
}
