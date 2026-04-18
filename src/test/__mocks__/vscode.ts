// Jest mock for the `vscode` module (which only exists at runtime inside the
// VS Code extension host). Used via moduleNameMapper in jest.config.js.

export const window = {
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  // Supports both OutputChannel (appendLine) and LogOutputChannel (trace/info/
  // warn/error) APIs — the extension uses LogOutputChannel via `{ log: true }`.
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    append: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
    replace: jest.fn(),
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    logLevel: 2,
    onDidChangeLogLevel: jest.fn(),
    name: 'mock',
  })),
};

export const workspace = {
  getConfiguration: jest.fn(),
  onDidChangeConfiguration: jest.fn(),
  onDidSaveTextDocument: jest.fn(),
  onDidChangeTextDocument: jest.fn(),
  onDidCloseTextDocument: jest.fn(),
  workspaceFolders: undefined as unknown,
  getWorkspaceFolder: jest.fn(),
  findFiles: jest.fn(),
  openTextDocument: jest.fn(),
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
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
