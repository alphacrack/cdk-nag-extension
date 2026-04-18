/**
 * Jest tests for the `cdkNag_validateFile` Language Model Tool.
 *
 * What we lock down:
 *   • `prepareInvocation` surfaces the file name / workspace in the
 *     progress pill and asks for confirmation (this is a side-effectful
 *     tool — must gate on user consent).
 *   • `resolveValidationTarget` handles the matrix: absolute path,
 *     relative path, no path + active editor, no path + no editor, no
 *     workspace at all.
 *   • `invoke` returns a Markdown summary with counts-by-severity when
 *     `runCdkNagValidation` yields findings; cites "No findings" when
 *     clean.
 *   • `invoke` returns a cancellation text part rather than throwing when
 *     the underlying pipeline throws `ValidationCancelledError`.
 *   • `invoke` returns a descriptive error-text part rather than throwing
 *     when the pipeline throws a generic `Error`.
 *   • The rule-pack override is threaded through to the orchestrator.
 *
 * We mock `runCdkNagValidation` to avoid shelling out to the real CDK CLI.
 */

import * as vscode from 'vscode';

// Must be before the module-under-test is imported.
jest.mock('../../runValidation', () => {
  const actual = jest.requireActual('../../runValidation');
  return {
    ...actual,
    runCdkNagValidation: jest.fn(),
  };
});

import { runCdkNagValidation, type CdkNagFinding } from '../../runValidation';
import { ValidationCancelledError } from '../../runner';
import {
  ValidateFileTool,
  VALIDATE_FILE_TOOL_NAME,
  resolveValidationTarget,
  renderFindingsMarkdown,
} from '../../tools/validateFileTool';

const mockedRun = runCdkNagValidation as unknown as jest.Mock;

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

function finding(id: string, level: string, resourceId: string): CdkNagFinding {
  return {
    id,
    name: id,
    description: `Description for ${id}`,
    level,
    resourceId,
  };
}

beforeEach(() => {
  mockedRun.mockReset();
  (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = [
    {
      uri: vscode.Uri.file('/ws'),
      name: 'ws',
      index: 0,
    },
  ];
  (vscode.workspace.getWorkspaceFolder as unknown as jest.Mock).mockReturnValue({
    uri: vscode.Uri.file('/ws'),
    name: 'ws',
    index: 0,
  });
  (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
});

describe('VALIDATE_FILE_TOOL_NAME', () => {
  it('matches the name declared in package.json', () => {
    expect(VALIDATE_FILE_TOOL_NAME).toBe('cdkNag_validateFile');
  });
});

describe('resolveValidationTarget', () => {
  it('resolves an absolute path under the workspace', () => {
    const resolved = resolveValidationTarget({ uri: '/ws/src/stack.ts' });
    expect(typeof resolved).not.toBe('string');
    if (typeof resolved !== 'string') {
      expect(resolved.workspacePath).toBe('/ws');
      expect(resolved.workspaceRelativePath).toBe('src/stack.ts');
      expect(resolved.displayName).toBe('stack.ts');
    }
  });

  it('resolves a relative path against the first workspace folder', () => {
    const resolved = resolveValidationTarget({ uri: 'src/other.ts' });
    expect(typeof resolved).not.toBe('string');
    if (typeof resolved !== 'string') {
      expect(resolved.workspacePath).toBe('/ws');
      expect(resolved.displayName).toBe('other.ts');
    }
  });

  it('falls back to the active editor when no uri is supplied', () => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
      document: {
        uri: vscode.Uri.file('/ws/src/active.ts'),
        fileName: '/ws/src/active.ts',
      },
    };
    const resolved = resolveValidationTarget({});
    expect(typeof resolved).not.toBe('string');
    if (typeof resolved !== 'string') {
      expect(resolved.displayName).toBe('active.ts');
    }
  });

  it('falls back to the workspace folder when no uri and no editor', () => {
    const resolved = resolveValidationTarget({});
    expect(typeof resolved).not.toBe('string');
    if (typeof resolved !== 'string') {
      expect(resolved.workspacePath).toBe('/ws');
      expect(resolved.workspaceRelativePath).toBeUndefined();
      expect(resolved.displayName).toBe('ws');
    }
  });

  it('returns a descriptive error when no workspace is open', () => {
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = [];
    (vscode.workspace.getWorkspaceFolder as unknown as jest.Mock).mockReturnValue(undefined);
    const resolved = resolveValidationTarget({});
    expect(typeof resolved).toBe('string');
    expect(resolved as string).toMatch(/no workspace folder/i);
  });

  it('returns a descriptive error when given a relative path but no workspace', () => {
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = [];
    (vscode.workspace.getWorkspaceFolder as unknown as jest.Mock).mockReturnValue(undefined);
    const resolved = resolveValidationTarget({ uri: 'src/stack.ts' });
    expect(typeof resolved).toBe('string');
    expect(resolved as string).toMatch(/no workspace folder/i);
  });
});

describe('ValidateFileTool.prepareInvocation', () => {
  const tool = new ValidateFileTool();

  it('includes the target name in the invocation message', () => {
    const prep = tool.prepareInvocation({
      input: { uri: '/ws/src/stack.ts' },
    });
    expect((prep as vscode.PreparedToolInvocation).invocationMessage).toContain('stack.ts');
  });

  it('lists the rule-pack override in the invocation message', () => {
    const prep = tool.prepareInvocation({
      input: { uri: '/ws/src/stack.ts', rulePacks: ['HIPAA.SecurityChecks'] },
    });
    expect((prep as vscode.PreparedToolInvocation).invocationMessage).toContain(
      'HIPAA.SecurityChecks'
    );
  });

  it('requests user confirmation (tool has side effects)', () => {
    const prep = tool.prepareInvocation({ input: {} });
    expect((prep as vscode.PreparedToolInvocation).confirmationMessages).toBeDefined();
    expect((prep as vscode.PreparedToolInvocation).confirmationMessages?.title).toBeTruthy();
  });
});

describe('ValidateFileTool.invoke', () => {
  const tool = new ValidateFileTool();

  it('returns a "No findings" report when the pipeline yields nothing', async () => {
    mockedRun.mockResolvedValue([]);
    const result = await tool.invoke(
      {
        input: { uri: '/ws/src/stack.ts' },
        toolInvocationToken: undefined,
      },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toMatch(/no findings/i);
    expect(mockedRun).toHaveBeenCalledWith('/ws', expect.objectContaining({ token: NOOP_TOKEN }));
  });

  it('summarises findings with severity counts', async () => {
    mockedRun.mockResolvedValue([
      finding('AwsSolutions-S1', 'ERROR', 'Bucket1'),
      finding('AwsSolutions-S10', 'ERROR', 'Bucket1'),
      finding('AwsSolutions-IAM5', 'WARNING', 'Role1'),
      finding('AwsSolutions-CFR1', 'INFO', 'Dist1'),
    ]);
    const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, NOOP_TOKEN);
    const text = partsText(result);
    expect(text).toContain('4 findings');
    expect(text).toContain('2 errors');
    expect(text).toContain('1 warning');
    expect(text).toContain('1 info');
    expect(text).toContain('AwsSolutions-S1');
    expect(text).toContain('AwsSolutions-IAM5');
  });

  it('narrows findings to the requested file when the basename matches resourceId', async () => {
    mockedRun.mockResolvedValue([
      finding('AwsSolutions-S1', 'ERROR', 'UnencryptedBucketXYZ'),
      finding('AwsSolutions-IAM5', 'WARNING', 'OtherRoleABC'),
    ]);
    // The file basename (without extension) is `unencryptedbucket-stack` —
    // findings whose resourceId contains the basename are kept. We choose
    // a basename that the first finding's id contains.
    const result = await tool.invoke(
      {
        input: { uri: '/ws/src/UnencryptedBucket.ts' },
        toolInvocationToken: undefined,
      },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toContain('AwsSolutions-S1');
    expect(text).not.toContain('AwsSolutions-IAM5');
  });

  it('falls back to full findings list when none match the basename', async () => {
    mockedRun.mockResolvedValue([
      finding('AwsSolutions-S1', 'ERROR', 'NeverMatches'),
      finding('AwsSolutions-IAM5', 'WARNING', 'AlsoNeverMatches'),
    ]);
    const result = await tool.invoke(
      {
        input: { uri: '/ws/src/CompletelyOther.ts' },
        toolInvocationToken: undefined,
      },
      NOOP_TOKEN
    );
    const text = partsText(result);
    expect(text).toContain('AwsSolutions-S1');
    expect(text).toContain('AwsSolutions-IAM5');
  });

  it('returns a cancellation text part when the pipeline is cancelled', async () => {
    mockedRun.mockRejectedValue(new ValidationCancelledError());
    const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, NOOP_TOKEN);
    const text = partsText(result);
    expect(text).toMatch(/cancelled/i);
  });

  it('returns an error text part when the pipeline throws', async () => {
    mockedRun.mockRejectedValue(new Error('synth exploded'));
    const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, NOOP_TOKEN);
    const text = partsText(result);
    expect(text).toMatch(/validation failed/i);
    expect(text).toMatch(/synth exploded/);
    expect(text).toMatch(/cdk\.json/);
  });

  it('threads rulePacks override through to runCdkNagValidation', async () => {
    mockedRun.mockResolvedValue([]);
    await tool.invoke(
      {
        input: { rulePacks: ['HIPAA.SecurityChecks'] },
        toolInvocationToken: undefined,
      },
      NOOP_TOKEN
    );
    expect(mockedRun).toHaveBeenCalledWith(
      '/ws',
      expect.objectContaining({
        overrides: { rulePacks: ['HIPAA.SecurityChecks'] },
      })
    );
  });

  it('returns a descriptive message when no workspace is open', async () => {
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = [];
    (vscode.workspace.getWorkspaceFolder as unknown as jest.Mock).mockReturnValue(undefined);
    const result = await tool.invoke({ input: {}, toolInvocationToken: undefined }, NOOP_TOKEN);
    const text = partsText(result);
    expect(text).toMatch(/no workspace/i);
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe('renderFindingsMarkdown', () => {
  const target = { workspacePath: '/ws', displayName: 'stack.ts' };

  it('shows empty-state copy when the list is empty', () => {
    const md = renderFindingsMarkdown([], target);
    expect(md).toMatch(/no findings/i);
  });

  it('renders rule packs when supplied', () => {
    const md = renderFindingsMarkdown([], target, ['AwsSolutionsChecks']);
    expect(md).toContain('AwsSolutionsChecks');
  });

  it('truncates above 20 entries and shows the "…and N more" line', () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      finding(`AwsSolutions-S${i + 1}`, 'ERROR', `R${i}`)
    );
    const md = renderFindingsMarkdown(many, target);
    expect(md).toContain('23 findings');
    expect(md).toContain('_…and 3 more findings._');
  });

  it('uses curated rule name when available', () => {
    const md = renderFindingsMarkdown([finding('AwsSolutions-S1', 'ERROR', 'SomeBucket')], target);
    expect(md).toContain('S3 Bucket Server Access Logging Disabled');
  });
});
