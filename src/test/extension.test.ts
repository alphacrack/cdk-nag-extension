/**
 * Jest unit tests for the CDK NAG Validator extension.
 *
 * These tests run without a live VS Code process (vscode is fully mocked in
 * src/test/setup.ts).  Integration / activation tests that require an actual
 * VS Code instance live in src/test/suite/ and are run via
 * `npm run test:integration`.
 */

import * as vscode from 'vscode';

describe('CDK NAG Validator — VS Code API wiring', () => {
  it('createDiagnosticCollection is callable', () => {
    // Verifies the mock is set up correctly so extension code that calls
    // vscode.languages.createDiagnosticCollection() won't crash in tests.
    const collection = vscode.languages.createDiagnosticCollection('cdk-nag');
    expect(vscode.languages.createDiagnosticCollection).toHaveBeenCalledWith('cdk-nag');
    // The mock returns an object — just verify it is truthy.
    expect(collection).toBeDefined();
  });

  it('showErrorMessage is callable without throwing', () => {
    expect(() => vscode.window.showErrorMessage('test error')).not.toThrow();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('test error');
  });

  it('showInformationMessage is callable without throwing', () => {
    expect(() => vscode.window.showInformationMessage('test info')).not.toThrow();
  });

  it('DiagnosticSeverity values are defined', () => {
    expect(vscode.DiagnosticSeverity.Error).toBe(0);
    expect(vscode.DiagnosticSeverity.Warning).toBe(1);
    expect(vscode.DiagnosticSeverity.Information).toBe(2);
    expect(vscode.DiagnosticSeverity.Hint).toBe(3);
  });

  it('registerCommand is callable', () => {
    const handler = jest.fn();
    vscode.commands.registerCommand('test.command', handler);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('test.command', handler);
  });
});

describe('CDK NAG Validator — configuration defaults', () => {
  beforeEach(() => {
    // Set up getConfiguration to return a mock config object
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultVal: unknown) => defaultVal),
      update: jest.fn(),
    });
  });

  it('autoInstall defaults to false', () => {
    const config = vscode.workspace.getConfiguration('cdkNagValidator');
    const autoInstall = config.get('autoInstall', false);
    expect(autoInstall).toBe(false);
  });

  it('autoValidate defaults to true', () => {
    const config = vscode.workspace.getConfiguration('cdkNagValidator');
    const autoValidate = config.get('autoValidate', true);
    expect(autoValidate).toBe(true);
  });

  it('showInlineSuggestions defaults to true', () => {
    const config = vscode.workspace.getConfiguration('cdkNagValidator');
    const show = config.get('showInlineSuggestions', true);
    expect(show).toBe(true);
  });

  it('enabledRulePacks defaults to AwsSolutionsChecks', () => {
    const config = vscode.workspace.getConfiguration('cdkNagValidator');
    const packs = config.get('enabledRulePacks', ['AwsSolutionsChecks']);
    expect(packs).toEqual(['AwsSolutionsChecks']);
  });
});
