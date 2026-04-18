// Language Model Tool: `cdkNag_explainRule`.
//
// Pure, side-effect-free lookup against the curated `ruleDocs` map (the same
// source of truth the HoverProvider and CodeActionProvider already consume).
// The tool surface is declared in `package.json > contributes.languageModelTools`
// and registered in `extension.ts:activate` via `vscode.lm.registerTool`.
//
// Why a tool in addition to the HoverProvider?
//   • Copilot agent mode (and user prompts using `#cdkNagExplainRule`) can fan
//     out an arbitrary rule id without needing a diagnostic on disk.
//   • The chat participant in `src/chat/participant.ts` delegates the
//     "explain X" intent to this tool so the rule description, severity,
//     remediation snippet, and documentation link are all returned as
//     structured `LanguageModelTextPart`s that the LLM can cite verbatim.
//
// Design notes:
//   • `prepareInvocation` is free of side effects — returns just the message
//     shown in the chat progress pill. No file I/O, no network, no config
//     read, per the Language Model Tool contract.
//   • `invoke` validates the `ruleId` input (tools can technically be called
//     with the wrong shape if the package-declared schema is ignored) and
//     returns a diagnostic message rather than throwing on missing input —
//     the LLM is better at recovering from a human-readable error than from
//     an exception bubbling through `vscode.lm.invokeTool`.
//   • Result shape: an array of `LanguageModelTextPart`s. The first part is
//     a concise one-line summary (useful when the LLM is token-starved), the
//     second is a code block with the remediation snippet (only when
//     available), and the third is a trailing docs link.

import * as vscode from 'vscode';
import { lookupRuleDoc, type RuleDoc } from '../ruleDocs';

/** Name of the tool as declared in `package.json`. */
export const EXPLAIN_RULE_TOOL_NAME = 'cdkNag_explainRule';

/** Input schema — mirrors the JSON schema declared in `package.json`. */
export interface ExplainRuleToolInput {
  /** cdk-nag rule id, e.g. `AwsSolutions-S1`. */
  ruleId: string;
}

/**
 * Render a `RuleDoc` as Markdown the LLM can quote back to the user.
 * Exported so tests can assert on the formatting without invoking the tool.
 */
export function renderRuleDocMarkdown(ruleId: string, doc: RuleDoc): string {
  const severityLabel = doc.severity.toUpperCase();
  const lines: string[] = [];
  lines.push(`**${ruleId} — ${doc.name}** (${severityLabel})`);
  lines.push('');
  lines.push(doc.description);
  if (doc.fix) {
    lines.push('');
    lines.push('**Remediation**:');
    lines.push('');
    lines.push('```typescript');
    lines.push(doc.fix);
    lines.push('```');
  }
  if (doc.docUrl) {
    lines.push('');
    lines.push(`[Upstream cdk-nag rule documentation](${doc.docUrl})`);
  }
  return lines.join('\n');
}

/**
 * The `cdkNag_explainRule` tool — a pure lookup against `ruleDocs.ts` with
 * graceful handling of unknown / malformed inputs.
 */
export class ExplainRuleTool implements vscode.LanguageModelTool<ExplainRuleToolInput> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ExplainRuleToolInput>
  ): vscode.PreparedToolInvocation {
    const ruleId = options.input?.ruleId?.trim();
    return {
      invocationMessage: ruleId
        ? `Looking up cdk-nag rule "${ruleId}"…`
        : 'Looking up cdk-nag rule…',
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ExplainRuleToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const rawRuleId = options.input?.ruleId;
    if (typeof rawRuleId !== 'string' || rawRuleId.trim().length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'cdkNag_explainRule: the `ruleId` input is required ' +
            '(e.g. "AwsSolutions-S1"). No rule id was supplied.'
        ),
      ]);
    }
    const ruleId = rawRuleId.trim();

    const doc = lookupRuleDoc(ruleId);
    if (!doc) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `cdkNag_explainRule: no curated documentation found for "${ruleId}". ` +
            'The rule may still be valid — see https://github.com/cdklabs/cdk-nag/blob/main/RULES.md ' +
            'for the upstream rule list.'
        ),
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(renderRuleDocMarkdown(ruleId, doc)),
    ]);
  }
}
