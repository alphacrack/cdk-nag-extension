// Language Model Tool: `cdkNag_validateFile`.
//
// Runs the full CDK-NAG validation pipeline (synth → pack application →
// runner → parsed findings) and returns a Markdown summary as a
// `LanguageModelToolResult`. The tool surface is declared in
// `package.json > contributes.languageModelTools` and is callable:
//   • Directly by Copilot agent mode (via `#cdkNagValidateFile`).
//   • From within the chat participant (`src/chat/participant.ts`) when the
//     user asks to validate a file or the current workspace.
//
// Design notes:
//   • `prepareInvocation` returns an invocation-time message and sets
//     `confirmationMessages` so the user consents before their CDK project
//     is synthesised and dependencies potentially installed (when
//     `cdkNagValidator.autoInstall` is on). Side-effects without explicit
//     consent would violate the tool contract.
//   • `invoke` resolves the workspace from either the supplied `uri` input
//     or the active editor's workspace. If neither is available the tool
//     returns a descriptive `LanguageModelTextPart` rather than throwing —
//     the LLM handles human-readable errors better than exceptions.
//   • The full findings list is both summarised (counts by severity + up to
//     20 representative entries, each with curated rule name + description)
//     and returned. Summaries keep the LLM within its token budget; the
//     raw-JSON dump is kept out because the runner can emit hundreds of
//     findings on large workspaces and blow the budget by itself.
//   • Cancellation: the `CancellationToken` is threaded through
//     `runCdkNagValidation` → `spawnRunner`, so a cancelled tool invocation
//     SIGTERMs the runner child process promptly.

import * as vscode from 'vscode';
import * as path from 'path';
import { runCdkNagValidation, type CdkNagFinding } from '../runValidation';
import { ValidationCancelledError } from '../runner';
import { lookupRuleDoc } from '../ruleDocs';

/** Name of the tool as declared in `package.json`. */
export const VALIDATE_FILE_TOOL_NAME = 'cdkNag_validateFile';

/** Input schema — mirrors the JSON schema declared in `package.json`. */
export interface ValidateFileToolInput {
  /** Absolute or workspace-relative path to a CDK source file. Optional — falls back to the active editor. */
  uri?: string;
  /** Optional override of the enabled rule packs for this invocation. */
  rulePacks?: string[];
}

/** Result of resolving an input payload to a concrete workspace + optional file. */
interface ResolvedTarget {
  workspacePath: string;
  /** Workspace-relative path of the file input, when supplied. Used to filter findings. */
  workspaceRelativePath?: string;
  /** Short display name used in progress messages. */
  displayName: string;
}

/** Resolve the input + VS Code state to a workspace path. Exported for tests. */
export function resolveValidationTarget(input: ValidateFileToolInput): ResolvedTarget | string {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const inputUri = typeof input?.uri === 'string' ? input.uri.trim() : '';

  // Case 1 — input uri supplied. Accept either an absolute path or a path
  // relative to the first workspace folder.
  if (inputUri.length > 0) {
    const absolute = path.isAbsolute(inputUri)
      ? inputUri
      : workspaceFolders[0]
      ? path.join(workspaceFolders[0].uri.fsPath, inputUri)
      : undefined;
    if (!absolute) {
      return (
        'cdkNag_validateFile: received a relative path but no workspace folder is open to ' +
        'resolve it against. Pass an absolute path or open a CDK workspace first.'
      );
    }
    const fileUri = vscode.Uri.file(absolute);
    const folder = vscode.workspace.getWorkspaceFolder(fileUri) ?? workspaceFolders[0];
    if (!folder) {
      return (
        `cdkNag_validateFile: could not locate a workspace folder containing ${absolute}. ` +
        'Open the CDK project as a workspace and try again.'
      );
    }
    return {
      workspacePath: folder.uri.fsPath,
      workspaceRelativePath: path.relative(folder.uri.fsPath, absolute),
      displayName: path.basename(absolute),
    };
  }

  // Case 2 — no uri input, fall back to the active editor.
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? workspaceFolders[0];
    if (folder) {
      return {
        workspacePath: folder.uri.fsPath,
        workspaceRelativePath: path.relative(folder.uri.fsPath, editor.document.uri.fsPath),
        displayName: path.basename(editor.document.fileName),
      };
    }
  }

  // Case 3 — no uri and no active editor; use the first workspace folder.
  if (workspaceFolders[0]) {
    return {
      workspacePath: workspaceFolders[0].uri.fsPath,
      displayName: workspaceFolders[0].name,
    };
  }

  return (
    'cdkNag_validateFile: no workspace folder is open and no file URI was supplied. ' +
    'Open a CDK project or pass an absolute path.'
  );
}

/**
 * Render the findings as a Markdown report for the tool result. Exported so
 * tests can lock the formatting independently of the tool invocation flow.
 */
export function renderFindingsMarkdown(
  findings: CdkNagFinding[],
  target: ResolvedTarget,
  rulePacks?: string[]
): string {
  const lines: string[] = [];
  lines.push(`### cdk-nag validation — \`${target.displayName}\``);
  if (rulePacks && rulePacks.length > 0) {
    lines.push(`Rule packs: ${rulePacks.map(p => `\`${p}\``).join(', ')}`);
  }
  lines.push('');

  if (findings.length === 0) {
    lines.push('**No findings.** The validated workspace passed every configured rule pack.');
    return lines.join('\n');
  }

  const errors = findings.filter(f => f.level === 'ERROR').length;
  const warnings = findings.filter(f => f.level === 'WARNING').length;
  const info = findings.filter(f => f.level === 'INFO').length;
  lines.push(
    `**${findings.length} finding${findings.length === 1 ? '' : 's'}** — ` +
      `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${
        warnings === 1 ? '' : 's'
      }, ${info} info.`
  );
  lines.push('');

  const preview = findings.slice(0, 20);
  for (const f of preview) {
    const doc = lookupRuleDoc(f.id);
    const ruleName = doc?.name ?? f.name;
    lines.push(`- **${f.id}** (${f.level}) on \`${f.resourceId}\` — ${ruleName}: ${f.description}`);
  }
  if (findings.length > preview.length) {
    lines.push('');
    lines.push(`_…and ${findings.length - preview.length} more findings._`);
  }

  return lines.join('\n');
}

/**
 * The `cdkNag_validateFile` tool. Executes a full workspace validation and
 * returns a Markdown summary as a single `LanguageModelTextPart`.
 */
export class ValidateFileTool implements vscode.LanguageModelTool<ValidateFileToolInput> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ValidateFileToolInput>
  ): vscode.PreparedToolInvocation {
    const resolved = resolveValidationTarget(options.input ?? {});
    const targetName = typeof resolved === 'string' ? 'CDK workspace' : resolved.displayName;
    const rulePacks = options.input?.rulePacks;
    const packSuffix = rulePacks && rulePacks.length > 0 ? ` with ${rulePacks.join(', ')}` : '';
    return {
      invocationMessage: `Validating ${targetName} with cdk-nag${packSuffix}…`,
      confirmationMessages: {
        title: 'Run cdk-nag on this workspace?',
        message:
          `This will synthesise the CDK app in your workspace and run the ` +
          `configured rule packs against the resulting CloudFormation template. ` +
          `If you have \`cdkNagValidator.autoInstall\` enabled, dependencies ` +
          `will be installed first. Continue?`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ValidateFileToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const resolved = resolveValidationTarget(options.input ?? {});
    if (typeof resolved === 'string') {
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resolved)]);
    }

    const rulePacks = Array.isArray(options.input?.rulePacks)
      ? options.input?.rulePacks
      : undefined;

    try {
      const findings = await runCdkNagValidation(resolved.workspacePath, {
        token,
        overrides: rulePacks ? { rulePacks } : undefined,
      });

      // If the caller pointed at a specific file, narrow the findings we
      // render to ones that anchor to a resource declared in that file.
      // cdk-nag's resource ids don't encode a file path, so we approximate
      // by matching the id against a substring of the file's basename. If
      // the match rate is zero we fall back to the full list so the user
      // still gets useful output rather than silence.
      let rendered: CdkNagFinding[] = findings;
      if (resolved.workspaceRelativePath && findings.length > 0) {
        const base = path.basename(
          resolved.workspaceRelativePath,
          path.extname(resolved.workspaceRelativePath)
        );
        const narrowed = findings.filter(f => f.resourceId.includes(base));
        if (narrowed.length > 0) rendered = narrowed;
      }

      const md = renderFindingsMarkdown(rendered, resolved, rulePacks);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(md)]);
    } catch (err) {
      if (err instanceof ValidationCancelledError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('cdkNag_validateFile: validation was cancelled.'),
        ]);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `cdkNag_validateFile: validation failed — ${msg}. ` +
            `Ensure the workspace has a CDK app (cdk.json) and the CDK CLI is on PATH.`
        ),
      ]);
    }
  }
}
