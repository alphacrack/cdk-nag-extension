// Copilot Chat participant for cdk-nag.
//
// Registered as `@cdk-nag` in the VS Code Chat view. In PR 6 the handler
// grew two real intent branches — `validate` and `explain` — that delegate
// to the Language Model Tools registered via `vscode.lm.registerTool`. This
// keeps a single source of truth for the validation pipeline (the tool) and
// lets Copilot agent mode hit the exact same surface through `#cdkNagValidateFile`
// and `#cdkNagExplainRule`.
//
// Intent parsing is intentionally simple (substring / rule-id regex) rather
// than delegating to the LLM — the participant should feel fast and
// predictable for the handful of cdk-nag-shaped questions users actually ask.
// Anything that doesn't match an intent falls through to the ask-only
// scaffold introduced in PR 5 (guidance + diagnostic preview).
//
// Graceful degradation: `createCdkNagChatParticipant` still returns
// `undefined` on hosts without `vscode.chat`. Tool invocations are
// additionally gated on `vscode.lm.invokeTool` at call-time so forks that
// have chat but not LM tools continue to work — they just won't get the
// richer responses.

import * as vscode from 'vscode';
import { lookupRuleDoc } from '../ruleDocs';
import { CDK_NAG_DIAGNOSTIC_SOURCE } from '../providers/codeActionProvider';
import { EXPLAIN_RULE_TOOL_NAME } from '../tools/explainRuleTool';
import { VALIDATE_FILE_TOOL_NAME } from '../tools/validateFileTool';

export const CHAT_PARTICIPANT_ID = 'cdk-nag-validator.chat';

/**
 * Match a cdk-nag rule id out of free-form prompt text. The grammar is broad
 * by design — `AwsSolutions-S1`, `HIPAA.Security-S3BucketVersioningEnabled`,
 * `NIST.800-53.R4-AWSSomething`, etc. Returns the first match (prompts that
 * reference multiple rule ids are rare; if they show up we can iterate).
 */
export function extractRuleId(prompt: string): string | undefined {
  // Match a "pack-rulepart" token. The pack part allows letters, digits,
  // dots, and hyphens to cover NIST.800-53.R5, PCI.DSS.321, HIPAA.Security,
  // etc. The rule part is anything non-whitespace / non-punctuation.
  const match = prompt.match(/\b([A-Z][A-Za-z0-9.-]+)-([A-Za-z0-9.]+)\b/);
  if (!match) return undefined;
  const candidate = `${match[1]}-${match[2]}`;
  // Sanity check: the pack portion must contain at least one letter so we
  // don't match random hyphenated tokens ("auto-install").
  if (!/[A-Za-z]/.test(match[1])) return undefined;
  return candidate;
}

/**
 * Crude intent detection. Returns the detected intent or `undefined` when
 * the prompt should fall through to the ask-only scaffold.
 */
export function detectIntent(prompt: string): 'validate' | 'explain' | undefined {
  const normalized = prompt.toLowerCase();
  if (!normalized) return undefined;
  if (/(^|\b)(validate|scan|check|run (cdk-?nag|nag))\b/.test(normalized)) {
    return 'validate';
  }
  if (extractRuleId(prompt)) return 'explain';
  if (/\b(explain|what does|describe|tell me about)\b/.test(normalized)) return 'explain';
  return undefined;
}

/**
 * Extract plain text parts from a `LanguageModelToolResult`. Exported for
 * tests and so the chat participant can stream the text straight through
 * without needing to know the result's full content-part union.
 */
export function extractToolText(result: vscode.LanguageModelToolResult | undefined): string {
  if (!result) return '';
  const parts: string[] = [];
  for (const part of result.content) {
    // `LanguageModelTextPart` is the only shape we emit from our tools;
    // downstream agents may emit `LanguageModelPromptTsxPart` — skip those.
    const maybeText = part as { value?: unknown };
    if (typeof maybeText?.value === 'string') {
      parts.push(maybeText.value);
    }
  }
  return parts.join('\n');
}

/**
 * Build the Copilot Chat handler. Exported separately from the
 * `createCdkNagChatParticipant` factory below so it can be unit-tested against
 * a fake `ChatResponseStream` without needing the full VS Code chat API.
 */
export function createChatHandler(): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    const prompt = request.prompt.trim();
    const intent = detectIntent(prompt);

    // ── Intent: explain <ruleId> ──
    if (intent === 'explain') {
      const ruleId = extractRuleId(prompt);
      const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
      if (ruleId && lm && typeof lm.invokeTool === 'function') {
        stream.markdown(`Looking up \`${ruleId}\`…\n\n`);
        try {
          const result = await lm.invokeTool(
            EXPLAIN_RULE_TOOL_NAME,
            {
              input: { ruleId },
              toolInvocationToken: request.toolInvocationToken,
            },
            token
          );
          const text = extractToolText(result);
          stream.markdown(text + '\n');
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stream.markdown(
            `_Failed to invoke ${EXPLAIN_RULE_TOOL_NAME}: ${msg}. Falling back to the curated lookup._\n\n`
          );
        }
      }
      // Fallback path: no LM tool API available, or the invocation threw.
      // Do the lookup locally so the user still gets an answer.
      if (ruleId) {
        const doc = lookupRuleDoc(ruleId);
        if (doc) {
          stream.markdown(`**${ruleId} — ${doc.name}** (${doc.severity.toUpperCase()})\n\n`);
          stream.markdown(`${doc.description}\n\n`);
          if (doc.fix) {
            stream.markdown('**Remediation**:\n\n');
            stream.markdown('```typescript\n' + doc.fix + '\n```\n');
          }
          if (doc.docUrl) {
            stream.markdown(`\n[Upstream documentation](${doc.docUrl})\n`);
          }
          return;
        }
        stream.markdown(
          `No curated documentation for \`${ruleId}\`. See the upstream rule list: https://github.com/cdklabs/cdk-nag/blob/main/RULES.md\n`
        );
        return;
      }
      stream.markdown(
        'I could not spot a rule id in your question. Mention a rule like `AwsSolutions-S1` and I will explain it.\n'
      );
      return;
    }

    // ── Intent: validate ──
    if (intent === 'validate') {
      const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
      if (lm && typeof lm.invokeTool === 'function') {
        stream.markdown('Running cdk-nag against your workspace…\n\n');
        try {
          // File URI hint: if the prompt contains something that looks like
          // a `.ts` / `.js` path, pass it through so the tool narrows the
          // finding report to that file. Otherwise leave undefined and let
          // the tool fall back to the active editor / workspace root.
          const pathMatch = prompt.match(/([^\s'"`]+\.(?:ts|tsx|js|jsx))/);
          const inputUri = pathMatch?.[1];
          const result = await lm.invokeTool(
            VALIDATE_FILE_TOOL_NAME,
            {
              input: inputUri ? { uri: inputUri } : {},
              toolInvocationToken: request.toolInvocationToken,
            },
            token
          );
          const text = extractToolText(result);
          stream.markdown(text + '\n');
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stream.markdown(
            `_Failed to invoke ${VALIDATE_FILE_TOOL_NAME}: ${msg}. Run the "CDK NAG: Validate Current File" command from the palette instead._\n`
          );
          return;
        }
      }
      stream.markdown(
        '_Language Model Tool API not available on this host — run `CDK NAG: Validate Current File` from the command palette instead._\n'
      );
      return;
    }

    // ── No matching intent: fall through to the ask-only scaffold ──
    stream.markdown('👋 I can explain cdk-nag findings in your workspace. Ask me things like:\n\n');
    stream.markdown('- "Why is `AwsSolutions-S1` being flagged?"\n');
    stream.markdown('- "What does `AwsSolutions-EC23` check for?"\n');
    stream.markdown('- "Validate the current file"\n\n');

    if (prompt) {
      stream.markdown(`**You asked**: ${prompt}\n\n`);
    }

    // Opportunistic diagnostic preview — unchanged from PR 5.
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const diagnostics = vscode.languages
        .getDiagnostics(editor.document.uri)
        .filter(d => d.source === CDK_NAG_DIAGNOSTIC_SOURCE);
      if (diagnostics.length > 0) {
        stream.markdown(`### Findings on \`${editor.document.fileName.split('/').pop()}\`\n\n`);
        const preview = diagnostics.slice(0, 5);
        for (const diag of preview) {
          const ruleId = typeof diag.code === 'string' ? diag.code : String(diag.code ?? '?');
          const doc = lookupRuleDoc(ruleId);
          const title = doc ? doc.name : 'CDK-NAG finding';
          stream.markdown(`- **${ruleId}** — ${title}: ${diag.message}\n`);
        }
        if (diagnostics.length > preview.length) {
          stream.markdown(`\n_…and ${diagnostics.length - preview.length} more._\n`);
        }
      } else {
        stream.markdown(
          '_No CDK-NAG diagnostics on the current file. Run `CDK NAG: Validate Current File` first._\n'
        );
      }
    }
  };
}

/**
 * Register the `@cdk-nag` chat participant. Returns `undefined` on hosts
 * without `vscode.chat` (older VS Code, non-Copilot forks) so the caller can
 * skip the `context.subscriptions.push` without a runtime error.
 *
 * The caller owns the disposable — push it to `context.subscriptions`.
 */
export function createCdkNagChatParticipant(): vscode.Disposable | undefined {
  // `vscode.chat` was finalized in VS Code 1.97. Older hosts (including
  // VS Code forks without Copilot Chat) will not have this namespace.
  // `vscode.chat` is typed as required in `@types/vscode` but undefined at
  // runtime when the chat API isn't available, so a defensive check is
  // necessary — TS-only types won't save us here.
  const chat = (vscode as unknown as { chat?: typeof vscode.chat }).chat;
  if (!chat || typeof chat.createChatParticipant !== 'function') {
    return undefined;
  }

  const participant = chat.createChatParticipant(CHAT_PARTICIPANT_ID, createChatHandler());
  // `iconPath` uses the same extension icon so the participant is visually
  // identifiable in the chat view. Skipped if the contributor happens to be
  // older than 1.97 and does not expose `iconPath`.
  try {
    (participant as unknown as { iconPath?: vscode.Uri }).iconPath = vscode.Uri.file(
      `${__dirname}/../../media/icon.png`
    );
  } catch {
    // Non-fatal — the participant is usable without a custom icon.
  }
  return participant;
}
