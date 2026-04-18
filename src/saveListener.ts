// Debounced save listener — triggers validation when the user saves a TS/JS
// file, gated by the `cdkNagValidator.autoValidate` setting.
//
// The listener is factored out of extension.ts so the debounce + gating logic
// can be unit-tested (Jest with the mocked vscode module) without spinning up
// the full extension host.

import * as vscode from 'vscode';

export interface SaveListenerDeps {
  /** Returns true if the user has not disabled auto-validation. */
  shouldAutoValidate: () => boolean;
  /** Runs the actual validation — called once per URI after the debounce. */
  validate: (document: vscode.TextDocument) => Promise<void>;
  /** Optional logger for diagnostic output. */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** Debounce window in ms (default 500). Exposed for tests. */
  debounceMs?: number;
}

/**
 * Creates a Disposable that, when registered on the extension context,
 * validates TS/JS files on save with a per-URI debounce.
 *
 * Coalescing rules:
 * - A second save on the same URI within `debounceMs` replaces the first —
 *   we only run validation once after the user stops saving rapidly.
 * - Saves on different URIs are independent.
 * - The listener is idempotent: disposing clears all pending timers.
 */
export function createSaveListener(deps: SaveListenerDeps): vscode.Disposable {
  const debounceMs = deps.debounceMs ?? 500;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const listener = vscode.workspace.onDidSaveTextDocument(document => {
    // Only watch TS/JS files — matches the activation events in package.json.
    if (document.languageId !== 'typescript' && document.languageId !== 'javascript') {
      return;
    }

    if (!deps.shouldAutoValidate()) {
      return;
    }

    const key = document.uri.toString();

    // Reset the debounce timer if another save lands for the same URI.
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const handle = setTimeout(() => {
      pending.delete(key);
      deps.validate(document).catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        deps.log?.error(`Auto-validate on save failed for ${document.fileName}: ${message}`);
      });
    }, debounceMs);
    pending.set(key, handle);
  });

  return {
    dispose(): void {
      for (const handle of pending.values()) {
        clearTimeout(handle);
      }
      pending.clear();
      listener.dispose();
    },
  };
}
