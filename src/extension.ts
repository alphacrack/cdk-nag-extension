import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from './configManager';

const execAsync = promisify(exec);

// Create a diagnostic collection
let diagnosticCollection: vscode.DiagnosticCollection;

// Define available rule packs
const AVAILABLE_RULE_PACKS = [
  'AwsSolutionsChecks',
  'HIPAA.SecurityChecks',
  'NIST.800-53.R4Checks',
  'NIST.800-53.R5Checks',
  'PCI.DSS.321Checks',
  'ServerlessChecks',
];

// Define common fixes for known issues
const COMMON_FIXES: { [key: string]: string } = {
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

// Get configured rule packs from settings
function getConfiguredRulePacks(): string[] {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  const enabledPacks = config.get<string[]>('enabledRulePacks', ['AwsSolutionsChecks']);
  return enabledPacks.filter(pack => AVAILABLE_RULE_PACKS.includes(pack));
}

// Get custom rules from settings
function getCustomRules(): any[] {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<any[]>('customRules', []);
}

// Get inline suggestions setting
function shouldShowInlineSuggestions(): boolean {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<boolean>('showInlineSuggestions', true);
}

// Get auto-validate setting
function shouldAutoValidate(): boolean {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<boolean>('autoValidate', true);
}

// Get auto-install setting (opt-in, defaults to false for safety)
function shouldAutoInstall(): boolean {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');
  return config.get<boolean>('autoInstall', false);
}

/**
 * Spawn the compiled cdkNagRunner as a child process.
 *
 * All user-controlled data (template path, custom rule objects) is serialised
 * to a temporary JSON file and passed to the runner as a file-system path.
 * Nothing is ever interpolated into a shell string, eliminating the
 * shell-injection vulnerability that existed in the previous node -e approach.
 *
 * Custom rule conditions are evaluated inside the runner using
 * vm.runInNewContext with a sandboxed context — see src/cdkNagRunner.ts.
 */
async function spawnRunner(inputPath: string, workspacePath: string): Promise<string> {
  // The runner script lives next to this file once compiled.
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
        // Warnings from the runner are non-fatal — log but continue.
        console.warn('CDK-NAG runner warnings:', stderr);
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    child.on('error', err => reject(err));
  });
}

// Run CDK-NAG with configured rule packs and custom rules
async function runCdkNag(workspacePath: string): Promise<string> {
  const rulePacks = getConfiguredRulePacks();
  const customRules = getCustomRules();

  if (rulePacks.length === 0 && customRules.length === 0) {
    throw new Error(
      'No rule packs or custom rules configured. Please enable at least one rule pack or add custom rules in settings.'
    );
  }

  console.log('Running CDK-NAG with rule packs:', rulePacks);
  if (customRules.length > 0) {
    console.log('Running with custom rules:', customRules);
  }

  // ── Optional dependency installation (opt-in via cdkNagValidator.autoInstall) ──
  // Auto-running `npm install` in a user's project on every validation is
  // invasive and can break lock-files or trigger unexpected side effects.
  // It is therefore disabled by default; the user must explicitly enable it
  // in settings ("cdkNagValidator.autoInstall": true).
  if (shouldAutoInstall()) {
    try {
      console.log('autoInstall is enabled — installing workspace dependencies...');
      await execAsync('npm install aws-cdk aws-cdk-lib cdk-nag yaml --save-dev', {
        cwd: workspacePath,
      });
      console.log('Dependencies installed successfully');
    } catch (error) {
      console.error('Error installing dependencies:', error);
      throw new Error(
        `Failed to install required dependencies: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    console.log(
      'autoInstall is disabled (default). Enable "cdkNagValidator.autoInstall" in settings to auto-install dependencies.'
    );
  }

  // Synthesise the CDK template
  const { stdout: synthOutput, stderr: synthError } = await execAsync('cdk synth --no-staging', {
    cwd: workspacePath,
  });
  if (synthError) {
    console.error('CDK synth error:', synthError);
    throw new Error(`CDK synthesis failed: ${synthError}`);
  }
  console.log('CDK synthesis completed successfully');

  // Write synthesised template to a temp file (path never leaves this process
  // as part of a shell string — it is only passed to the runner via JSON).
  const tempDir = path.join(workspacePath, '.cdk-nag-temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
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
    // Always clean up, even on failure
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('CDK-NAG output:', stdout);
  return stdout;
}

// Configure CDK-NAG rules
async function configureRules() {
  const config = vscode.workspace.getConfiguration('cdkNagValidator');

  // Show quick pick for rule packs
  const selectedPacks = await vscode.window.showQuickPick(AVAILABLE_RULE_PACKS, {
    canPickMany: true,
    placeHolder: 'Select CDK-NAG rule packs to enable',
  });

  if (selectedPacks) {
    await config.update('enabledRulePacks', selectedPacks, vscode.ConfigurationTarget.Global);
  }

  // Show input box for custom rules
  const addCustomRule = await vscode.window.showQuickPick(['Yes', 'No'], {
    placeHolder: 'Would you like to add a custom rule?',
  });

  if (addCustomRule === 'Yes') {
    const customRules = config.get<any[]>('customRules', []);

    const id = await vscode.window.showInputBox({
      prompt: 'Enter a unique identifier for the rule',
      placeHolder: 'e.g., S3_BUCKET_ENCRYPTION',
    });

    if (!id) return;

    const name = await vscode.window.showInputBox({
      prompt: 'Enter a name for the rule',
      placeHolder: 'e.g., S3 Bucket Encryption Required',
    });

    if (!name) return;

    const description = await vscode.window.showInputBox({
      prompt: 'Enter a description for the rule',
      placeHolder: 'e.g., S3 buckets must have encryption enabled',
    });

    if (!description) return;

    const level = await vscode.window.showQuickPick(['ERROR', 'WARNING', 'INFO'], {
      placeHolder: 'Select the severity level',
    });

    if (!level) return;

    const resourceTypes = await vscode.window.showInputBox({
      prompt: 'Enter AWS resource types (comma-separated)',
      placeHolder: 'e.g., AWS::S3::Bucket, AWS::DynamoDB::Table',
    });

    if (!resourceTypes) return;

    const condition = await vscode.window.showInputBox({
      prompt: 'Enter the condition to check (JavaScript)',
      placeHolder: 'e.g., !resource.Properties.Encryption',
    });

    if (!condition) return;

    customRules.push({
      id,
      name,
      description,
      level,
      resourceTypes: resourceTypes.split(',').map(t => t.trim()),
      condition,
    });

    await config.update('customRules', customRules, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Custom rule added successfully');
  }
}

// Install cdk-nag in the project
async function installCdkNag(workspacePath: string): Promise<boolean> {
  try {
    console.log('Installing cdk-nag...');

    // First try to install globally
    try {
      await execAsync('npm install -g cdk-nag');
      console.log('Installed cdk-nag globally');
      return true;
    } catch (globalError) {
      console.log('Global installation failed, trying local installation...');
    }

    // If global installation fails, try local installation
    try {
      await execAsync('npm install cdk-nag --save-dev', { cwd: workspacePath });
      console.log('Installed cdk-nag locally');
      return true;
    } catch (localError) {
      console.error('Local installation failed:', localError);
      throw new Error('Failed to install cdk-nag both globally and locally');
    }
  } catch (error) {
    console.error('Error installing cdk-nag:', error);
    vscode.window.showErrorMessage(
      `Failed to install CDK-NAG: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

// Check if CDK project has cdk-nag dependency
async function checkCdkNagDependency(workspacePath: string): Promise<boolean> {
  try {
    // Check package.json for cdk-nag dependency
    const packageJsonPath = path.join(workspacePath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      if (dependencies['cdk-nag']) {
        console.log('Found cdk-nag dependency in package.json');
        return true;
      }
    }

    // Check requirements.txt for Python projects
    const requirementsPath = path.join(workspacePath, 'requirements.txt');
    if (fs.existsSync(requirementsPath)) {
      const requirements = fs.readFileSync(requirementsPath, 'utf8');
      if (requirements.includes('cdk-nag')) {
        console.log('Found cdk-nag dependency in requirements.txt');
        return true;
      }
    }

    // If not found, try to install it
    console.log('cdk-nag not found, attempting to install...');
    return await installCdkNag(workspacePath);
  } catch (error) {
    console.error('Error checking cdk-nag dependency:', error);
    return false;
  }
}

// Check and install AWS CDK
async function checkAndInstallAwsCdk(workspacePath: string): Promise<boolean> {
  try {
    console.log('Checking AWS CDK installation...');

    // First check if CDK is installed
    try {
      const { stdout } = await execAsync('cdk --version');
      console.log('AWS CDK is already installed:', stdout);
      return true;
    } catch (error) {
      console.log('AWS CDK not found, installing...');
    }

    // Install specific version of AWS CDK globally
    try {
      // Using version 2.1018.0
      await execAsync('npm install -g aws-cdk@2.1018.0');
      console.log('Installed AWS CDK version 2.1018.0 globally');
      return true;
    } catch (error) {
      console.error('Failed to install AWS CDK globally:', error);

      // Try local installation as fallback
      try {
        await execAsync('npm install aws-cdk@2.1018.0 --save-dev', { cwd: workspacePath });
        console.log('Installed AWS CDK version 2.1018.0 locally');
        return true;
      } catch (localError) {
        console.error('Failed to install AWS CDK locally:', localError);
        throw new Error('Failed to install AWS CDK both globally and locally');
      }
    }
  } catch (error) {
    console.error('Error in checkAndInstallAwsCdk:', error);
    vscode.window.showErrorMessage(
      `Failed to install AWS CDK: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

// Check Node.js version compatibility
async function checkNodeVersion(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('node --version');
    const version = stdout.trim().replace('v', '');
    const majorVersion = parseInt(version.split('.')[1]);

    // AWS CDK 2.1018.0 supports Node.js 14.x, 16.x, 18.x, 20.x, and 22.x
    const supportedVersions = [14, 16, 18, 20, 22];

    if (!supportedVersions.includes(majorVersion)) {
      const message = `Warning: You are using Node.js ${version}. AWS CDK 2.1018.0 is tested with Node.js 14.x, 16.x, 18.x, 20.x, and 22.x. You may encounter compatibility issues.`;
      vscode.window.showWarningMessage(message);
      console.warn(message);
      // Return true to allow the extension to continue with a warning
      return true;
    }

    return true;
  } catch (error) {
    console.error('Error checking Node.js version:', error);
    return false;
  }
}

// Map CDK-NAG findings to source code locations with inline suggestions
async function mapFindingsToSourceLocations(
  document: vscode.TextDocument,
  findings: any[]
): Promise<vscode.Diagnostic[]> {
  console.log('Mapping findings to source locations...');
  const diagnostics: vscode.Diagnostic[] = [];
  const documentText = document.getText();

  // Debug: Print first 500 characters of the document
  console.log('Document preview:', documentText.substring(0, 500));
  console.log('Document length:', documentText.length);

  // Create a map of resource definitions with their configurations
  const resourceDefinitions = new Map<
    string,
    { range: vscode.Range; config: string; type: string }
  >();

  // First try a simpler approach to find any resource definitions
  console.log('\nTrying simple resource detection...');
  const simpleRegex = /new\s+([\w.]+)\s*\(/g;
  let simpleMatch;
  while ((simpleMatch = simpleRegex.exec(documentText)) !== null) {
    const line = documentText.substring(0, simpleMatch.index).split('\n').length;
    console.log(`Found potential resource at line ${line}: ${simpleMatch[0]}`);
  }

  // Now try the full resource detection
  console.log('\nTrying full resource detection...');
  const resourceRegex = /new\s+([\w.]+)\s*\(\s*this\s*,\s*['"]([^'"]+)['"]\s*,\s*({[^}]+})/g;
  let match;

  while ((match = resourceRegex.exec(documentText)) !== null) {
    const resourceType = match[1];
    const resourceId = match[2];
    const config = match[3];
    const startPos = document.positionAt(match.index);
    const endPos = document.positionAt(match.index + match[0].length);

    console.log(`Found resource at line ${startPos.line + 1}:`);
    console.log(`  Type: ${resourceType}`);
    console.log(`  ID: ${resourceId}`);
    console.log(`  Config: ${config}`);

    resourceDefinitions.set(resourceId, {
      range: new vscode.Range(startPos, endPos),
      config,
      type: resourceType,
    });
  }

  const foundResources = Array.from(resourceDefinitions.entries()).map(
    ([id, def]) => `${def.type}:${id}`
  );
  console.log('\nFound resources:', foundResources);
  console.log('Total resources found:', foundResources.length);

  // Process each finding
  for (const finding of findings) {
    console.log('\nProcessing finding:', finding);
    const baseResourceId = finding.resourceId.replace(/\d+[A-F0-9]+$/, '');
    console.log('Base resource ID:', baseResourceId);
    console.log('Original resource ID:', finding.resourceId);

    // Find all matching resource definitions
    let foundMatch = false;
    for (const [resourceId, resourceDef] of resourceDefinitions.entries()) {
      console.log(`\nChecking resource: ${resourceDef.type}:${resourceId}`);
      console.log(`Against base ID: ${baseResourceId}`);

      // Check if the resource ID is a prefix of the finding's resource ID
      if (finding.resourceId.startsWith(resourceId)) {
        foundMatch = true;
        console.log('Found matching resource:', resourceId);

        // For S3 bucket encryption findings, check if encryption is actually enabled
        if (finding.id === 'S3_BUCKET_ENCRYPTION' && resourceDef.type.includes('Bucket')) {
          const config = resourceDef.config;
          console.log(`Bucket ${resourceId} config:`, config);

          const hasEncryption =
            config.includes('encryption:') ||
            config.includes('serverSideEncryptionConfiguration:') ||
            config.includes('encryptionConfiguration:');

          console.log(`Bucket ${resourceId} has encryption:`, hasEncryption);

          if (!hasEncryption) {
            console.log('Creating diagnostic for unencrypted bucket:', resourceId);
            const diagnostic = new vscode.Diagnostic(
              resourceDef.range,
              `${finding.name}: ${finding.description}`,
              vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'CDK-NAG';
            diagnostic.code = finding.id;
            diagnostics.push(diagnostic);
          } else {
            console.log('Skipping encrypted bucket:', resourceId);
          }
        } else {
          // For other findings, create diagnostic as usual
          const diagnostic = new vscode.Diagnostic(
            resourceDef.range,
            `${finding.name}: ${finding.description}`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.source = 'CDK-NAG';
          diagnostic.code = finding.id;
          diagnostics.push(diagnostic);
        }
      }
    }

    if (!foundMatch) {
      console.log('No matching resource found for:', baseResourceId);
    }
  }

  console.log('\nFinal diagnostics:', diagnostics);
  return diagnostics;
}

// Validate a file
async function validateFile(document: vscode.TextDocument): Promise<void> {
  console.log('Starting file validation...');

  // Get the workspace folder
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    throw new Error('No workspace folder found');
  }

  console.log('Workspace folder:', workspaceFolder.uri.fsPath);

  // Run CDK-NAG
  const output = await runCdkNag(workspaceFolder.uri.fsPath);
  console.log('CDK-NAG output:', output);

  // Parse the output
  const findings = JSON.parse(output);
  console.log('Parsed findings:', findings);

  if (findings.length > 0) {
    // Map findings to source locations
    const diagnostics = await mapFindingsToSourceLocations(document, findings);
    console.log('Created diagnostics:', diagnostics);

    // Set the diagnostics
    diagnosticCollection.set(document.uri, diagnostics);
  } else {
    // Clear any existing diagnostics
    diagnosticCollection.delete(document.uri);
  }
}

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext) {
  console.log('CDK-NAG extension is now active!');

  // Initialize diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('cdk-nag');
  context.subscriptions.push(diagnosticCollection);

  // Register the validate command
  const disposable = vscode.commands.registerCommand('cdk-nag-validator.validate', async () => {
    console.log('CDK-NAG validate command triggered');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      console.log('No active editor found');
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    console.log('Active editor:', editor.document.fileName);
    console.log('Document language:', editor.document.languageId);

    const document = editor.document;
    console.log('Document URI:', document.uri.toString());
    console.log('Document is dirty:', document.isDirty);
    console.log('Document is closed:', document.isClosed);

    const documentText = document.getText();
    console.log('Document length:', documentText.length);
    console.log('First 100 characters:', documentText.substring(0, 100));

    try {
      await validateFile(document);
    } catch (error) {
      console.error('Error during validation:', error);
      vscode.window.showErrorMessage(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Register the validate workspace command
  const validateWorkspaceCommand = vscode.commands.registerCommand(
    'cdk-nag-validator.validateWorkspace',
    async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
      }

      try {
        await validateWorkspace(workspaceFolder);
      } catch (error) {
        console.error('Error during workspace validation:', error);
        vscode.window.showErrorMessage(
          `Workspace validation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Register the configure rules command
  const configureRulesCommand = vscode.commands.registerCommand('cdk-nag-validator.configureRules', () => {
    ConfigManager.configureRules(context);
  });

  // Add commands to the extension context
  context.subscriptions.push(disposable);
  context.subscriptions.push(validateWorkspaceCommand);
  context.subscriptions.push(configureRulesCommand);

  // Register a document change listener to clear diagnostics when the document changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      diagnosticCollection.delete(event.document.uri);
    })
  );

  // Register a document close listener to clear diagnostics when the document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      diagnosticCollection.delete(document.uri);
    })
  );
}

function shouldValidateFile(document: vscode.TextDocument): boolean {
  // Check if the file is a TypeScript or JavaScript file
  if (document.languageId !== 'typescript' && document.languageId !== 'javascript') {
    return false;
  }

  // Get the file path
  const filePath = document.fileName;
  console.log('Checking file for validation:', filePath);

  // Check if the file is in a CDK project
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    console.log('No workspace folder found for file');
    return false;
  }

  // Check for CDK project indicators
  const cdkJsonPath = path.join(workspaceFolder.uri.fsPath, 'cdk.json');
  const packageJsonPath = path.join(workspaceFolder.uri.fsPath, 'package.json');

  const hasCdkJson = fs.existsSync(cdkJsonPath);
  const hasPackageJson = fs.existsSync(packageJsonPath);

  if (!hasCdkJson && !hasPackageJson) {
    console.log('No CDK project indicators found');
    return false;
  }

  // If package.json exists, check for CDK dependencies
  if (hasPackageJson) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      const hasCdkDependency = dependencies['aws-cdk-lib'] || dependencies['@aws-cdk/core'];
      if (!hasCdkDependency) {
        console.log('No CDK dependencies found in package.json');
        return false;
      }
    } catch (error) {
      console.error('Error reading package.json:', error);
      return false;
    }
  }

  // Check if the file contains CDK imports
  const content = document.getText();
  const hasCdkImports =
    content.includes('aws-cdk-lib') ||
    content.includes('@aws-cdk/core') ||
    content.includes('cdk-nag');

  console.log('File validation check results:', {
    hasCdkJson,
    hasPackageJson,
    hasCdkImports,
  });

  return hasCdkImports;
}

async function validateCurrentFile() {
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      console.log('Validating current file:', editor.document.fileName);
      await validateFile(editor.document);
    } else {
      console.log('No active editor found');
    }
  } catch (error) {
    console.error('Error in validateCurrentFile:', error);
    vscode.window.showErrorMessage(
      `Error validating current file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Validate the entire workspace
async function validateWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
  try {
    console.log('Running CDK-NAG validation for workspace:', workspaceFolder.uri.fsPath);
    const output = await runCdkNag(workspaceFolder.uri.fsPath);

    try {
      const findings = JSON.parse(output);
      console.log('CDK-NAG findings:', findings);

      if (findings.length > 0) {
        // Process each finding for all TypeScript files in the workspace
        const files = await vscode.workspace.findFiles('**/*.ts');
        for (const file of files) {
          const document = await vscode.workspace.openTextDocument(file);
          const diagnostics = await mapFindingsToSourceLocations(document, findings);
          if (diagnostics.length > 0) {
            diagnosticCollection.set(document.uri, diagnostics);
          }
        }

        // Show a summary message
        const errorCount = findings.filter(f => f.level === 'ERROR').length;
        const warningCount = findings.filter(f => f.level === 'WARNING').length;
        const infoCount = findings.filter(f => f.level === 'INFO').length;

        let message = `Found ${findings.length} CDK-NAG issues:`;
        if (errorCount > 0) message += ` ${errorCount} errors`;
        if (warningCount > 0) message += ` ${warningCount} warnings`;
        if (infoCount > 0) message += ` ${infoCount} info`;

        vscode.window.showWarningMessage(message);
      } else {
        vscode.window.showInformationMessage('No CDK-NAG issues found');
      }
    } catch (error) {
      console.error('Error parsing CDK-NAG output:', error);
      throw new Error(
        `Failed to parse CDK-NAG output: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } catch (error) {
    console.error('Error validating workspace:', error);
    throw error;
  }
}

export function deactivate() {
  console.log('CDK NAG Validator is deactivating...');
  if (diagnosticCollection) {
    diagnosticCollection.dispose();
  }
}

async function validateCdkCode(document: vscode.TextDocument): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace folder found');
    return;
  }

  const config = await ConfigManager.getConfig(workspaceRoot);
  const cdkNagPackage = config.cdkNagPackage;

  try {
    // Check if the configured package is available in the project
    const hasProjectCdkNag = await ConfigManager.checkProjectCdkNag(workspaceRoot, cdkNagPackage.name);
    
    // Use project's CDK-NAG if available and configured to do so
    const packageToUse = hasProjectCdkNag && config.useProjectCdkNag 
      ? cdkNagPackage.name 
      : 'cdk-nag'; // Fall back to default if not found or not configured to use project's

    // Run CDK-NAG validation
    const { stdout } = await execAsync(`npx ${packageToUse} --format json`, {
      cwd: workspaceRoot
    });

    // Process the validation results
    const results = JSON.parse(stdout);
    // ... rest of the validation logic ...
  } catch (error) {
    vscode.window.showErrorMessage(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
