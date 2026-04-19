/**
 * Jest tests for `src/ai/consent.ts`.
 *
 * We own the trust-gate between the user and a third-party LM provider, so
 * the test surface is narrow but unforgiving:
 *
 *   • A previously-stored "always" value short-circuits the prompt.
 *   • "Always allow" persists the value in globalState AND returns granted.
 *   • "Allow once" returns granted but does NOT persist — the user sees the
 *     modal again next time.
 *   • "Cancel" returns cancelled AND does not persist.
 *   • Dismissing the modal (returning undefined from showWarningMessage)
 *     is treated as Cancel — never assume a silent dismiss means consent.
 *   • `resetAiConsent` clears the stored value so the next call re-prompts.
 */

import {
  ensureAiConsent,
  resetAiConsent,
  CONSENT_KEY,
  type ConsentWindowLike,
} from '../../ai/consent';
import { createMockExtensionContext } from '../__mocks__/vscode';

function makeWindow(
  response?: string | undefined | Error
): ConsentWindowLike & { showWarningMessage: jest.Mock } {
  return {
    showWarningMessage: jest.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

describe('ensureAiConsent', () => {
  it('returns granted without prompting when globalState already has "always"', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update(CONSENT_KEY, 'always');
    const windowApi = makeWindow(undefined);

    const result = await ensureAiConsent(context, windowApi);

    expect(result).toBe('granted');
    expect(windowApi.showWarningMessage).not.toHaveBeenCalled();
  });

  it('prompts modally and persists "always" when the user picks Always allow', async () => {
    const context = createMockExtensionContext();
    const windowApi = makeWindow('Always allow');

    const result = await ensureAiConsent(context, windowApi);

    expect(result).toBe('granted');
    expect(windowApi.showWarningMessage).toHaveBeenCalledTimes(1);
    const call = windowApi.showWarningMessage.mock.calls[0];
    // Verify the modal flag is set — a non-modal consent prompt can be
    // dismissed with no user awareness and should never be accepted.
    expect(call[1]).toEqual(expect.objectContaining({ modal: true }));
    // All three buttons present.
    expect(call.slice(2)).toEqual(expect.arrayContaining(['Allow once', 'Always allow', 'Cancel']));
    expect(context.globalState._store.get(CONSENT_KEY)).toBe('always');
  });

  it('returns granted but does NOT persist when the user picks Allow once', async () => {
    const context = createMockExtensionContext();
    const windowApi = makeWindow('Allow once');

    const result = await ensureAiConsent(context, windowApi);

    expect(result).toBe('granted');
    expect(context.globalState._store.has(CONSENT_KEY)).toBe(false);
  });

  it('returns cancelled when the user picks Cancel', async () => {
    const context = createMockExtensionContext();
    const windowApi = makeWindow('Cancel');

    const result = await ensureAiConsent(context, windowApi);

    expect(result).toBe('cancelled');
    expect(context.globalState._store.has(CONSENT_KEY)).toBe(false);
  });

  it('returns cancelled when the user dismisses the modal (undefined response)', async () => {
    const context = createMockExtensionContext();
    const windowApi = makeWindow(undefined);

    const result = await ensureAiConsent(context, windowApi);

    expect(result).toBe('cancelled');
    expect(context.globalState._store.has(CONSENT_KEY)).toBe(false);
  });
});

describe('resetAiConsent', () => {
  it('clears a previously-stored "always" value', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update(CONSENT_KEY, 'always');
    expect(context.globalState._store.get(CONSENT_KEY)).toBe('always');

    await resetAiConsent(context);

    expect(context.globalState._store.has(CONSENT_KEY)).toBe(false);
  });

  it('is a no-op when there was nothing stored', async () => {
    const context = createMockExtensionContext();
    await expect(resetAiConsent(context)).resolves.not.toThrow();
    expect(context.globalState._store.size).toBe(0);
  });

  it('forces the next ensureAiConsent call to re-prompt', async () => {
    const context = createMockExtensionContext();
    await context.globalState.update(CONSENT_KEY, 'always');
    await resetAiConsent(context);

    const windowApi = makeWindow('Allow once');
    const result = await ensureAiConsent(context, windowApi);

    expect(windowApi.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(result).toBe('granted');
  });
});
