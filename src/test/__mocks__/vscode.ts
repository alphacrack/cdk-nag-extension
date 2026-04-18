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
  // Tests override `activeTextEditor` per-case by assigning to the property.
  activeTextEditor: undefined as unknown,
};

// Chat API mock — `vscode.chat` was finalized in 1.97. Tests can override
// `createChatParticipant.mockReturnValue(...)` per-case; the chat participant
// module also probes for `typeof chat.createChatParticipant === 'function'` so
// tests can force the "host without chat API" branch by setting
// `(vscode as any).chat = undefined`.
export const chat = {
  createChatParticipant: jest.fn((_id: string, _handler: unknown) => ({
    iconPath: undefined,
    dispose: jest.fn(),
  })),
};

// `LanguageModelTextPart` and `LanguageModelToolResult` are declared lower
// in this file; the `lm.invokeTool` mock that returns an instance of
// `LanguageModelToolResult` has to resolve the class at call-time, so we
// declare the `lm` export AFTER the classes near the bottom of the file.

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
  registerCodeActionsProvider: jest.fn(),
  registerHoverProvider: jest.fn(),
  // Tests override this per-case via `.mockReturnValue([...])`.
  getDiagnostics: jest.fn(() => []),
};

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
};

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(
    startLineOrStart: number | Position,
    startCharOrEnd: number | Position,
    endLine?: number,
    endChar?: number
  ) {
    if (typeof startLineOrStart === 'number') {
      this.start = new Position(startLineOrStart, startCharOrEnd as number);
      this.end = new Position(endLine as number, endChar as number);
    } else {
      this.start = startLineOrStart;
      this.end = startCharOrEnd as Position;
    }
  }
  contains(pos: Position): boolean {
    if (pos.line < this.start.line || pos.line > this.end.line) return false;
    if (pos.line === this.start.line && pos.character < this.start.character) return false;
    if (pos.line === this.end.line && pos.character > this.end.character) return false;
    return true;
  }
}

export class Diagnostic {
  public source?: string;
  public code?: string | number;
  constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity: number = 0
  ) {}
}

export const CodeActionKind = {
  QuickFix: { value: 'quickfix' },
  Empty: { value: '' },
};

export class CodeAction {
  public diagnostics?: Diagnostic[];
  public isPreferred?: boolean;
  public edit?: WorkspaceEdit;
  public command?: { command: string; title: string; arguments?: unknown[] };
  constructor(public readonly title: string, public readonly kind?: unknown) {}
}

export class WorkspaceEdit {
  public readonly edits: Array<{ uri: Uri; position: Position; text: string }> = [];
  insert(uri: Uri, position: Position, text: string): void {
    this.edits.push({ uri, position, text });
  }
}

export class Hover {
  constructor(
    public readonly contents: MarkdownString | MarkdownString[] | string,
    public readonly range?: Range
  ) {}
}

export class MarkdownString {
  public value = '';
  public isTrusted = false;
  public supportThemeIcons = false;
  constructor(value?: string, supportThemeIcons?: boolean) {
    if (value) this.value = value;
    if (supportThemeIcons) this.supportThemeIcons = true;
  }
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
  appendCodeblock(code: string, language?: string): this {
    this.value += `\n\`\`\`${language ?? ''}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class Uri {
  private constructor(public readonly scheme: string, public readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static parse(s: string): Uri {
    if (s.startsWith('file://')) return new Uri('file', s.slice('file://'.length));
    return new Uri('file', s);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export const commands = {
  registerCommand: jest.fn(),
};

export const ExtensionContext = jest.fn();

// ── Language Model Tool result shapes ──
// Real class implementations of `LanguageModelTextPart` and
// `LanguageModelToolResult` so tests can construct them and the tool code
// under test can `new` them directly. The chat participant's
// `extractToolText` helper also walks `result.content` — keeping the class
// shape identical to @types/vscode avoids needing a separate runtime shim.
export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelPromptTsxPart {
  constructor(public value: unknown) {}
}

export class LanguageModelToolResult {
  constructor(public content: Array<LanguageModelTextPart | LanguageModelPromptTsxPart>) {}
}

// Language Model API mock — `vscode.lm` was finalized in 1.97 for tool
// registration and invocation. Tests override `registerTool` /
// `invokeTool` via `.mockReturnValue(...)` per-case and flip the whole
// namespace to `undefined` to exercise the "no LM tool API" fallback.
export const lm = {
  registerTool: jest.fn((_name: string, _tool: unknown) => ({ dispose: jest.fn() })),
  invokeTool: jest.fn(
    async (_name: string, _options: unknown, _token?: unknown) =>
      new LanguageModelToolResult([new LanguageModelTextPart('mock tool result')])
  ),
  tools: [] as unknown[],
};
