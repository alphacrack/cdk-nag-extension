/**
 * Jest tests for the CDK-NAG HoverProvider.
 *
 * Verifies:
 *   • Hover only fires when the cursor is inside a CDK-NAG diagnostic range.
 *   • Curated rules render their name, description, fix snippet, and doc link.
 *   • Uncurated rule IDs fall back to the diagnostic message + generic pointer.
 *   • Non-CDK-NAG diagnostics at the same position are ignored.
 */

import * as vscode from 'vscode';
import { CdkNagHoverProvider } from '../../providers/hoverProvider';

function setDiagnosticsAt(diagnostics: vscode.Diagnostic[]): void {
  (vscode.languages.getDiagnostics as unknown as jest.Mock).mockReturnValue(diagnostics);
}

function makeDiag(
  code: string,
  source: string,
  range: vscode.Range,
  message: string
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
  d.source = source;
  d.code = code;
  return d;
}

describe('CdkNagHoverProvider', () => {
  const provider = new CdkNagHoverProvider();
  const document = { uri: vscode.Uri.file('/ws/src/stack.ts') } as unknown as vscode.TextDocument;

  beforeEach(() => {
    (vscode.languages.getDiagnostics as unknown as jest.Mock).mockReset();
  });

  it('returns undefined when no CDK-NAG diagnostic contains the position', () => {
    setDiagnosticsAt([]);
    const result = provider.provideHover(document, new vscode.Position(5, 2));
    expect(result).toBeUndefined();
  });

  it('renders curated rule metadata for a matched diagnostic', () => {
    const range = new vscode.Range(10, 4, 12, 30);
    setDiagnosticsAt([makeDiag('AwsSolutions-EC23', 'CDK-NAG', range, 'ingress unrestricted')]);

    const hover = provider.provideHover(document, new vscode.Position(11, 10)) as vscode.Hover;
    expect(hover).toBeDefined();
    const md = hover.contents as unknown as vscode.MarkdownString;
    expect(md.value).toContain('AwsSolutions-EC23');
    expect(md.value).toContain('Security Group Inbound Access Unrestricted');
    // Fix snippet rendered inside a typescript code block.
    expect(md.value).toContain('```typescript');
    expect(md.value).toContain('sg.addIngressRule');
    // Doc URL.
    expect(md.value).toContain('cdk-nag/blob/main/RULES.md');
  });

  it('falls back gracefully for uncurated rule IDs', () => {
    const range = new vscode.Range(10, 0, 10, 20);
    setDiagnosticsAt([makeDiag('AwsSolutions-ZZ99', 'CDK-NAG', range, 'some obscure finding')]);

    const hover = provider.provideHover(document, new vscode.Position(10, 5)) as vscode.Hover;
    expect(hover).toBeDefined();
    const md = hover.contents as unknown as vscode.MarkdownString;
    // Prefix-level fallback kicks in — generic name.
    expect(md.value).toContain('AwsSolutions-ZZ99');
    expect(md.value).toContain('AWS Solutions Rule');
  });

  it('ignores non-CDK-NAG diagnostics at the same position', () => {
    const range = new vscode.Range(10, 0, 10, 20);
    setDiagnosticsAt([
      makeDiag('2322', 'ts', range, 'type mismatch'),
      makeDiag('no-unused', 'eslint', range, 'unused var'),
    ]);

    const hover = provider.provideHover(document, new vscode.Position(10, 5));
    expect(hover).toBeUndefined();
  });

  it('merges multiple CDK-NAG diagnostics at the same position', () => {
    const range = new vscode.Range(10, 0, 10, 20);
    setDiagnosticsAt([
      makeDiag('AwsSolutions-S1', 'CDK-NAG', range, 'no access logs'),
      makeDiag('AwsSolutions-S10', 'CDK-NAG', range, 'no ssl'),
    ]);

    const hover = provider.provideHover(document, new vscode.Position(10, 5)) as vscode.Hover;
    expect(hover).toBeDefined();
    const md = hover.contents as unknown as vscode.MarkdownString;
    expect(md.value).toContain('AwsSolutions-S1');
    expect(md.value).toContain('AwsSolutions-S10');
  });
});
