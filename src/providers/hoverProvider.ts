// Shows the curated RULE_DOCS entry as a hover tooltip when the cursor is
// over a CDK-NAG diagnostic. Falls back to the diagnostic message when we
// have no curated doc — preserving the default VS Code behaviour rather
// than blanking the tooltip.

import * as vscode from 'vscode';
import { lookupRuleDoc } from '../ruleDocs';
import { CDK_NAG_DIAGNOSTIC_SOURCE } from './codeActionProvider';

export class CdkNagHoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const diagnostics = vscode.languages
      .getDiagnostics(document.uri)
      .filter(d => d.source === CDK_NAG_DIAGNOSTIC_SOURCE && d.range.contains(position));

    if (diagnostics.length === 0) return undefined;

    // Sort so the most specific (smallest) range wins when multiple overlap.
    diagnostics.sort(
      (a, b) =>
        rangeSize(a.range) - rangeSize(b.range) ||
        String(a.code ?? '').localeCompare(String(b.code ?? ''))
    );

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.supportThemeIcons = true;

    for (const diag of diagnostics) {
      const ruleId = typeof diag.code === 'string' ? diag.code : undefined;
      const doc = ruleId ? lookupRuleDoc(ruleId) : undefined;

      md.appendMarkdown(`**CDK-NAG** — \`${ruleId ?? 'unknown rule'}\`\n\n`);
      if (doc) {
        md.appendMarkdown(`**${escapeMarkdown(doc.name)}** (${doc.severity})\n\n`);
        md.appendMarkdown(`${escapeMarkdown(doc.description)}\n\n`);
        if (doc.fix) {
          md.appendMarkdown('_Suggested remediation:_\n\n');
          md.appendCodeblock(doc.fix, 'typescript');
        }
        if (doc.docUrl) {
          md.appendMarkdown(`\n[Read the cdk-nag rule documentation](${doc.docUrl})`);
        }
      } else {
        md.appendMarkdown(`${escapeMarkdown(diag.message)}\n\n`);
        md.appendMarkdown(
          '_No curated documentation for this rule yet — consult the [cdk-nag RULES.md](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md)._'
        );
      }

      md.appendMarkdown('\n\n---\n\n');
    }

    // Use the intersection of all diagnostic ranges at this position so the
    // hover highlight shrinks to the deepest diagnostic.
    const hoverRange = diagnostics[0].range;
    return new vscode.Hover(md, hoverRange);
  }
}

function rangeSize(r: vscode.Range): number {
  return (r.end.line - r.start.line) * 1000 + (r.end.character - r.start.character);
}

function escapeMarkdown(input: string): string {
  return input.replace(/([\\`*_{}[\]()#+\-!])/g, '\\$1');
}
