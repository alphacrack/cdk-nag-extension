/**
 * Jest tests for the CDK-NAG CodeActionProvider.
 *
 * We verify that:
 *   • Only diagnostics with source === 'CDK-NAG' produce actions.
 *   • Rules with a curated fix get an "Apply suggested fix" action whose
 *     WorkspaceEdit inserts a comment block above the flagged range.
 *   • Every CDK-NAG diagnostic — curated or not — gets a "Suppress this
 *     finding" action that fires the suppress command with payload.
 *   • Non-CDK-NAG diagnostics (other linters, TypeScript errors) are ignored.
 */

import * as vscode from 'vscode';
import { CdkNagCodeActionProvider, SUPPRESS_COMMAND_ID } from '../../providers/codeActionProvider';
import { ASK_COPILOT_COMMAND_ID } from '../../ai/suggestFix';

/**
 * Toggle the `cdkNagValidator.enableAiSuggestions` setting via the mocked
 * `workspace.getConfiguration`. Each call returns a fresh config object so
 * the provider's per-call read picks up the latest value.
 */
function setAiSuggestionsEnabled(enabled: boolean): void {
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => {
    if (section === 'cdkNagValidator') {
      return {
        get: (key: string, defaultValue?: unknown) =>
          key === 'enableAiSuggestions' ? enabled : defaultValue,
      };
    }
    return { get: (_k: string, d?: unknown) => d };
  });
}

/** Stash + restore `vscode.lm` so tests can exercise the "host has no LM API" branch. */
function withoutLanguageModelApi<T>(fn: () => T): T {
  const lmBackup = (vscode as unknown as { lm?: unknown }).lm;
  (vscode as unknown as { lm?: unknown }).lm = undefined;
  try {
    return fn();
  } finally {
    (vscode as unknown as { lm?: unknown }).lm = lmBackup;
  }
}

function makeDiag(
  code: string,
  source = 'CDK-NAG',
  line = 10,
  msg = 'rule finding'
): vscode.Diagnostic {
  const range = new vscode.Range(line, 0, line, 20);
  const d = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
  d.source = source;
  d.code = code;
  return d;
}

function makeDocument(line = 10, leading = '      '): vscode.TextDocument {
  return {
    uri: vscode.Uri.file('/ws/src/stack.ts'),
    fileName: '/ws/src/stack.ts',
    lineAt: jest.fn((l: number) => ({
      text: l === line ? `${leading}new Bucket(this, 'B');` : '',
    })),
  } as unknown as vscode.TextDocument;
}

describe('CdkNagCodeActionProvider', () => {
  const provider = new CdkNagCodeActionProvider();

  beforeEach(() => {
    // Default: AI opt-in off. Individual tests flip it on.
    setAiSuggestionsEnabled(false);
  });

  it('returns both apply-fix and suppress actions when a curated fix exists', () => {
    const doc = makeDocument();
    const diag = makeDiag('AwsSolutions-S1');
    const actions = provider.provideCodeActions(doc, diag.range, {
      diagnostics: [diag],
      triggerKind: 1,
      only: undefined,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(actions).toHaveLength(2);
    const titles = actions.map(a => a.title);
    expect(titles[0]).toMatch(/Apply suggested fix \(AwsSolutions-S1\)/);
    expect(titles[1]).toMatch(/Suppress "AwsSolutions-S1"/);

    // Apply action inserts a comment block above the flagged line.
    const edit = actions[0].edit!;
    expect(edit).toBeDefined();
    const insert = (edit as unknown as { edits: Array<{ text: string }> }).edits[0];
    expect(insert.text).toContain('CDK-NAG fix for AwsSolutions-S1');
    expect(insert.text).toContain('serverAccessLogsBucket');
    // Leading indentation should be preserved from the diagnostic line.
    expect(insert.text.startsWith('      ')).toBe(true);
  });

  it('returns only a suppress action when no curated fix exists', () => {
    const doc = makeDocument();
    const diag = makeDiag('AwsSolutions-XYZ-NotCurated');
    const actions = provider.provideCodeActions(doc, diag.range, {
      diagnostics: [diag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(actions).toHaveLength(1);
    expect(actions[0].title).toMatch(/Suppress/);
  });

  it('ignores diagnostics whose source is not CDK-NAG', () => {
    const doc = makeDocument();
    const eslintDiag = makeDiag('no-unused-vars', 'eslint');
    const tsDiag = makeDiag('2322', 'ts');
    const actions = provider.provideCodeActions(doc, eslintDiag.range, {
      diagnostics: [eslintDiag, tsDiag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];
    expect(actions).toEqual([]);
  });

  it('suppress action invokes the suppressFinding command with payload', () => {
    const doc = makeDocument();
    const diag = makeDiag('AwsSolutions-EC23');
    const actions = provider.provideCodeActions(doc, diag.range, {
      diagnostics: [diag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    const suppressAction = actions.find(a => a.title.includes('Suppress'))!;
    expect(suppressAction.command?.command).toBe(SUPPRESS_COMMAND_ID);
    const payload = suppressAction.command?.arguments?.[0] as {
      ruleId: string;
      uri: string;
      message: string;
    };
    expect(payload.ruleId).toBe('AwsSolutions-EC23');
    expect(payload.uri).toContain('/ws/src/stack.ts');
  });

  it('handles multiple CDK-NAG diagnostics in a single context', () => {
    const doc = makeDocument();
    const diags = [makeDiag('AwsSolutions-S1'), makeDiag('AwsSolutions-EC23')];
    const actions = provider.provideCodeActions(doc, diags[0].range, {
      diagnostics: diags,
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    // 2 apply-fix + 2 suppress = 4 actions.
    expect(actions).toHaveLength(4);
    const ruleIds = actions.map(a => (a.title.includes('AwsSolutions-S1') ? 'S1' : 'EC23'));
    expect(ruleIds.filter(r => r === 'S1')).toHaveLength(2);
    expect(ruleIds.filter(r => r === 'EC23')).toHaveLength(2);
  });

  it('skips diagnostics with no code (cannot determine rule ID)', () => {
    const doc = makeDocument();
    const range = new vscode.Range(10, 0, 10, 20);
    const diag = new vscode.Diagnostic(range, 'mystery', vscode.DiagnosticSeverity.Error);
    diag.source = 'CDK-NAG';
    // No `code` set.
    const actions = provider.provideCodeActions(doc, range, {
      diagnostics: [diag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(actions).toEqual([]);
  });
});

/**
 * AI-assisted fix quick-fix — gated on three conditions, all of which must
 * be true simultaneously:
 *   (a) `cdkNagValidator.enableAiSuggestions` === true
 *   (b) `vscode.lm.selectChatModels` exists at runtime
 *   (c) the rule id has NO curated static fix in RULE_DOCS
 *
 * We test each gate independently so a regression in any one of them fails
 * with a clear symptom instead of a vague "why did this AI prompt appear".
 */
describe('CdkNagCodeActionProvider — AI-assisted fix branch', () => {
  const provider = new CdkNagCodeActionProvider();

  beforeEach(() => {
    setAiSuggestionsEnabled(false);
  });

  it('does NOT surface the Ask-Copilot action when enableAiSuggestions is false', () => {
    setAiSuggestionsEnabled(false);
    const doc = makeDocument();
    // Uncurated rule so the curated-fix branch is out of the picture; the
    // AI branch is the only way an AI action could appear here.
    const diag = makeDiag('AwsSolutions-XYZ-NotCurated');
    const actions = provider.provideCodeActions(doc, diag.range, {
      diagnostics: [diag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(actions.some(a => a.command?.command === ASK_COPILOT_COMMAND_ID)).toBe(false);
    // Only the Suppress action should remain.
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toMatch(/Suppress/);
  });

  it('does NOT surface the Ask-Copilot action when vscode.lm is undefined (host without LM API)', () => {
    setAiSuggestionsEnabled(true);
    const doc = makeDocument();
    const diag = makeDiag('AwsSolutions-XYZ-NotCurated');

    const actions = withoutLanguageModelApi(
      () =>
        provider.provideCodeActions(doc, diag.range, {
          diagnostics: [diag],
          triggerKind: 1,
        } as unknown as vscode.CodeActionContext) as vscode.CodeAction[]
    );

    expect(actions.some(a => a.command?.command === ASK_COPILOT_COMMAND_ID)).toBe(false);
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toMatch(/Suppress/);
  });

  it('surfaces the Ask-Copilot action when enabled AND host has LM API AND rule is uncurated', () => {
    setAiSuggestionsEnabled(true);
    const doc = makeDocument();
    const diag = makeDiag('AwsSolutions-XYZ-NotCurated', 'CDK-NAG', 10, 'uncurated finding');

    const actions = provider.provideCodeActions(doc, diag.range, {
      diagnostics: [diag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    const aiAction = actions.find(a => a.command?.command === ASK_COPILOT_COMMAND_ID);
    expect(aiAction).toBeDefined();
    expect(aiAction!.title).toMatch(/Ask Copilot to suggest a fix \(AwsSolutions-XYZ-NotCurated\)/);

    const payload = aiAction!.command?.arguments?.[0] as {
      ruleId: string;
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      message: string;
    };
    expect(payload.ruleId).toBe('AwsSolutions-XYZ-NotCurated');
    expect(payload.uri).toContain('/ws/src/stack.ts');
    expect(payload.range.start).toEqual({ line: 10, character: 0 });
    expect(payload.range.end).toEqual({ line: 10, character: 20 });
    expect(payload.message).toBe('uncurated finding');

    // Suppress action still present — AI + suppress, but NOT apply-fix.
    expect(actions.some(a => a.title.includes('Suppress'))).toBe(true);
    expect(actions.some(a => a.title.includes('Apply suggested fix'))).toBe(false);
  });

  it('prefers the curated static fix over the AI action even when AI is enabled', () => {
    // Mutual exclusion: if we have a deterministic local remediation, we
    // never prompt the user to spend a round-trip on Copilot for it.
    setAiSuggestionsEnabled(true);
    const doc = makeDocument();
    const diag = makeDiag('AwsSolutions-S1'); // curated

    const actions = provider.provideCodeActions(doc, diag.range, {
      diagnostics: [diag],
      triggerKind: 1,
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(actions.some(a => a.title.includes('Apply suggested fix'))).toBe(true);
    expect(actions.some(a => a.command?.command === ASK_COPILOT_COMMAND_ID)).toBe(false);
    // Apply-fix + Suppress = 2 actions, no AI action.
    expect(actions).toHaveLength(2);
  });
});
