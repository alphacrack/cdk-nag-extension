// Surfaces CDK-NAG finding remediations as lightbulb quick-fixes.
//
// For every diagnostic whose `source === 'CDK-NAG'` we provide up to three
// actions:
//   1. "Apply suggested fix" — inserts the curated snippet from RULE_DOCS as
//      a comment block above the construct so the user can hand-merge it
//      into their construct options. We intentionally do NOT auto-edit the
//      construct — the snippet shape rarely matches the existing code 1:1
//      and a silent overwrite is the most hostile possible UX for security
//      tooling. Show-then-paste is strictly better.
//   2. "Ask Copilot to suggest a fix" — opt-in AI-assisted remediation
//      (PR 7). Surfaces only when (a) `cdkNagValidator.enableAiSuggestions`
//      is true AND (b) the curated RULE_DOCS has NO static fix for this
//      rule id (we prefer deterministic local snippets when we have them)
//      AND (c) the host has `vscode.lm` (older VS Code / non-Copilot
//      forks fall through silently). Delegates the actual send-snippet-to-
//      Copilot flow to the `cdk-nag-validator.askCopilotForFix` command
//      (src/ai/suggestFix.ts) so the provider stays stateless.
//   3. "Suppress this finding" — delegates to the
//      `cdk-nag-validator.suppressFinding` command (registered in
//      extension.ts) which persists the rule ID to `.vscode/cdk-nag-config.json`.

import * as vscode from 'vscode';
import { lookupRuleFix, lookupRuleDoc } from '../ruleDocs';
import { ASK_COPILOT_COMMAND_ID } from '../ai/suggestFix';

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

    // Pull the AI opt-in + runtime LM availability once per call — this
    // avoids re-reading settings on every diagnostic in a multi-finding batch.
    const aiEnabled = isAiSuggestionsEnabled();
    const aiHostAvailable = isLanguageModelApiAvailable();

    for (const diagnostic of cdkNagDiagnostics) {
      const ruleId = typeof diagnostic.code === 'string' ? diagnostic.code : undefined;
      if (!ruleId) continue;

      const fixSnippet = lookupRuleFix(ruleId);
      if (fixSnippet) {
        actions.push(buildApplyFixAction(document, diagnostic, ruleId, fixSnippet));
      } else if (aiEnabled && aiHostAvailable) {
        // Only offer the AI escape hatch when we don't have a deterministic
        // remediation. Mixing the two would confuse users — they'd wonder
        // whether the curated fix or the AI fix is "more correct".
        actions.push(buildAskCopilotAction(document, diagnostic, ruleId));
      }

      actions.push(buildSuppressAction(document, diagnostic, ruleId));
    }

    return actions;
  }
}

/** Exposed for tests — each call re-reads settings so toggles take effect immediately. */
export function isAiSuggestionsEnabled(): boolean {
  try {
    return (
      vscode.workspace
        .getConfiguration('cdkNagValidator')
        .get<boolean>('enableAiSuggestions', false) === true
    );
  } catch {
    return false;
  }
}

/** Exposed for tests — mirrors the runtime gate used by `src/ai/suggestFix.ts`. */
export function isLanguageModelApiAvailable(): boolean {
  const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
  return !!lm && typeof lm.selectChatModels === 'function';
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
 * Build the "Ask Copilot to suggest a fix (<ruleId>)" action. Pure-command
 * dispatch — all the heavy lifting (consent, scrub, LM call, preview edit)
 * runs inside the `cdk-nag-validator.askCopilotForFix` command handler in
 * extension.ts, which has the ExtensionContext for globalState-backed
 * consent. The payload is JSON-serialisable so VS Code can round-trip it
 * through the command registry.
 */
function buildAskCopilotAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  ruleId: string
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    `CDK NAG: Ask Copilot to suggest a fix (${ruleId})`,
    vscode.CodeActionKind.QuickFix
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: ASK_COPILOT_COMMAND_ID,
    title: 'Ask Copilot to suggest a fix',
    arguments: [
      {
        ruleId,
        uri: document.uri.toString(),
        range: {
          start: {
            line: diagnostic.range.start.line,
            character: diagnostic.range.start.character,
          },
          end: {
            line: diagnostic.range.end.line,
            character: diagnostic.range.end.character,
          },
        },
        message: diagnostic.message,
      },
    ],
  };
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
