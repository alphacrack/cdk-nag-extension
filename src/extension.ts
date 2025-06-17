import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

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
    'ServerlessChecks'
];

// Define common fixes for known issues
const COMMON_FIXES: { [key: string]: string } = {
    'S3_BUCKET_ENCRYPTION': 'Add encryption configuration: new s3.Bucket(this, "Bucket", { encryption: s3.BucketEncryption.S3_MANAGED })',
    'S3_BUCKET_VERSIONING': 'Enable versioning: new s3.Bucket(this, "Bucket", { versioned: true })',
    'S3_BUCKET_LOGGING': 'Enable access logging: new s3.Bucket(this, "Bucket", { serverAccessLogsBucket: loggingBucket })',
    'DYNAMODB_TABLE_ENCRYPTION': 'Enable encryption: new dynamodb.Table(this, "Table", { encryption: dynamodb.TableEncryption.AWS_MANAGED })',
    'LAMBDA_FUNCTION_LOGGING': 'Enable logging: new lambda.Function(this, "Function", { logRetention: logs.RetentionDays.ONE_WEEK })',
    'API_GATEWAY_LOGGING': 'Enable logging: new apigateway.RestApi(this, "Api", { deployOptions: { loggingLevel: apigateway.MethodLoggingLevel.INFO } })'
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

// Run CDK-NAG with configured rule packs and custom rules
async function runCdkNag(workspacePath: string): Promise<string> {
    const rulePacks = getConfiguredRulePacks();
    const customRules = getCustomRules();
    
    if (rulePacks.length === 0 && customRules.length === 0) {
        throw new Error('No rule packs or custom rules configured. Please enable at least one rule pack or add custom rules in settings.');
    }

    console.log('Running CDK-NAG with rule packs:', rulePacks);
    if (customRules.length > 0) {
        console.log('Running with custom rules:', customRules);
    }
    
    // First ensure dependencies are installed in the workspace
    try {
        console.log('Installing dependencies in workspace...');
        await execAsync('npm install aws-cdk aws-cdk-lib cdk-nag yaml --save-dev', { cwd: workspacePath });
        console.log('Dependencies installed successfully');
    } catch (error) {
        console.error('Error installing dependencies:', error);
        throw new Error(`Failed to install required dependencies: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // First ensure we have a synthesized template
    const { stdout: synthOutput, stderr: synthError } = await execAsync('cdk synth --no-staging', { cwd: workspacePath });
    if (synthError) {
        console.error('CDK synth error:', synthError);
        throw new Error(`CDK synthesis failed: ${synthError}`);
    }
    console.log('CDK synthesis completed successfully');

    // Create a temporary file for the synthesized template
    const tempDir = path.join(workspacePath, '.cdk-nag-temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }
    const templatePath = path.join(tempDir, 'template.yaml');
    fs.writeFileSync(templatePath, synthOutput);

    // Create a temporary file for custom rules
    const customRulesPath = path.join(tempDir, 'custom-rules.js');
    if (customRules.length > 0) {
        const customRulesCode = `
            const { NagPack } = require('cdk-nag');
            
            class CustomRules extends NagPack {
                constructor() {
                    super();
                    this.packName = 'CustomRules';
                }
                
                visit(template) {
                    const findings = [];
                    const resources = template.Resources || {};
                    
                    Object.entries(resources).forEach(([resourceId, resource]) => {
                        ${customRules.map(rule => `
                            if (${rule.resourceTypes.map(type => `resource.Type === '${type}'`).join(' || ')}) {
                                try {
                                    if (${rule.condition}) {
                                        findings.push({
                                            id: '${rule.id}',
                                            name: '${rule.name}',
                                            description: '${rule.description}',
                                            level: '${rule.level}',
                                            resourceId: resourceId
                                        });
                                    }
                                } catch (error) {
                                    console.error('Error evaluating rule ${rule.id}:', error);
                                }
                            }
                        `).join('\n')}
                    });
                    
                    return { findings };
                }
            }
            module.exports = { CustomRules };
        `;
        fs.writeFileSync(customRulesPath, customRulesCode);
    }

    // Run CDK-NAG using the library
    const { stdout, stderr } = await execAsync(`node -e "
        const { App } = require('aws-cdk-lib');
        const cdkNag = require('cdk-nag');
        ${customRules.length > 0 ? `const { CustomRules } = require('${customRulesPath}');` : ''}
        const yaml = require('yaml');
        const fs = require('fs');
        
        const app = new App();
        const templateContent = fs.readFileSync('${templatePath}', 'utf8');
        const template = yaml.parse(templateContent);
        
        const findings = [];
        
        // Run built-in rule packs
        ${rulePacks.map(pack => `
            const ${pack.toLowerCase()}Checks = new cdkNag.${pack}();
            const ${pack.toLowerCase()}Result = ${pack.toLowerCase()}Checks.visit(template);
            if (${pack.toLowerCase()}Result && ${pack.toLowerCase()}Result.findings) {
                findings.push(...${pack.toLowerCase()}Result.findings);
            }
        `).join('\n')}
        
        // Run custom rules if any
        ${customRules.length > 0 ? `
            const customChecks = new CustomRules();
            const customResult = customChecks.visit(template);
            if (customResult && customResult.findings) {
                findings.push(...customResult.findings);
            }
        ` : ''}
        
        console.log(JSON.stringify(findings, null, 2));
    "`, { cwd: workspacePath });

    if (stderr) {
        console.error('CDK-NAG error:', stderr);
        throw new Error(`CDK-NAG validation failed: ${stderr}`);
    }

    // Clean up temporary files
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    console.log('CDK-NAG output:', stdout);
    return stdout;
}

// Configure CDK-NAG rules
async function configureRules() {
    const config = vscode.workspace.getConfiguration('cdkNagValidator');
    
    // Show quick pick for rule packs
    const selectedPacks = await vscode.window.showQuickPick(AVAILABLE_RULE_PACKS, {
        canPickMany: true,
        placeHolder: 'Select CDK-NAG rule packs to enable'
    });
    
    if (selectedPacks) {
        await config.update('enabledRulePacks', selectedPacks, vscode.ConfigurationTarget.Global);
    }
    
    // Show input box for custom rules
    const addCustomRule = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Would you like to add a custom rule?'
    });
    
    if (addCustomRule === 'Yes') {
        const customRules = config.get<any[]>('customRules', []);
        
        const id = await vscode.window.showInputBox({
            prompt: 'Enter a unique identifier for the rule',
            placeHolder: 'e.g., S3_BUCKET_ENCRYPTION'
        });
        
        if (!id) return;
        
        const name = await vscode.window.showInputBox({
            prompt: 'Enter a name for the rule',
            placeHolder: 'e.g., S3 Bucket Encryption Required'
        });
        
        if (!name) return;
        
        const description = await vscode.window.showInputBox({
            prompt: 'Enter a description for the rule',
            placeHolder: 'e.g., S3 buckets must have encryption enabled'
        });
        
        if (!description) return;
        
        const level = await vscode.window.showQuickPick(['ERROR', 'WARNING', 'INFO'], {
            placeHolder: 'Select the severity level'
        });
        
        if (!level) return;
        
        const resourceTypes = await vscode.window.showInputBox({
            prompt: 'Enter AWS resource types (comma-separated)',
            placeHolder: 'e.g., AWS::S3::Bucket, AWS::DynamoDB::Table'
        });
        
        if (!resourceTypes) return;
        
        const condition = await vscode.window.showInputBox({
            prompt: 'Enter the condition to check (JavaScript)',
            placeHolder: 'e.g., !resource.Properties.Encryption'
        });
        
        if (!condition) return;
        
        customRules.push({
            id,
            name,
            description,
            level,
            resourceTypes: resourceTypes.split(',').map(t => t.trim()),
            condition
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
        vscode.window.showErrorMessage(`Failed to install CDK-NAG: ${error instanceof Error ? error.message : String(error)}`);
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
                ...packageJson.devDependencies
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
        vscode.window.showErrorMessage(`Failed to install AWS CDK: ${error instanceof Error ? error.message : String(error)}`);
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
async function mapFindingsToSourceLocations(findings: any[], document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();

    console.log('Mapping findings to source locations for file:', document.fileName);
    console.log('Document text:', text);

    // Map each finding to its source location
    for (const finding of findings) {
        console.log('Processing finding:', finding);
        
        // Extract resource type from the finding ID
        const resourceType = finding.id.split('_')[0];
        console.log(`Looking for resource type: ${resourceType}`);
        
        // Find all resource definitions of this type in the source code
        // Match both direct usage (new S3) and imported usage (new s3.Bucket)
        const resourceRegex = new RegExp(`new\\s+(?:${resourceType}|\\w+\\.${resourceType})\\s*\\([^)]*\\)`, 'gi');
        let match;
        let foundMatch = false;
        
        while ((match = resourceRegex.exec(text)) !== null) {
            console.log(`Found ${resourceType} resource at position ${match.index}:`, match[0]);
            
            // Get the range for this resource
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + match[0].length);
            const range = new vscode.Range(startPos, endPos);
            
            console.log('Created range:', range);
            
            // Create a diagnostic for the finding
            const diagnostic = new vscode.Diagnostic(
                range,
                `${finding.name}: ${finding.description}`,
                finding.level === 'ERROR' ? vscode.DiagnosticSeverity.Error :
                finding.level === 'WARNING' ? vscode.DiagnosticSeverity.Warning :
                vscode.DiagnosticSeverity.Information
            );
            
            // Add additional information
            diagnostic.source = 'CDK-NAG';
            diagnostic.code = finding.id;
            
            // Add related information if available
            if (finding.explanation) {
                diagnostic.relatedInformation = [{
                    location: new vscode.Location(document.uri, range),
                    message: finding.explanation
                }];
            }

            // Add inline suggestion if available and enabled
            if (shouldShowInlineSuggestions() && COMMON_FIXES[finding.id]) {
                const suggestion = new vscode.CodeAction(
                    `Fix: ${finding.name}`,
                    vscode.CodeActionKind.QuickFix
                );
                suggestion.edit = new vscode.WorkspaceEdit();
                suggestion.edit.insert(document.uri, range.end, `\n    ${COMMON_FIXES[finding.id]}`);
                suggestion.diagnostics = [diagnostic];
                suggestion.isPreferred = true;
                diagnostic.relatedInformation?.push({
                    location: new vscode.Location(document.uri, range),
                    message: `Quick fix available: ${COMMON_FIXES[finding.id]}`
                });
            }
            
            diagnostics.push(diagnostic);
            console.log('Added diagnostic:', diagnostic);
            foundMatch = true;
        }
        
        if (!foundMatch) {
            console.log(`No ${resourceType} resources found in the code`);
            
            // Try a more lenient search as fallback
            const fallbackRegex = new RegExp(`new\\s+[\\w.]*${resourceType}[\\w.]*\\s*\\(`, 'gi');
            let fallbackMatch;
            while ((fallbackMatch = fallbackRegex.exec(text)) !== null) {
                console.log(`Found ${resourceType} resource with fallback search at position ${fallbackMatch.index}:`, fallbackMatch[0]);
                
                const startPos = document.positionAt(fallbackMatch.index);
                const endPos = document.positionAt(fallbackMatch.index + fallbackMatch[0].length);
                const range = new vscode.Range(startPos, endPos);
                
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `${finding.name}: ${finding.description}`,
                    finding.level === 'ERROR' ? vscode.DiagnosticSeverity.Error :
                    finding.level === 'WARNING' ? vscode.DiagnosticSeverity.Warning :
                    vscode.DiagnosticSeverity.Information
                );
                
                diagnostic.source = 'CDK-NAG';
                diagnostic.code = finding.id;
                
                diagnostics.push(diagnostic);
                console.log('Added diagnostic from fallback search:', diagnostic);
                foundMatch = true;
            }
        }
    }

    console.log('Final diagnostics:', diagnostics);
    return diagnostics;
}

// Validate a file
async function validateFile(document: vscode.TextDocument) {
    try {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        console.log('Running CDK-NAG validation for file:', document.fileName);
        const output = await runCdkNag(workspaceFolder.uri.fsPath);
        
        try {
            const findings = JSON.parse(output);
            console.log('CDK-NAG findings:', findings);
            
            if (findings.length > 0) {
                // Map findings to source locations
                const diagnostics = await mapFindingsToSourceLocations(findings, document);
                console.log('Created diagnostics:', diagnostics);
                
                // Clear existing diagnostics
                diagnosticCollection.delete(document.uri);
                
                // Update the diagnostic collection
                diagnosticCollection.set(document.uri, diagnostics);
                console.log('Set diagnostics for document:', document.uri.toString());
                
                // Show a summary message
                const errorCount = findings.filter(f => f.level === 'ERROR').length;
                const warningCount = findings.filter(f => f.level === 'WARNING').length;
                const infoCount = findings.filter(f => f.level === 'INFO').length;
                
                let message = `Found ${findings.length} CDK-NAG issues:`;
                if (errorCount > 0) message += ` ${errorCount} errors`;
                if (warningCount > 0) message += ` ${warningCount} warnings`;
                if (infoCount > 0) message += ` ${infoCount} info`;
                
                vscode.window.showWarningMessage(message);

                // Force update of diagnostics
                await vscode.commands.executeCommand('workbench.action.problems.focus');
                
                // Force refresh of the editor
                await vscode.commands.executeCommand('workbench.action.files.revert');
            } else {
                diagnosticCollection.delete(document.uri);
                vscode.window.showInformationMessage('No CDK-NAG issues found');
            }
        } catch (error) {
            console.error('Error parsing CDK-NAG output:', error);
            throw new Error(`Failed to parse CDK-NAG output: ${error instanceof Error ? error.message : String(error)}`);
        }
    } catch (error) {
        console.error('Error validating file:', error);
        throw error;
    }
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
    console.log('CDK-NAG Validator extension is now active');

    // Initialize diagnostic collection
    diagnosticCollection = vscode.languages.createDiagnosticCollection('cdk-nag');
    context.subscriptions.push(diagnosticCollection);

    // Register the validate command
    let validateCommand = vscode.commands.registerCommand('cdk-nag-validator.validate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        try {
            await validateFile(editor.document);
        } catch (error) {
            console.error('Error during validation:', error);
            vscode.window.showErrorMessage(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Register the validate workspace command
    let validateWorkspaceCommand = vscode.commands.registerCommand('cdk-nag-validator.validateWorkspace', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        try {
            await validateWorkspace(workspaceFolder);
        } catch (error) {
            console.error('Error during workspace validation:', error);
            vscode.window.showErrorMessage(`Workspace validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Add commands to the extension context
    context.subscriptions.push(validateCommand);
    context.subscriptions.push(validateWorkspaceCommand);

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
                ...packageJson.devDependencies
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
    const hasCdkImports = content.includes('aws-cdk-lib') || 
                         content.includes('@aws-cdk/core') ||
                         content.includes('cdk-nag');

    console.log('File validation check results:', {
        hasCdkJson,
        hasPackageJson,
        hasCdkImports
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
        vscode.window.showErrorMessage(`Error validating current file: ${error instanceof Error ? error.message : String(error)}`);
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
                    const diagnostics = await mapFindingsToSourceLocations(findings, document);
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
            throw new Error(`Failed to parse CDK-NAG output: ${error instanceof Error ? error.message : String(error)}`);
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