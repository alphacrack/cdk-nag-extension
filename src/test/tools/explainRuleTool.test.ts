/**
 * Jest tests for the `cdkNag_explainRule` Language Model Tool.
 *
 * What we lock down:
 *   • `prepareInvocation` returns a non-empty progress message, both when
 *     `ruleId` is present and when it's missing (the chat UI still needs a
 *     pill to show).
 *   • `invoke` rejects a missing / blank / wrong-type `ruleId` with a
 *     *helpful* text part (never throws) — the LLM recovers better from a
 *     human-readable message than from an exception bubbling up.
 *   • `invoke` returns a curated entry when one exists (exact rule id).
 *   • `invoke` falls through to the prefix-level fallback entry when the
 *     exact id is not curated.
 *   • `invoke` returns a "no docs found" text part when the id matches no
 *     curated or prefix entry — should still succeed and cite the upstream
 *     RULES.md.
 *   • `renderRuleDocMarkdown` formatting is stable (severity uppercased,
 *     remediation inside a typescript code block, doc url at the tail).
 */

import * as vscode from 'vscode';
import {
  ExplainRuleTool,
  EXPLAIN_RULE_TOOL_NAME,
  renderRuleDocMarkdown,
} from '../../tools/explainRuleTool';

function partsText(result: vscode.LanguageModelToolResult): string {
  return result.content
    .map(p => {
      const v = (p as { value?: unknown }).value;
      return typeof v === 'string' ? v : '';
    })
    .join('\n');
}

const NOOP_TOKEN: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: jest.fn(),
} as unknown as vscode.CancellationToken;

describe('EXPLAIN_RULE_TOOL_NAME', () => {
  it('matches the name declared in package.json', () => {
    expect(EXPLAIN_RULE_TOOL_NAME).toBe('cdkNag_explainRule');
  });
});

describe('ExplainRuleTool.prepareInvocation', () => {
  const tool = new ExplainRuleTool();

  it('returns a specific message when ruleId is present', () => {
    const prep = tool.prepareInvocation({ input: { ruleId: 'AwsSolutions-S1' } });
    expect(prep).toBeDefined();
    expect((prep as vscode.PreparedToolInvocation).invocationMessage).toContain('AwsSolutions-S1');
  });

  it('returns a generic message when ruleId is missing', () => {
    const prep = tool.prepareInvocation({ input: {} as { ruleId: string } });
    expect(prep).toBeDefined();
    expect((prep as vscode.PreparedToolInvocation).invocationMessage).toBeTruthy();
  });
});

describe('ExplainRuleTool.invoke — input validation', () => {
  const tool = new ExplainRuleTool();

  it('returns a helpful message when ruleId is missing', async () => {
    const result = await tool.invoke(
      { input: {} as { ruleId: string }, toolInvocationToken: undefined },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toMatch(/ruleId/i);
    expect(text).toMatch(/required/i);
  });

  it('returns a helpful message when ruleId is an empty string', async () => {
    const result = await tool.invoke(
      { input: { ruleId: '   ' }, toolInvocationToken: undefined },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toMatch(/required/i);
  });

  it('returns a helpful message when ruleId is not a string', async () => {
    const result = await tool.invoke(
      {
        input: { ruleId: 123 as unknown as string },
        toolInvocationToken: undefined,
      },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toMatch(/required/i);
  });
});

describe('ExplainRuleTool.invoke — lookup paths', () => {
  const tool = new ExplainRuleTool();

  it('renders the curated entry for an exact rule id', async () => {
    const result = await tool.invoke(
      { input: { ruleId: 'AwsSolutions-S1' }, toolInvocationToken: undefined },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toContain('AwsSolutions-S1');
    expect(text).toContain('S3 Bucket Server Access Logging Disabled');
    expect(text).toContain('**Remediation**');
    expect(text).toContain('```typescript');
    expect(text).toContain('cdk-nag/blob/main/RULES.md');
  });

  it('renders a prefix-level fallback for an uncurated AwsSolutions- rule', async () => {
    const result = await tool.invoke(
      {
        input: { ruleId: 'AwsSolutions-UnknownRule999' },
        toolInvocationToken: undefined,
      },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toContain('AwsSolutions-UnknownRule999');
    expect(text).toMatch(/AWS Solutions/i);
  });

  it('returns a "no docs found" message for an unknown-prefix rule id', async () => {
    const result = await tool.invoke(
      { input: { ruleId: 'Custom-DoesNotExist' }, toolInvocationToken: undefined },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toMatch(/no curated documentation/i);
    expect(text).toContain('cdk-nag/blob/main/RULES.md');
  });

  it('trims surrounding whitespace before lookup', async () => {
    const result = await tool.invoke(
      { input: { ruleId: '  AwsSolutions-S1  ' }, toolInvocationToken: undefined },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toContain('S3 Bucket Server Access Logging Disabled');
  });
});

describe('renderRuleDocMarkdown', () => {
  it('includes severity (uppercased) and description on the first lines', () => {
    const md = renderRuleDocMarkdown('FAKE-1', {
      name: 'Fake Rule',
      description: 'Does fake things.',
      severity: 'warning',
    });
    expect(md.split('\n')[0]).toContain('FAKE-1');
    expect(md.split('\n')[0]).toContain('WARNING');
    expect(md).toContain('Does fake things.');
  });

  it('wraps the fix snippet in a typescript code block when present', () => {
    const md = renderRuleDocMarkdown('FAKE-2', {
      name: 'Fake',
      description: 'f',
      severity: 'error',
      fix: "new s3.Bucket(this, 'b');",
    });
    expect(md).toContain('```typescript');
    expect(md).toContain("new s3.Bucket(this, 'b');");
  });

  it('omits the remediation block when no fix is curated', () => {
    const md = renderRuleDocMarkdown('FAKE-3', {
      name: 'Fake',
      description: 'f',
      severity: 'info',
    });
    expect(md).not.toContain('Remediation');
    expect(md).not.toContain('```typescript');
  });

  it('appends a trailing documentation link when a url is supplied', () => {
    const md = renderRuleDocMarkdown('FAKE-4', {
      name: 'Fake',
      description: 'f',
      severity: 'info',
      docUrl: 'https://example.com/rule',
    });
    expect(md).toContain('[Upstream cdk-nag rule documentation](https://example.com/rule)');
  });
});
