// AI-assisted fix-suggestion flow.
//
// Entry point: the `cdk-nag-validator.askCopilotForFix` command (registered
// in `extension.ts`). The CodeActionProvider surfaces a third quick-fix
// ("Ask Copilot to suggest a fix") whose `.command` payload points here.
// This module owns the end-to-end flow:
//
//   1. Runtime-gate: the `vscode.lm` namespace must exist and expose
//      `selectChatModels`. If not (older VS Code, non-Copilot fork), we
//      tell the user and bail without error.
//   2. Consent: delegated to `ensureAiConsent` (see `consent.ts`).
//   3. Snippet extraction: ±10 lines around the flagged range. We
//      deliberately do NOT send the whole file — narrower scope = less
//      potential exposure and better model attention.
//   4. Scrubbing: every byte passes through `scrubSnippet` before leaving
//      the extension host. Count + pattern ids logged to OutputChannel so
//      users can audit what was actually redacted.
//   5. Model selection: prefer `gpt-4o-mini` under the `copilot` vendor for
//      latency; fall back to any Copilot model if that family isn't
//      resolvable at runtime.
//   6. Prompt: cdk-nag rule context (from `ruleDocs`) folded into the user
//      message — VS Code 1.97 does NOT support a System role, so the
//      instructions and context live in the first User message.
//   7. Apply: response parsed out of a fenced code block and staged as a
//      `WorkspaceEdit` with `needsConfirmation: true`, which triggers VS
//      Code's built-in Refactor Preview panel — the idiomatic "show diff,
//      user accepts/rejects" flow. We NEVER silently edit user code.
//
// Cancellation: honored end-to-end via a disposable progress notification;
// the inner `sendRequest` cancellation token is wired so a cancelled
// invocation hangs up the stream promptly.

import * as vscode from 'vscode';
import { scrubSnippet, type ScrubResult } from './scrubber';
import { ensureAiConsent, type ConsentContextLike } from './consent';
import { lookupRuleDoc } from '../ruleDocs';

export const ASK_COPILOT_COMMAND_ID = 'cdk-nag-validator.askCopilotForFix';

/**
 * Payload the CodeActionProvider stuffs into the quick-fix's `command`
 * arguments. Must be JSON-serialisable — VS Code round-trips it through
 * the command registry, so it cannot hold live `Uri` / `Range` instances.
 */
export interface AskCopilotPayload {
  ruleId: string;
  /** URI serialised via `Uri.toString()` in the provider. */
  uri: string;
  /** Diagnostic range in plain object form (line + character, 0-indexed). */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** The diagnostic message — echoed back to the model as extra context. */
  message: string;
}

/** Narrow view of the VS Code APIs we touch. Lets tests inject fakes. */
export interface SuggestFixDeps {
  /** Required — used for audit-trail logs ("sent N bytes, redacted M tokens"). */
  channel: Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'error'>;
  /** Override `vscode.window` in tests. */
  windowApi?: typeof vscode.window;
  /** Override `vscode.workspace` in tests. */
  workspaceApi?: typeof vscode.workspace;
  /** Override `vscode.lm` in tests — also used to force the "no LM API" path. */
  lmApi?: typeof vscode.lm | undefined;
}

/** Terminal states of `askCopilotForFix`. Returned for testability. */
export type AskCopilotOutcome =
  | 'applied' // user accepted the refactor-preview diff
  | 'cancelled' // user declined consent, or rejected the preview
  | 'error' // any thrown error (LM, file open, apply)
  | 'no-model' // no vscode.lm or no Copilot model resolvable
  | 'no-response'; // LM returned an empty / unparsable response

export interface ExtractedSnippet {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Return the text of `document` from `line - context` through `line + context`,
 * clamped to the document bounds. Used to narrow what we send to the model —
 * full-file sends would leak unrelated code for no inference benefit.
 */
export function extractSnippet(
  document: vscode.TextDocument,
  line: number,
  context = 10
): ExtractedSnippet {
  const startLine = Math.max(0, line - context);
  const endLine = Math.min(document.lineCount - 1, line + context);
  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    lines.push(document.lineAt(i).text);
  }
  return { text: lines.join('\n'), startLine, endLine };
}

/**
 * Build the single `User` message sent to the model. Exported for tests so
 * we can lock the prompt shape — regressions in prompt wording meaningfully
 * change the response quality and should be surfaced at review time.
 */
export function buildPrompt(ruleId: string, message: string, scrubbed: ScrubResult): string {
  const doc = lookupRuleDoc(ruleId);
  const ruleContext = doc
    ? `Rule: ${ruleId} — ${doc.name} (${doc.severity}). ${doc.description}`
    : `Rule: ${ruleId}. (No curated documentation available.)`;

  const lines = [
    'You are a security-focused AWS CDK / CloudFormation remediation assistant.',
    ruleContext,
    `Diagnostic: ${message}`,
    '',
    'Suggest a MINIMAL, SAFE fix for this finding. Return ONLY the replacement',
    'TypeScript snippet inside a fenced ```typescript code block — no prose,',
    'no explanation, no lead-in, no trailing commentary.',
    '',
    `Flagged snippet (${scrubbed.redactionCount} secret${
      scrubbed.redactionCount === 1 ? '' : 's'
    } redacted):`,
    '```typescript',
    scrubbed.scrubbed,
    '```',
  ];
  return lines.join('\n');
}

/**
 * Extract the replacement code out of a model response. The response *should*
 * be a single fenced ```typescript``` block; we also accept plain `ts` / `js`
 * fences, and fall back to the trimmed response verbatim if no fence is found.
 * Returns `undefined` for empty / whitespace-only responses.
 */
export function parseReplacement(raw: string): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const fence = raw.match(/```(?:typescript|ts|javascript|js)?\r?\n([\s\S]*?)```/);
  const body = fence ? fence[1] : raw;
  const trimmed = body.replace(/\s+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * End-to-end orchestration. Safe to call from a command handler; handles
 * every failure path internally and returns a terminal state.
 */
export async function askCopilotForFix(
  context: ConsentContextLike,
  payload: AskCopilotPayload,
  deps: SuggestFixDeps
): Promise<AskCopilotOutcome> {
  const { channel } = deps;
  const windowApi = deps.windowApi ?? vscode.window;
  const workspaceApi = deps.workspaceApi ?? vscode.workspace;
  // Pull `lm` via a `deps` override OR the runtime-gated namespace. Older VS
  // Code builds and non-Copilot forks do not expose `vscode.lm` at all.
  // Use `'lmApi' in deps` so tests can pass `lmApi: undefined` to force the
  // "host without LM API" path without falling through to `vscode.lm`.
  const lmApi = 'lmApi' in deps ? deps.lmApi : (vscode as unknown as { lm?: typeof vscode.lm }).lm;

  if (!lmApi || typeof lmApi.selectChatModels !== 'function') {
    channel.warn('askCopilotForFix: vscode.lm.selectChatModels is unavailable on this host.');
    void windowApi.showInformationMessage(
      'CDK NAG: Language Model API not available on this host. Update VS Code or install GitHub Copilot to use AI-assisted fixes.'
    );
    return 'no-model';
  }

  const consent = await ensureAiConsent(context, windowApi);
  if (consent !== 'granted') {
    channel.info('askCopilotForFix: consent denied — not sending to Copilot.');
    return 'cancelled';
  }

  let document: vscode.TextDocument;
  try {
    document = await workspaceApi.openTextDocument(vscode.Uri.parse(payload.uri));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channel.error(`askCopilotForFix: failed to open document ${payload.uri}: ${msg}`);
    void windowApi.showErrorMessage(`CDK NAG: failed to open document: ${msg}`);
    return 'error';
  }

  const snippet = extractSnippet(document, payload.range.start.line);
  const scrubbed = scrubSnippet(snippet.text);
  channel.info(
    `askCopilotForFix: rule=${payload.ruleId} lines=${snippet.startLine + 1}-${
      snippet.endLine + 1
    } redactions=${scrubbed.redactionCount} patterns=[${scrubbed.patternsHit.join(',') || 'none'}]`
  );

  let models = await lmApi.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
  if (!models || models.length === 0) {
    channel.info('askCopilotForFix: gpt-4o-mini not resolvable, trying any Copilot model.');
    models = await lmApi.selectChatModels({ vendor: 'copilot' });
  }
  if (!models || models.length === 0) {
    void windowApi.showInformationMessage(
      'CDK NAG: no GitHub Copilot chat model is available. Sign in to Copilot from the status bar and try again.'
    );
    return 'no-model';
  }
  const model = models[0];

  const prompt = buildPrompt(payload.ruleId, payload.message, scrubbed);
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];

  try {
    const response = await windowApi.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: `CDK NAG: asking Copilot for a fix (${payload.ruleId})…`,
      },
      async (_progress, progressToken) => {
        const chatResponse = await model.sendRequest(
          messages,
          { justification: `Suggest a remediation for CDK-NAG finding ${payload.ruleId}.` },
          progressToken
        );
        let full = '';
        for await (const chunk of chatResponse.text) {
          if (progressToken.isCancellationRequested) break;
          full += chunk;
        }
        return { full, cancelled: progressToken.isCancellationRequested };
      }
    );

    if (response.cancelled) {
      channel.info('askCopilotForFix: cancelled via progress-notification.');
      return 'cancelled';
    }

    const replacement = parseReplacement(response.full);
    if (!replacement) {
      channel.warn('askCopilotForFix: model returned an empty or unparsable response.');
      void windowApi.showInformationMessage(
        'CDK NAG: Copilot returned an empty suggestion. Try rephrasing or re-running the validation.'
      );
      return 'no-response';
    }

    // Stage an edit that spans the full extracted snippet. `needsConfirmation`
    // routes it through the Refactor Preview panel — the user reviews the
    // diff side-by-side and clicks Apply (or Discard) themselves.
    const edit = new vscode.WorkspaceEdit();
    const fullSnippetRange = new vscode.Range(
      new vscode.Position(snippet.startLine, 0),
      new vscode.Position(snippet.endLine, document.lineAt(snippet.endLine).text.length)
    );
    const metadata: vscode.WorkspaceEditEntryMetadata = {
      needsConfirmation: true,
      label: `Apply Copilot fix for ${payload.ruleId}`,
      description: 'Review the AI-suggested change before applying.',
    };
    edit.replace(vscode.Uri.parse(payload.uri), fullSnippetRange, replacement, metadata);

    const applied = await workspaceApi.applyEdit(edit);
    channel.info(`askCopilotForFix: applyEdit resolved ${applied} (user-reviewed preview).`);
    return applied ? 'applied' : 'cancelled';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channel.error(`askCopilotForFix: ${msg}`);
    void windowApi.showErrorMessage(`CDK NAG: AI suggestion failed — ${msg}`);
    return 'error';
  }
}
