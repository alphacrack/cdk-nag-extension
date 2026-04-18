// Surfaces CDK-NAG finding remediations as lightbulb quick-fixes.
//
// For every diagnostic whose `source === 'CDK-NAG'` we provide up to two
// actions:
//   1. "Apply suggested fix" — inserts the curated snippet from RULE_DOCS as
//      a comment block above the construct so the user can hand-merge it
//      into their construct options. We intentionally do NOT auto-edit the
//      construct — the snippet shape rarely matches the existing code 1:1
//      and a silent overwrite is the most hostile possible UX for security
//      tooling. Show-then-paste is strictly better.
//   2. "Suppress this finding" — delegates to the `cdk-nag-validator.suppressFinding`
//      command (registered in extension.ts) which persists the rule ID to
//      `.vscode/cdk-nag-config.json`.

import * as vscode from 'vscode';
import { lookupRuleFix, lookupRuleDoc } from '../ruleDocs';

export const CDK_NAG_DIAGNOSTIC_SOURCE = 'CDK-NAG';
export const SUPPRESS_COMMAND_ID = 'cdk-nag-validator.suppressFinding';

export class CdkNagCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.ProviderResult<Array<vscode.CodeAction>> {
    const actions: vscode.CodeAction[] = [];

    const cdkNagDiagnostics = context.diagnostics.filter(
      d => d.source === CDK_NAG_DIAGNOSTIC_SOURCE
    );

    for (const diagnostic of cdkNagDiagnostics) {
      const ruleId = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
      if (!ruleId) continue;

      const fixSnippet = lookupRuleFix(ruleId);
      if (fixSnippet) {
        actions.push(buildApplyFixAction(document, diagnostic, ruleId, fixSnippet));
      }

      actions.push(buildSuppressAction(document, diagnostic, ruleId));
    }

    return actions;
  }
}

/**
 * Build the "Apply suggested fix (<ruleId>)" action. Inserts the curated
 * snippet as a comment block directly above the flagged construct. The user
 * gets a clearly-marked reference they can hand-merge — we never silently
 * rewrite their code.
 */
function buildApplyFixAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  ruleId: string,
  fixSnippet: string
): vscode.CodeAction {
  const doc = lookupRuleDoc(ruleId);
  const title = `CDK NAG: Apply suggested fix (${ruleId})`;

  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  const insertLine = diagnostic.range.start.line;
  const leadingWhitespace = document.lineAt(insertLine).text.match(/^\s*/)?.[0] ?? '';

  const header = `// CDK-NAG fix for ${ruleId}${doc ? ` — ${doc.name}` : ''}:`;
  const body = fixSnippet
    .split('\n')
    .map(line => `${leadingWhitespace}// ${line}`)
    .join('\n');
  const block = `${leadingWhitespace}${header}\n${body}\n`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(insertLine, 0), block);
  action.edit = edit;

  return action;
}

/**
 * Build the "Suppress this finding (<ruleId>)" action. Invokes the
 * suppressFinding command so the list of suppressed rule IDs lives in one
 * place (ConfigManager → `.vscode/cdk-nag-config.json`). Scoped to the
 * specific finding — resourceId captured in the code-action arguments.
 */
function buildSuppressAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  ruleId: string
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    `CDK NAG: Suppress "${ruleId}" for this workspace`,
    vscode.CodeActionKind.QuickFix
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: SUPPRESS_COMMAND_ID,
    title: 'Suppress CDK-NAG finding',
    arguments: [
      {
        ruleId,
        uri: document.uri.toString(),
        message: diagnostic.message,
      },
    ],
  };
  return action;
}
