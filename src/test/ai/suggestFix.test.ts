/**
 * Jest tests for `src/ai/suggestFix.ts`.
 *
 * Coverage focuses on the orchestration — the scrubber and consent modules
 * have their own dedicated specs, so we stub them at the boundary and assert:
 *
 *   • The snippet extractor respects the ±10 line window and clamps to
 *     document bounds.
 *   • `buildPrompt` folds rule-doc context into the first User message and
 *     instructs the model to return a bare fenced code block.
 *   • `parseReplacement` handles bare text, ```typescript fences, plain
 *     ``` fences, and empty responses.
 *   • `askCopilotForFix` short-circuits correctly when:
 *     - `vscode.lm` is undefined (no-model)
 *     - consent is denied (cancelled)
 *     - `selectChatModels` returns empty for both gpt-4o-mini and fallback
 *       (no-model) — OR returns empty for gpt-4o-mini but succeeds for the
 *       fallback (applied, via the fallback model)
 *     - model `sendRequest` throws (error)
 *     - the response is empty after parsing (no-response)
 *     - `applyEdit` resolves false (cancelled — user rejected preview)
 *     - the happy path resolves `'applied'` AND stages a replace edit with
 *       `needsConfirmation: true` so the user gets a diff preview.
 *   • The snippet is scrubbed BEFORE being sent — we assert the sent prompt
 *     contains `<REDACTED_SSN>` when the source did.
 */

import {
  askCopilotForFix,
  buildPrompt,
  extractSnippet,
  parseReplacement,
  type AskCopilotPayload,
} from '../../ai/suggestFix';
import * as vscode from 'vscode';
import {
  createMockExtensionContext,
  LanguageModelChatMessage,
  makeFakeChatModel,
} from '../__mocks__/vscode';
import { scrubSnippet } from '../../ai/scrubber';

// The suggestFix module also consults `lookupRuleDoc` when building the
// prompt. We let the real implementation run — it's a pure-data lookup —
// and pick rule ids from the actual curated list for assertions.

function makeDoc(lines: string[]): vscode.TextDocument {
  return {
    lineCount: lines.length,
    lineAt: (i: number) => ({
      text: lines[i] ?? '',
      lineNumber: i,
      range: new vscode.Range(i, 0, i, (lines[i] ?? '').length),
    }),
    uri: vscode.Uri.file('/tmp/stack.ts'),
    fileName: '/tmp/stack.ts',
  } as unknown as vscode.TextDocument;
}

const NOOP_CHANNEL = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const BASE_PAYLOAD: AskCopilotPayload = {
  ruleId: 'AwsSolutions-CustomUncurated999',
  uri: 'file:///tmp/stack.ts',
  range: {
    start: { line: 5, character: 0 },
    end: { line: 5, character: 20 },
  },
  message: 'Example finding text.',
};

describe('extractSnippet', () => {
  const LINES = [
    'import * as cdk from "aws-cdk-lib";',
    'import { Bucket } from "aws-cdk-lib/aws-s3";',
    '',
    'export class MyStack extends cdk.Stack {',
    '  constructor(scope: Construct, id: string) {',
    '    super(scope, id);',
    '    new Bucket(this, "MyBucket", {});',
    '  }',
    '}',
    '',
  ];

  it('returns ±10 lines by default, clamped to document bounds', () => {
    const doc = makeDoc(LINES);
    // LINES has 10 entries (indices 0..9), so lineCount=10. line=6 with
    // default context=10 clamps to [0, 9] — the full document.
    const snippet = extractSnippet(doc, 6); // line 6 is the bucket construct
    expect(snippet.startLine).toBe(0);
    expect(snippet.endLine).toBe(LINES.length - 1);
    expect(snippet.text.split('\n').length).toBe(LINES.length);
  });

  it('clamps endLine to lineCount - 1', () => {
    const doc = makeDoc(['line 0', 'line 1', 'line 2']);
    const snippet = extractSnippet(doc, 1, 5);
    expect(snippet.startLine).toBe(0);
    expect(snippet.endLine).toBe(2);
  });

  it('honours a custom context size', () => {
    const doc = makeDoc(LINES);
    const snippet = extractSnippet(doc, 6, 2);
    expect(snippet.startLine).toBe(4);
    expect(snippet.endLine).toBe(8);
  });
});

describe('buildPrompt', () => {
  it('includes rule context (name, severity, description) for a curated rule', () => {
    const scrubbed = scrubSnippet('new s3.Bucket(this, "X", {});');
    const prompt = buildPrompt('AwsSolutions-S1', 'S3 finding', scrubbed);
    expect(prompt).toContain('AwsSolutions-S1');
    expect(prompt).toMatch(/S3 Bucket Server Access Logging/);
    expect(prompt).toContain('S3 finding');
    expect(prompt).toMatch(/```typescript/);
  });

  it('falls back to a generic line for uncurated rule ids', () => {
    const scrubbed = scrubSnippet('new s3.Bucket(this, "X", {});');
    const prompt = buildPrompt('Custom-Unknown999', 'Generic finding', scrubbed);
    expect(prompt).toContain('Custom-Unknown999');
    expect(prompt).toContain('No curated documentation available');
  });

  it('instructs the model to return only a fenced code block', () => {
    const prompt = buildPrompt('AwsSolutions-S1', 'm', scrubSnippet('x'));
    expect(prompt).toMatch(/no prose/i);
    expect(prompt).toMatch(/fenced.*typescript.*code block/i);
  });

  it('reports the redaction count in the prompt header', () => {
    const scrubbed = scrubSnippet('secret=123-45-6789');
    const prompt = buildPrompt('AwsSolutions-S1', 'm', scrubbed);
    expect(prompt).toContain('1 secret redacted');
  });
});

describe('parseReplacement', () => {
  it('extracts body from a ```typescript fence', () => {
    const raw = '```typescript\nconst x = 1;\n```';
    expect(parseReplacement(raw)).toBe('const x = 1;');
  });

  it('extracts body from a bare ``` fence', () => {
    const raw = '```\nconst x = 1;\n```';
    expect(parseReplacement(raw)).toBe('const x = 1;');
  });

  it('handles a ```ts short fence', () => {
    const raw = '```ts\nconst y = 2;\n```';
    expect(parseReplacement(raw)).toBe('const y = 2;');
  });

  it('returns the trimmed raw response when no fence is present', () => {
    const raw = 'const z = 3;\n\n';
    expect(parseReplacement(raw)).toBe('const z = 3;');
  });

  it('returns undefined for empty / whitespace-only responses', () => {
    expect(parseReplacement('')).toBeUndefined();
    expect(parseReplacement('   \n\n   ')).toBeUndefined();
    expect(parseReplacement('```\n\n```')).toBeUndefined();
  });
});

describe('askCopilotForFix — short-circuit paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns "no-model" when the vscode.lm namespace is undefined', async () => {
    const context = createMockExtensionContext();
    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      withProgress: jest.fn(async (_opts, task) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      ),
    } as unknown as typeof vscode.window;

    const result = await askCopilotForFix(context, BASE_PAYLOAD, {
      channel: NOOP_CHANNEL,
      windowApi,
      lmApi: undefined,
    });

    expect(result).toBe('no-model');
    expect(windowApi.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Language Model API not available')
    );
  });

  it('returns "cancelled" when consent is denied', async () => {
    const context = createMockExtensionContext();
    const windowApi = {
      ...vscode.window,
      showWarningMessage: jest.fn(async () => 'Cancel'),
      showInformationMessage: jest.fn(),
      showErrorMessage: jest.fn(),
    } as unknown as typeof vscode.window;
    const lmApi = {
      selectChatModels: jest.fn(async () => [makeFakeChatModel()]),
    } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(context, BASE_PAYLOAD, {
      channel: NOOP_CHANNEL,
      windowApi,
      lmApi,
    });

    expect(result).toBe('cancelled');
    // We bail before even opening the document or selecting a model.
    expect(lmApi.selectChatModels).not.toHaveBeenCalled();
  });

  it('returns "no-model" when both gpt-4o-mini and fallback selectChatModels are empty', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('cdkNagValidator.aiSuggestions.consent', 'always');
    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
    } as unknown as typeof vscode.window;
    const workspaceApi = {
      ...vscode.workspace,
      openTextDocument: jest.fn(async () => makeDoc(['// line 0', '// line 1'])),
      applyEdit: jest.fn(async () => true),
    } as unknown as typeof vscode.workspace;
    const lmApi = {
      selectChatModels: jest.fn(async () => []),
    } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(
      context,
      {
        ...BASE_PAYLOAD,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
      { channel: NOOP_CHANNEL, windowApi, workspaceApi, lmApi }
    );

    expect(result).toBe('no-model');
    // The orchestrator tries gpt-4o-mini first, then falls back to the
    // any-copilot selector — both get called.
    expect(lmApi.selectChatModels).toHaveBeenCalledTimes(2);
  });
});

describe('askCopilotForFix — happy path + edit preview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scrubs the snippet, sends the scrubbed prompt, and stages an edit with needsConfirmation: true', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('cdkNagValidator.aiSuggestions.consent', 'always');

    const sourceLines = [
      'import { Bucket } from "aws-cdk-lib/aws-s3";',
      '// SSN: 123-45-6789', // <-- deliberately plant a secret
      'new Bucket(this, "MyBucket", {});',
    ];
    const doc = makeDoc(sourceLines);

    const model = makeFakeChatModel({
      chunks: [
        '```typescript\n',
        'new Bucket(this, "MyBucket", {\n  versioned: true,\n});\n',
        '```',
      ],
    });

    const applyEdit = jest.fn(async (_edit: vscode.WorkspaceEdit) => true);
    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      withProgress: jest.fn(async (_opts, task) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      ),
    } as unknown as typeof vscode.window;
    const workspaceApi = {
      ...vscode.workspace,
      openTextDocument: jest.fn(async () => doc),
      applyEdit,
    } as unknown as typeof vscode.workspace;
    const lmApi = {
      selectChatModels: jest.fn(async () => [model]),
    } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(
      context,
      {
        ...BASE_PAYLOAD,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 20 } },
      },
      { channel: NOOP_CHANNEL, windowApi, workspaceApi, lmApi }
    );

    expect(result).toBe('applied');

    // The SSN must be redacted in the prompt actually sent.
    const sent = model.sendRequest.mock.calls[0][0] as LanguageModelChatMessage[];
    expect(sent).toHaveLength(1);
    expect(sent[0].role).toBe(1); // User role
    expect(sent[0].content).toContain('<REDACTED_SSN>');
    expect(sent[0].content).not.toContain('123-45-6789');

    // The edit must be staged with needsConfirmation so it routes through
    // the Refactor Preview panel.
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const stagedEdit = applyEdit.mock.calls[0][0] as vscode.WorkspaceEdit & {
      edits: Array<{
        kind: string;
        text?: string;
        metadata?: { needsConfirmation?: boolean; label?: string };
      }>;
    };
    expect(stagedEdit.edits).toHaveLength(1);
    expect(stagedEdit.edits[0].kind).toBe('replace');
    expect(stagedEdit.edits[0].metadata).toEqual(
      expect.objectContaining({ needsConfirmation: true })
    );
    expect(stagedEdit.edits[0].metadata?.label).toContain(BASE_PAYLOAD.ruleId);
    // The inserted text should be the parsed replacement, not the fenced source.
    expect(stagedEdit.edits[0].text).toContain('versioned: true');
    expect(stagedEdit.edits[0].text).not.toContain('```');
  });

  it('returns "cancelled" when applyEdit resolves false (user rejected preview)', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('cdkNagValidator.aiSuggestions.consent', 'always');

    const doc = makeDoc(['line 0', 'line 1', 'line 2']);
    const model = makeFakeChatModel({ chunks: ['```ts\nconst x = 1;\n```'] });

    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      withProgress: jest.fn(async (_opts, task) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      ),
    } as unknown as typeof vscode.window;
    const workspaceApi = {
      ...vscode.workspace,
      openTextDocument: jest.fn(async () => doc),
      applyEdit: jest.fn(async () => false),
    } as unknown as typeof vscode.workspace;
    const lmApi = { selectChatModels: jest.fn(async () => [model]) } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(
      context,
      {
        ...BASE_PAYLOAD,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      },
      { channel: NOOP_CHANNEL, windowApi, workspaceApi, lmApi }
    );

    expect(result).toBe('cancelled');
  });

  it('returns "error" when sendRequest throws', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('cdkNagValidator.aiSuggestions.consent', 'always');

    const doc = makeDoc(['line 0', 'line 1']);
    const model = makeFakeChatModel({ throwError: new Error('rate limit exceeded') });

    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      withProgress: jest.fn(async (_opts, task) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      ),
    } as unknown as typeof vscode.window;
    const workspaceApi = {
      ...vscode.workspace,
      openTextDocument: jest.fn(async () => doc),
      applyEdit: jest.fn(async () => true),
    } as unknown as typeof vscode.workspace;
    const lmApi = { selectChatModels: jest.fn(async () => [model]) } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(
      context,
      {
        ...BASE_PAYLOAD,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
      { channel: NOOP_CHANNEL, windowApi, workspaceApi, lmApi }
    );

    expect(result).toBe('error');
    expect(windowApi.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('rate limit exceeded')
    );
  });

  it('returns "no-response" when the model returns an empty / unparsable response', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('cdkNagValidator.aiSuggestions.consent', 'always');

    const doc = makeDoc(['line 0', 'line 1']);
    const model = makeFakeChatModel({ chunks: ['   \n', '   '] });

    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      withProgress: jest.fn(async (_opts, task) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      ),
    } as unknown as typeof vscode.window;
    const workspaceApi = {
      ...vscode.workspace,
      openTextDocument: jest.fn(async () => doc),
      applyEdit: jest.fn(async () => true),
    } as unknown as typeof vscode.workspace;
    const lmApi = { selectChatModels: jest.fn(async () => [model]) } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(
      context,
      {
        ...BASE_PAYLOAD,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
      { channel: NOOP_CHANNEL, windowApi, workspaceApi, lmApi }
    );

    expect(result).toBe('no-response');
  });

  it('falls back to any Copilot model when gpt-4o-mini is not resolvable', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update('cdkNagValidator.aiSuggestions.consent', 'always');

    const doc = makeDoc(['line 0', 'line 1']);
    const fallbackModel = makeFakeChatModel({
      family: 'gpt-4o',
      chunks: ['```typescript\nconst x = 2;\n```'],
    });

    const windowApi = {
      ...vscode.window,
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
      showErrorMessage: jest.fn(),
      withProgress: jest.fn(async (_opts, task) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
      ),
    } as unknown as typeof vscode.window;
    const workspaceApi = {
      ...vscode.workspace,
      openTextDocument: jest.fn(async () => doc),
      applyEdit: jest.fn(async () => true),
    } as unknown as typeof vscode.workspace;

    const selectChatModels = jest
      .fn()
      .mockResolvedValueOnce([]) // gpt-4o-mini: empty
      .mockResolvedValueOnce([fallbackModel]); // any copilot: returns gpt-4o
    const lmApi = { selectChatModels } as unknown as typeof vscode.lm;

    const result = await askCopilotForFix(
      context,
      {
        ...BASE_PAYLOAD,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
      { channel: NOOP_CHANNEL, windowApi, workspaceApi, lmApi }
    );

    expect(result).toBe('applied');
    expect(selectChatModels).toHaveBeenCalledTimes(2);
    expect(fallbackModel.sendRequest).toHaveBeenCalledTimes(1);
  });
});
