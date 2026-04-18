// Copilot Chat participant for cdk-nag.
//
// Registered as `@cdk-nag` in the VS Code Chat view. This PR 5 build is an
// ask-only scaffold — no slash commands and no Language Model tool calls yet.
// It reports what the user can ask about and echoes back any cdk-nag
// diagnostics currently sitting on the active editor so users immediately see
// that the participant is wired through to the same diagnostics they see in
// the Problems panel.
//
// PR 6 will extend this with `languageModelTools` calls (`cdkNag_validateFile`,
// `cdkNag_explainRule`) so the participant can actually explain arbitrary rule
// ids or validate files on demand. Slash commands land in a later PR after we
// have usage data.
//
// Graceful degradation: `createCdkNagChatParticipant` returns `undefined` when
// `vscode.chat` is not defined on the host (older VS Code, or a non-Copilot
// fork). Callers should push the returned disposable to `context.subscriptions`
// only when it is non-nullish — see `extension.ts:activate`.

import * as vscode from 'vscode';
import { lookupRuleDoc } from '../ruleDocs';
import { CDK_NAG_DIAGNOSTIC_SOURCE } from '../providers/codeActionProvider';

export const CHAT_PARTICIPANT_ID = 'cdk-nag-validator.chat';

/**
 * Build the Copilot Chat handler. Exported separately from the
 * `createCdkNagChatParticipant` factory below so it can be unit-tested against
 * a fake `ChatResponseStream` without needing the full VS Code chat API.
 */
export function createChatHandler(): vscode.ChatRequestHandler {
  return async (request, _context, stream, _token) => {
    stream.markdown('👋 I can explain cdk-nag findings in your workspace. Ask me things like:\n\n');
    stream.markdown('- "Why is `AwsSolutions-S1` being flagged?"\n');
    stream.markdown('- "What does `AwsSolutions-EC23` check for?"\n');
    stream.markdown('- "Explain the finding on the current file"\n\n');

    // Echo the user's prompt back in a collapsible block so they can see we
    // received it cleanly. This also exercises the stream API end-to-end.
    const prompt = request.prompt.trim();
    if (prompt) {
      stream.markdown(`**You asked**: ${prompt}\n\n`);
    }

    // Opportunistic: if the active editor has CDK-NAG diagnostics, surface the
    // first handful so the user sees we're looking at the same findings the
    // Problems panel shows. This will be replaced by a real Language Model
    // Tool invocation in PR 6.
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

    stream.markdown(
      '\n---\n_Full natural-language answers and rule explanations land in the next release (Language Model Tools integration)._\n'
    );
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
