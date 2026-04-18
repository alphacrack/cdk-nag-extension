// Low-level CDK-NAG runner process plumbing.
//
// Extracted from `extension.ts` in PR 6 so the Language Model Tools and the
// validation orchestration module (`runValidation.ts`) can share the same
// `spawnRunner` implementation without a circular import through
// `extension.ts`.
//
// Surface:
//   • `ValidationCancelledError` — thrown when a validation is cancelled by
//     the user (via the progress notification or a tool-invocation
//     cancellation token). Callers can distinguish cancellation from a real
//     failure with `instanceof ValidationCancelledError` and suppress the
//     error message.
//   • `spawnRunner(inputPath, workspacePath, token?)` — forks the compiled
//     `cdkNagRunner.js` as a child process with `shell: false` (eliminating
//     the shell-injection surface that existed before the 5d0388e refactor)
//     and returns its stdout. All user-controlled data flows through a JSON
//     file at `inputPath` — nothing is ever interpolated into a command
//     string.

import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { getOutputChannel } from './outputChannel';

/** Thrown when the user cancels a validation. */
export class ValidationCancelledError extends Error {
  constructor() {
    super('Validation cancelled by user');
    this.name = 'ValidationCancelledError';
  }
}

/**
 * Spawn the compiled cdk-nag runner as a child process.
 *
 * All user-controlled data is passed through the JSON file at `inputPath`;
 * nothing from the user's workspace is interpolated into a shell string.
 * When `token` fires cancellation, the child is killed with SIGTERM and the
 * returned promise rejects with a `ValidationCancelledError`.
 */
export async function spawnRunner(
  inputPath: string,
  workspacePath: string,
  token?: vscode.CancellationToken
): Promise<string> {
  const channel = getOutputChannel();
  const runnerScript = path.join(__dirname, 'cdkNagRunner.js');

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let cancelled = false;

    // spawn() (not exec) so no shell is involved; argv[2] is the path to the
    // JSON input file — a plain file-system path, not interpolated user data.
    const child = spawn(process.execPath, [runnerScript, inputPath], {
      cwd: workspacePath,
      shell: false,
    });

    const cancelSub = token?.onCancellationRequested(() => {
      cancelled = true;
      channel.warn('Validation cancelled — sending SIGTERM to runner');
      try {
        child.kill('SIGTERM');
      } catch (err) {
        channel.warn(
          `Failed to kill runner process: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('close', code => {
      cancelSub?.dispose();
      if (cancelled) {
        reject(new ValidationCancelledError());
        return;
      }
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`CDK-NAG runner exited with code ${code}: ${stderr}`));
        return;
      }
      if (stderr) {
        channel.warn(`CDK-NAG runner warnings: ${stderr}`);
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    child.on('error', err => {
      cancelSub?.dispose();
      reject(err);
    });
  });
}
