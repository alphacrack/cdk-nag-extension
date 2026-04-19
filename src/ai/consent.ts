// Consent flow for the AI-assisted fix feature.
//
// We gate *every* LM invocation on an explicit user OK before the first send.
// The feature is also globally off by default (`cdkNagValidator.enableAiSuggestions`
// defaults to `false`); this module handles the second layer — asking the
// user whether they're OK with sending a scrubbed snippet to Copilot *this
// time*, with an "Always allow" escape hatch persisted in globalState so
// they don't see a modal on every lightbulb click.
//
// The existing platform-level consent dialog VS Code shows on the first
// `sendRequest` (the one gated by `LanguageModelChatRequestOptions.justification`)
// covers a different concern: "is this extension allowed to use the model at
// all?". Our prompt covers "is this extension allowed to send *this* CDK
// snippet on my behalf?". Both fire the first time — the platform one is a
// one-time trust decision, ours can be deferred to "once" until the user
// chooses "Always allow".
//
// Persistence scope: `globalState` (cross-workspace). A consent decision
// about "sending snippets from your editor to Copilot" is about the user's
// personal trust boundary, not the repo's. Workspace-scoped opt-in would
// surprise users who flipped the setting in their own dotfiles.

import type * as vscode from 'vscode';

/** Key used in `ExtensionContext.globalState`. */
export const CONSENT_KEY = 'cdkNagValidator.aiSuggestions.consent';

/**
 * Values stored under `CONSENT_KEY`. Absent ⇒ user has never been asked;
 * `'always'` ⇒ skip the prompt and proceed; no stored `'once'` or
 * `'cancelled'` — those are momentary decisions, not persistent state.
 */
export type StoredConsent = 'always';

/** Narrow subset of `vscode.ExtensionContext` we need — keeps tests ergonomic. */
export interface ConsentContextLike {
  globalState: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
}

/** Narrow subset of `vscode.window` we need for the prompt. */
export interface ConsentWindowLike {
  showWarningMessage: (
    message: string,
    options: vscode.MessageOptions,
    ...items: string[]
  ) => Thenable<string | undefined>;
}

/**
 * Check-or-prompt for consent. Resolves to `'granted'` when the user has
 * previously picked "Always allow" OR picks one of the positive options in
 * this invocation's modal; `'cancelled'` when the user dismisses the modal
 * or picks Cancel. The caller is responsible for *what* happens next —
 * this function ONLY owns the trust decision.
 */
export async function ensureAiConsent(
  context: ConsentContextLike,
  windowApi: ConsentWindowLike
): Promise<'granted' | 'cancelled'> {
  const existing = context.globalState.get<StoredConsent>(CONSENT_KEY);
  if (existing === 'always') return 'granted';

  const message =
    'CDK NAG will send a scrubbed code snippet and the rule metadata to ' +
    'GitHub Copilot to suggest a fix. ' +
    'Secrets matching our gitleaks patterns (SSNs, credit cards, AWS credentials, ' +
    'ARNs, process.env references) are redacted before transmission. ' +
    'Do you want to continue?';

  const ALLOW_ONCE = 'Allow once';
  const ALWAYS_ALLOW = 'Always allow';
  const CANCEL = 'Cancel';

  const choice = await windowApi.showWarningMessage(
    message,
    { modal: true },
    ALLOW_ONCE,
    ALWAYS_ALLOW,
    CANCEL
  );

  if (choice === ALWAYS_ALLOW) {
    await context.globalState.update(CONSENT_KEY, 'always');
    return 'granted';
  }
  if (choice === ALLOW_ONCE) return 'granted';
  return 'cancelled';
}

/**
 * Reset the stored consent value — exposed so the extension can offer a
 * "Reset AI consent" command later and for tests that share a mock globalState.
 */
export async function resetAiConsent(context: ConsentContextLike): Promise<void> {
  await context.globalState.update(CONSENT_KEY, undefined);
}
