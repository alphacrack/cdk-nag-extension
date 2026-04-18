// Singleton wrapper around vscode.window.createOutputChannel so every module
// in the extension logs to the same "CDK NAG" channel instead of polluting the
// developer console (console.log). Created lazily on first use.
//
// We use the LogOutputChannel variant (`{ log: true }`) which supports
// trace/info/warn/error levels and respects the user's "Log Level" setting
// — more idiomatic for a published extension than appendLine.

import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function getOutputChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('CDK NAG', { log: true });
  }
  return channel;
}

export function disposeOutputChannel(): void {
  if (channel) {
    channel.dispose();
    channel = undefined;
  }
}
