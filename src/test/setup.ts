import * as vscode from 'vscode';

// Mock VS Code API
jest.mock('vscode', () => ({
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
    })),
  },
  workspace: {
    getConfiguration: jest.fn(),
    onDidChangeConfiguration: jest.fn(),
  },
  languages: {
    createDiagnosticCollection: jest.fn(),
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  Range: jest.fn(),
  Position: jest.fn(),
  Diagnostic: jest.fn(),
  Uri: {
    file: jest.fn(),
  },
  commands: {
    registerCommand: jest.fn(),
  },
  ExtensionContext: jest.fn(),
}));

// Global test setup
beforeAll(() => {
  // Add any global setup here
});

// Global test teardown
afterAll(() => {
  // Add any global cleanup here
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
