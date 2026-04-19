// Jest mock for the `vscode` module (which only exists at runtime inside the
// VS Code extension host). Used via moduleNameMapper in jest.config.js.

export const window = {
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  // `withProgress` is a thin wrapper that invokes the task callback with a
  // progress + cancellation-token pair. The mock supplies a non-cancelled
  // token so the happy path works; tests can override the mock to return a
  // cancelled token or swap the whole function.
  withProgress: jest.fn(
    async (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
      const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
      return task({ report: jest.fn() }, token);
    }
  ),
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

/** `vscode.ProgressLocation` enum — used by `withProgress`. */
export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
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
  // `applyEdit` default — resolves true so happy-path tests don't need to
  // stub it. Tests can override per-case with `.mockResolvedValue(false)`
  // to exercise the "user rejected the preview" branch.
  applyEdit: jest.fn(async (_edit: unknown, _metadata?: unknown) => true),
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
  /** Raw edit operations in insertion order — tests assert against this array. */
  public readonly edits: Array<
    | { kind: 'insert'; uri: Uri; position: Position; text: string }
    | {
        kind: 'replace';
        uri: Uri;
        range: Range;
        text: string;
        metadata?: { needsConfirmation?: boolean; label?: string; description?: string };
      }
  > = [];
  insert(uri: Uri, position: Position, text: string): void {
    this.edits.push({ kind: 'insert', uri, position, text });
  }
  replace(
    uri: Uri,
    range: Range,
    text: string,
    metadata?: { needsConfirmation?: boolean; label?: string; description?: string }
  ): void {
    this.edits.push({ kind: 'replace', uri, range, text, metadata });
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

/**
 * Build a minimal `vscode.ExtensionContext` stand-in for tests that need
 * `globalState`-backed persistence. The backing store is a plain Map so
 * tests can inspect it directly. `update(key, undefined)` deletes the key
 * to mirror the real API's semantics.
 */
export function createMockExtensionContext(): {
  globalState: {
    _store: Map<string, unknown>;
    get: <T>(key: string) => T | undefined;
    update: jest.Mock;
  };
  subscriptions: Array<{ dispose: () => void }>;
} {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      _store: store,
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: jest.fn(async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      }),
    },
    subscriptions: [],
  };
}

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

// ── Language Model Chat messages ──
// `vscode.LanguageModelChatMessage` is a class with static `User` / `Assistant`
// factories in 1.97. No `System` role exists at this API version — system
// instructions must be folded into the first User message.
export const LanguageModelChatMessageRole = {
  User: 1,
  Assistant: 2,
};

export class LanguageModelChatMessage {
  public readonly role: number;
  public readonly content: string;
  public readonly name?: string;
  constructor(role: number, content: string, name?: string) {
    this.role = role;
    this.content = content;
    this.name = name;
  }
  static User(content: string, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: string, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}

/**
 * Build a fake `LanguageModelChat` whose `sendRequest` streams the supplied
 * text chunks. Tests use this to lock the prompt shape and the response-
 * parsing behaviour without needing a real Copilot model. If `chunks` is a
 * function, it is called with the sent `messages` so tests can assert on
 * what the orchestrator actually sent.
 */
export function makeFakeChatModel(options?: {
  id?: string;
  family?: string;
  vendor?: string;
  chunks?: string[] | ((messages: LanguageModelChatMessage[]) => string[]);
  throwError?: Error;
}): {
  id: string;
  family: string;
  vendor: string;
  sendRequest: jest.Mock;
} {
  const chunks = options?.chunks ?? [];
  return {
    id: options?.id ?? 'fake-gpt-4o-mini',
    family: options?.family ?? 'gpt-4o-mini',
    vendor: options?.vendor ?? 'copilot',
    sendRequest: jest.fn(async (messages: LanguageModelChatMessage[]) => {
      if (options?.throwError) throw options.throwError;
      const resolvedChunks = typeof chunks === 'function' ? chunks(messages) : chunks;
      return {
        text: {
          async *[Symbol.asyncIterator](): AsyncGenerator<string> {
            for (const chunk of resolvedChunks) yield chunk;
          },
        },
      };
    }),
  };
}

// Language Model API mock — `vscode.lm` was finalized in 1.97 for tool
// registration, invocation, and chat-model selection. Tests override
// individual jest fns via `.mockReturnValue(...)` per-case and can flip
// the whole namespace to `undefined` to exercise the "no LM API" fallback.
export const lm = {
  registerTool: jest.fn((_name: string, _tool: unknown) => ({ dispose: jest.fn() })),
  invokeTool: jest.fn(
    async (_name: string, _options: unknown, _token?: unknown) =>
      new LanguageModelToolResult([new LanguageModelTextPart('mock tool result')])
  ),
  // Returns an empty array by default — callers should either resolve a
  // Copilot model or gracefully degrade. Tests override with a fake model.
  selectChatModels: jest.fn(async (_selector?: unknown) => [] as unknown[]),
  tools: [] as unknown[],
};
