/**
 * Jest unit tests for createSaveListener — the debounced, gated save
 * listener that triggers validation on file save.
 *
 * The `vscode` module is mocked via moduleNameMapper in jest.config.js.
 * We exercise the listener by capturing the callback passed to
 * `vscode.workspace.onDidSaveTextDocument` and invoking it directly.
 */

import * as vscode from 'vscode';
import { createSaveListener } from '../saveListener';

type SaveCallback = (doc: vscode.TextDocument) => void;

function captureSaveCallback(): SaveCallback {
  const mock = (vscode.workspace.onDidSaveTextDocument as unknown as jest.Mock).mock;
  expect(mock.calls.length).toBeGreaterThan(0);
  return mock.calls[mock.calls.length - 1][0] as SaveCallback;
}

function makeDoc(overrides: Partial<vscode.TextDocument> = {}): vscode.TextDocument {
  const uri = { toString: () => overrides.fileName ?? '/a/b/foo.ts' } as vscode.Uri;
  return {
    uri,
    fileName: '/a/b/foo.ts',
    languageId: 'typescript',
    ...overrides,
  } as vscode.TextDocument;
}

describe('createSaveListener', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Make onDidSaveTextDocument return a Disposable-shaped object.
    (vscode.workspace.onDidSaveTextDocument as unknown as jest.Mock).mockReturnValue({
      dispose: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers a listener against vscode.workspace.onDidSaveTextDocument', () => {
    createSaveListener({
      shouldAutoValidate: () => true,
      validate: jest.fn().mockResolvedValue(undefined),
    });
    expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalledTimes(1);
  });

  it('calls validate after the debounce window when autoValidate is true', async () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      debounceMs: 500,
    });

    const cb = captureSaveCallback();
    cb(makeDoc());

    expect(validate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(499);
    expect(validate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('does not call validate when autoValidate is false', () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    createSaveListener({
      shouldAutoValidate: () => false,
      validate,
      debounceMs: 500,
    });

    const cb = captureSaveCallback();
    cb(makeDoc());
    jest.advanceTimersByTime(5000);

    expect(validate).not.toHaveBeenCalled();
  });

  it('ignores non-TS/JS files', () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      debounceMs: 500,
    });

    const cb = captureSaveCallback();
    cb(makeDoc({ languageId: 'python', fileName: '/a/b/foo.py' }));
    cb(makeDoc({ languageId: 'yaml', fileName: '/a/b/bar.yaml' }));
    cb(makeDoc({ languageId: 'json', fileName: '/a/b/baz.json' }));
    jest.advanceTimersByTime(2000);

    expect(validate).not.toHaveBeenCalled();
  });

  it('processes both TypeScript and JavaScript saves', () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      debounceMs: 100,
    });

    const cb = captureSaveCallback();
    cb(makeDoc({ languageId: 'typescript', fileName: '/a/b/a.ts' }));
    cb(makeDoc({ languageId: 'javascript', fileName: '/a/b/b.js' }));
    jest.advanceTimersByTime(200);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('debounces rapid saves on the same URI into a single call', () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      debounceMs: 500,
    });

    const cb = captureSaveCallback();
    const doc = makeDoc();

    cb(doc); // 0
    jest.advanceTimersByTime(200);
    cb(doc); // resets debounce — total wait from now
    jest.advanceTimersByTime(200);
    cb(doc); // resets again
    jest.advanceTimersByTime(200);
    expect(validate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(300); // +300 = 500 since last save
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('does not debounce across different URIs', () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      debounceMs: 500,
    });

    const cb = captureSaveCallback();
    const a = makeDoc({ fileName: '/a.ts' });
    Object.assign(a.uri, { toString: () => '/a.ts' });
    const b = makeDoc({ fileName: '/b.ts' });
    Object.assign(b.uri, { toString: () => '/b.ts' });

    cb(a);
    cb(b);
    jest.advanceTimersByTime(500);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('reads the autoValidate setting on every save (not snapshotted at register)', () => {
    const validate = jest.fn().mockResolvedValue(undefined);
    let enabled = false;
    createSaveListener({
      shouldAutoValidate: () => enabled,
      validate,
      debounceMs: 100,
    });

    const cb = captureSaveCallback();

    // First save: disabled → no validate.
    cb(makeDoc());
    jest.advanceTimersByTime(200);
    expect(validate).not.toHaveBeenCalled();

    // User flips the setting on.
    enabled = true;
    cb(makeDoc());
    jest.advanceTimersByTime(200);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('logs errors via log.error when validate rejects', async () => {
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const validate = jest.fn().mockRejectedValue(new Error('boom'));
    createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      log,
      debounceMs: 10,
    });

    const cb = captureSaveCallback();
    cb(makeDoc());
    jest.advanceTimersByTime(50);

    // Flush microtasks so the rejected promise's .catch fires.
    await Promise.resolve();
    await Promise.resolve();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Auto-validate on save failed'));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('dispose() clears pending timers and underlying listener', () => {
    const innerDispose = jest.fn();
    (vscode.workspace.onDidSaveTextDocument as unknown as jest.Mock).mockReturnValue({
      dispose: innerDispose,
    });

    const validate = jest.fn().mockResolvedValue(undefined);
    const listener = createSaveListener({
      shouldAutoValidate: () => true,
      validate,
      debounceMs: 500,
    });

    const cb = captureSaveCallback();
    cb(makeDoc());

    listener.dispose();

    jest.advanceTimersByTime(2000);
    expect(validate).not.toHaveBeenCalled();
    expect(innerDispose).toHaveBeenCalled();
  });
});
