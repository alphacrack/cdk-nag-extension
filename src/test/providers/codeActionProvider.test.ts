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
