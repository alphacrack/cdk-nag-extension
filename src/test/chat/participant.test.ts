/**
 * Jest tests for the @cdk-nag Copilot Chat participant.
 *
 * We verify:
 *   • Registration is a no-op (returns undefined) when `vscode.chat` is not
 *     available on the host — a vital degradation path for older VS Code and
 *     non-Copilot forks.
 *   • Registration succeeds when chat is available; returned disposable is
 *     what `chat.createChatParticipant` returned.
 *   • The handler streams the ask-only guidance + echoes the user prompt.
 *   • When CDK-NAG diagnostics are present on the active editor, they are
 *     surfaced in the stream; when absent, the "run validate first" nudge is
 *     shown.
 *   • Non-CDK-NAG diagnostics (eslint, ts) are ignored.
 */

import * as vscode from 'vscode';
import {
  CHAT_PARTICIPANT_ID,
  createChatHandler,
  createCdkNagChatParticipant,
} from '../../chat/participant';

type StreamCall = { kind: 'markdown'; text: string };

function makeFakeStream(): { stream: vscode.ChatResponseStream; calls: StreamCall[] } {
  const calls: StreamCall[] = [];
  const stream = {
    markdown: jest.fn((text: string) => calls.push({ kind: 'markdown', text })),
    anchor: jest.fn(),
    button: jest.fn(),
    filetree: jest.fn(),
    progress: jest.fn(),
    reference: jest.fn(),
    push: jest.fn(),
  } as unknown as vscode.ChatResponseStream;
  return { stream, calls };
}

function streamText(calls: StreamCall[]): string {
  return calls
    .filter(c => c.kind === 'markdown')
    .map(c => c.text)
    .join('');
}

function setDiagnosticsAt(diagnostics: vscode.Diagnostic[]): void {
  (vscode.languages.getDiagnostics as unknown as jest.Mock).mockReturnValue(diagnostics);
}

function makeDiag(code: string, source: string, message: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 10),
    message,
    vscode.DiagnosticSeverity.Error
  );
  d.source = source;
  d.code = code;
  return d;
}

describe('createCdkNagChatParticipant (registration)', () => {
  const chatMock = vscode.chat as unknown as {
    createChatParticipant: jest.Mock;
  };

  beforeEach(() => {
    chatMock.createChatParticipant.mockReset();
    chatMock.createChatParticipant.mockReturnValue({ iconPath: undefined, dispose: jest.fn() });
  });

  it('returns the disposable from vscode.chat.createChatParticipant', () => {
    const disposable = createCdkNagChatParticipant();
    expect(disposable).toBeDefined();
    expect(chatMock.createChatParticipant).toHaveBeenCalledTimes(1);
    expect(chatMock.createChatParticipant).toHaveBeenCalledWith(
      CHAT_PARTICIPANT_ID,
      expect.any(Function)
    );
  });

  it('returns undefined when vscode.chat is unavailable (older host)', () => {
    const originalChat = (vscode as unknown as { chat?: unknown }).chat;
    try {
      (vscode as unknown as { chat?: unknown }).chat = undefined;
      const disposable = createCdkNagChatParticipant();
      expect(disposable).toBeUndefined();
    } finally {
      (vscode as unknown as { chat?: unknown }).chat = originalChat;
    }
  });

  it('returns undefined when vscode.chat.createChatParticipant is not a function', () => {
    const originalFn = chatMock.createChatParticipant;
    try {
      (chatMock as unknown as { createChatParticipant: unknown }).createChatParticipant = undefined;
      const disposable = createCdkNagChatParticipant();
      expect(disposable).toBeUndefined();
    } finally {
      chatMock.createChatParticipant = originalFn;
    }
  });
});

describe('createChatHandler (streaming)', () => {
  beforeEach(() => {
    (vscode.languages.getDiagnostics as unknown as jest.Mock).mockReset();
    (vscode.languages.getDiagnostics as unknown as jest.Mock).mockReturnValue([]);
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
  });

  it('streams the ask-only guidance block', async () => {
    const handler = createChatHandler();
    const { stream, calls } = makeFakeStream();
    await handler(
      {
        prompt: '',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as unknown,
      } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as unknown as vscode.CancellationToken
    );

    const text = streamText(calls);
    expect(text).toContain('I can explain cdk-nag findings');
    expect(text).toContain('AwsSolutions-S1');
    expect(text).toContain('AwsSolutions-EC23');
  });

  it('echoes the user prompt back when non-empty', async () => {
    const handler = createChatHandler();
    const { stream, calls } = makeFakeStream();
    await handler(
      {
        prompt: 'explain S3 encryption rule',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as unknown,
      } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as unknown as vscode.CancellationToken
    );
    const text = streamText(calls);
    expect(text).toContain('**You asked**: explain S3 encryption rule');
  });

  it('shows "no findings" nudge when the active editor has no CDK-NAG diagnostics', async () => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: vscode.Uri.file('/ws/src/stack.ts'), fileName: '/ws/src/stack.ts' },
    };
    setDiagnosticsAt([makeDiag('no-unused-vars', 'eslint', 'unused variable')]);

    const handler = createChatHandler();
    const { stream, calls } = makeFakeStream();
    await handler(
      {
        prompt: 'hi',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as unknown,
      } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as unknown as vscode.CancellationToken
    );
    const text = streamText(calls);
    expect(text).toContain('No CDK-NAG diagnostics on the current file');
    // Only the eslint diag is present; no rule-specific output rendered.
    expect(text).not.toContain('**no-unused-vars**');
  });

  it('surfaces up to 5 CDK-NAG findings from the active editor', async () => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: vscode.Uri.file('/ws/src/stack.ts'), fileName: '/ws/src/stack.ts' },
    };
    setDiagnosticsAt([
      makeDiag('AwsSolutions-S1', 'CDK-NAG', 'no access logs'),
      makeDiag('AwsSolutions-S10', 'CDK-NAG', 'no ssl'),
      makeDiag('AwsSolutions-EC23', 'CDK-NAG', 'sg ingress'),
    ]);

    const handler = createChatHandler();
    const { stream, calls } = makeFakeStream();
    await handler(
      {
        prompt: 'whats up',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as unknown,
      } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as unknown as vscode.CancellationToken
    );
    const text = streamText(calls);
    expect(text).toContain('Findings on `stack.ts`');
    expect(text).toContain('**AwsSolutions-S1**');
    expect(text).toContain('**AwsSolutions-S10**');
    expect(text).toContain('**AwsSolutions-EC23**');
  });

  it('truncates findings above 5 and shows "… and N more"', async () => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: vscode.Uri.file('/ws/src/stack.ts'), fileName: '/ws/src/stack.ts' },
    };
    const many = Array.from({ length: 8 }, (_, i) =>
      makeDiag(`AwsSolutions-S${i + 1}`, 'CDK-NAG', `msg ${i}`)
    );
    setDiagnosticsAt(many);

    const handler = createChatHandler();
    const { stream, calls } = makeFakeStream();
    await handler(
      {
        prompt: '',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as unknown,
      } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as unknown as vscode.CancellationToken
    );
    const text = streamText(calls);
    expect(text).toContain('_…and 3 more._');
  });

  it('ignores non-CDK-NAG diagnostics', async () => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
      document: { uri: vscode.Uri.file('/ws/src/stack.ts'), fileName: '/ws/src/stack.ts' },
    };
    setDiagnosticsAt([
      makeDiag('2322', 'ts', 'type mismatch'),
      makeDiag('no-unused', 'eslint', 'unused var'),
    ]);

    const handler = createChatHandler();
    const { stream, calls } = makeFakeStream();
    await handler(
      {
        prompt: '',
        command: undefined,
        references: [],
        toolReferences: [],
        toolInvocationToken: undefined as unknown,
      } as unknown as vscode.ChatRequest,
      { history: [] } as unknown as vscode.ChatContext,
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as unknown as vscode.CancellationToken
    );
    const text = streamText(calls);
    expect(text).toContain('No CDK-NAG diagnostics');
    expect(text).not.toContain('**2322**');
    expect(text).not.toContain('**no-unused**');
  });
});
