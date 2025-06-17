import * as assert from 'assert';
import * as vscode from 'vscode';

describe('CDK NAG Validator Extension Integration Test', function () {
  it('Extension should be present', function () {
    const ext = vscode.extensions.getExtension('bishwasjha.cdk-nag-validator');
    assert.ok(ext);
  });

  it('Extension should activate', async function () {
    const ext = vscode.extensions.getExtension('bishwasjha.cdk-nag-validator');
    await ext?.activate();
    assert.strictEqual(ext?.isActive, true);
  });
});
