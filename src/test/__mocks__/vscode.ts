// Jest mock for the `vscode` module (which only exists at runtime inside the
// VS Code extension host). Used via moduleNameMapper in jest.config.js.

export const window = {
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    show: jest.fn(),
  })),
};

export const workspace = {
  getConfiguration: jest.fn(),
  onDidChangeConfiguration: jest.fn(),
};

export const languages = {
  createDiagnosticCollection: jest.fn(() => ({
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
  })),
};

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
};

export const Range = jest.fn();
export const Position = jest.fn();
export const Diagnostic = jest.fn();

export const Uri = {
  file: jest.fn(),
};

export const commands = {
  registerCommand: jest.fn(),
};

export const ExtensionContext = jest.fn();
