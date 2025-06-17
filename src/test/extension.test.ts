import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

describe('CDK NAG Validator Extension', () => {
  it('should be present', () => {
    expect(vscode.extensions.getExtension('alphacrack.cdk-nag-validator')).toBeDefined();
  });

  it('should activate', async () => {
    const ext = vscode.extensions.getExtension('alphacrack.cdk-nag-validator');
    await ext?.activate();
    expect(ext?.isActive).toBe(true);
  });

  it('should register commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    expect(commands).toContain('cdk-nag-validator.validate');
    expect(commands).toContain('cdk-nag-validator.configureRules');
  });

  it('should validate CDK code', async () => {
    // Create a temporary CDK file with a known issue
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const testFile = path.join(tempDir, 'test-stack.ts');
    const testContent = `
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class TestStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // This should trigger a CDK-NAG warning about unencrypted S3 bucket
    new s3.Bucket(this, 'TestBucket');
  }
}
`;

    fs.writeFileSync(testFile, testContent);

    // Open the file
    const doc = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(doc);

    // Run validation
    await vscode.commands.executeCommand('cdk-nag-validator.validate');

    // Wait for diagnostics to be generated
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Get diagnostics
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);

    // Clean up
    fs.unlinkSync(testFile);
    fs.rmdirSync(tempDir);

    // Assert that we got at least one diagnostic
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
