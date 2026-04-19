# CDK NAG Validator VS Code Extension

[![Build Status](https://github.com/alphacrack/cdk-nag-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/alphacrack/cdk-nag-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/alphacrack/cdk-nag-extension.svg)](https://github.com/alphacrack/cdk-nag-extension/blob/main/LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.97.0-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)

Run [cdk-nag](https://github.com/cdklabs/cdk-nag) against your AWS CDK project from inside VS Code. The extension synthesises your CDK app, applies the configured rule packs to the resulting CloudFormation template, and surfaces findings as diagnostics in the Problems panel.

> **Scope**: TypeScript and JavaScript CDK projects only. Python/Java/.NET CDK are **not** currently supported — see [Known Issues](#known-issues).

## ✨ Features

- 🛡️ **Multiple compliance standards** — `AwsSolutionsChecks`, `HIPAA.SecurityChecks`, `NIST.800-53.R4Checks`, `NIST.800-53.R5Checks`, `PCI.DSS.321Checks`, and `ServerlessChecks`. Any subset can be enabled via settings.
- ⚙️ **Custom rules** — Add project-specific rules targeted at CloudFormation resource types. Conditions are evaluated in a sandboxed Node `vm` context with no access to `require` / `process` / globals, and a hard 500 ms timeout.
- 🔍 **On-demand validation** — Command Palette commands to validate the current file or the full workspace.
- 🎯 **Diagnostics integration** — Findings appear in the Problems panel, anchored to the matching resource declaration in your source. A brace-balanced multi-line parser handles constructors that span multiple lines or omit the third props argument.
- 💡 **Quick-fix lightbulbs** — Curated fixes for the most common AWS Solutions rules (`S1`, `S2`, `S3`, `S10`, `EC23`, `EC27`, `IAM4`, `IAM5`, `L1`, `APIG1`, `APIG2`, `DDB3`, `RDS3`, `RDS6`, `CFR1`, `SNS2`, `SQS3`) are offered as one-click insertions above the flagged construct.
- 📖 **Rule-doc hovers** — Hover any CDK-NAG diagnostic to see the rule name, description, severity, a remediation snippet, and a direct link to the upstream cdk-nag RULES.md entry.
- 🙈 **Per-workspace suppressions** — "Suppress this finding" action persists the rule id to `.vscode/cdk-nag-config.json`; the runner filters the suppressed findings before they ever become diagnostics. Supports both exact rule ids (`AwsSolutions-S1`) and `ruleId:resourceId` tuples.
- 🔒 **No shell execution** — The underlying runner is spawned with `shell: false`; all template / config data flows through a JSON input file, so there is no shell-injection surface.
- 🗒️ **Dedicated Output channel** — Look for "CDK NAG" in the Output panel dropdown for structured diagnostic logs (respects your Log Level setting).
- 🤖 **Copilot Chat participant (`@cdk-nag`)** — Ask about findings directly in the VS Code Chat view. Natural-language intent routing: "validate the current file", "scan my workspace", or "what does `AwsSolutions-S1` check?" all resolve to the matching Language Model Tool. Falls back to a curated diagnostic preview when the Language Model Tool API isn't available on the host.
- 🧰 **Language Model Tools** — `cdkNag_validateFile` and `cdkNag_explainRule` are registered via `vscode.lm.registerTool` and declared in `package.json` under `contributes.languageModelTools`. Copilot **agent mode** can invoke them directly with `#cdkNagValidateFile` / `#cdkNagExplainRule` during multi-step tasks, giving Copilot a reliable path to run cdk-nag and surface rule docs without hallucinating. The tools run the same validation pipeline as the commands (synth → pack → findings) and honour `CancellationToken` so the runner is SIGTERMed when Copilot cancels the invocation.
- 🪄 **AI-assisted fix suggestions** (opt-in via `cdkNagValidator.enableAiSuggestions`) — for rules with no curated static remediation, an **Ask Copilot to suggest a fix** lightbulb appears. Snippets are scoped to ±10 lines, run through a gitleaks-regex scrubber (SSN, PAN, ARN account ids, `process.env.*`, AKIA/ASIA tokens, aws credential key-values), and the model response is staged as a `WorkspaceEdit` with `needsConfirmation: true` so you review the diff in the **Refactor Preview** panel before anything is applied. Consent is gated behind a modal and persisted in `globalState`; resettable via `CDK NAG: Reset AI-assisted-fix consent`.

## 🚀 Installation

The extension is **not yet on the Marketplace** — install from the packaged `.vsix`:

```bash
git clone https://github.com/alphacrack/cdk-nag-extension.git
cd cdk-nag-extension
npm ci && npm run compile && npm run package
code --install-extension cdk-nag-validator-0.0.1.vsix
```

Marketplace publishing is tracked under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## 📋 Requirements

- Visual Studio Code **1.97.0** or newer
- Node.js **18.x**, **20.x**, or **22.x**
- An AWS CDK project with:
  - a `cdk.json` at the workspace root,
  - `aws-cdk-lib` and `cdk-nag` installed as project dependencies (the extension resolves them from your workspace's `node_modules`), and
  - the AWS CDK CLI on `PATH` (the extension runs `cdk synth --no-staging` in your workspace).

## 🎮 Usage

### Commands

All actions are triggered from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---|---|
| `CDK NAG: Validate Current File` | Synthesises the workspace, runs the configured rule packs + custom rules, and surfaces findings mapped to the active file. |
| `CDK NAG: Validate Workspace` | Same as above but scopes diagnostic mapping across all `*.ts` files. |
| `CDK NAG: Configure Rules` | Interactive picker to enable rule packs and add custom rules. |

### Configuration

Access settings through the VS Code Settings UI or `settings.json`:

```json
{
  "cdkNagValidator.enabledRulePacks": ["AwsSolutionsChecks"],
  "cdkNagValidator.customRules": [],
  "cdkNagValidator.autoInstall": false
}
```

Available rule packs: `AwsSolutionsChecks`, `HIPAA.SecurityChecks`, `NIST.800-53.R4Checks`, `NIST.800-53.R5Checks`, `PCI.DSS.321Checks`, `ServerlessChecks`.

`cdkNagValidator.autoInstall` (default `false`) is opt-in: when enabled, the extension runs `npm install aws-cdk aws-cdk-lib cdk-nag yaml --save-dev` in your workspace before each validation. Most projects should leave this off and manage those as project deps themselves.

### Output channel

Open **View → Output** and pick `CDK NAG` from the dropdown to see structured logs for every validation run (useful when diagnostics are missing or the runner fails).

### AI integration (Copilot Chat + agent mode)

Two surfaces drive the extension from AI tooling, both built on the finalized VS Code Language Model API (1.97+):

**1. `@cdk-nag` chat participant** — open the Chat view, type `@cdk-nag`, and ask:

| Prompt | Routes to |
|---|---|
| `@cdk-nag validate the current file` | `cdkNag_validateFile` on the active editor |
| `@cdk-nag scan sample/insecure-stack.ts` | `cdkNag_validateFile` on the supplied path |
| `@cdk-nag explain AwsSolutions-S1` | `cdkNag_explainRule` with the extracted rule id |
| `@cdk-nag what does HIPAA.Security-S3BucketVersioningEnabled check for?` | `cdkNag_explainRule` |
| `@cdk-nag hello` | Ask-only fallback (guidance + diagnostic preview) |

Intent detection is regex-based and deliberately narrow — the participant should feel predictable. On hosts without `vscode.lm.invokeTool`, the explain intent falls back to a local `ruleDocs` lookup so users still get an answer.

**2. Copilot agent mode tool references** — the tools are declared with `canBeReferencedInPrompt: true` and `toolReferenceName`, so agent-mode Copilot can call them directly:

- `#cdkNagValidateFile` — accepts `{ uri?: string, rulePacks?: string[] }`. Omit `uri` to validate the active editor's workspace; pass a relative or absolute path to narrow the report to a specific file. Runs the full synth → rule-pack → findings pipeline.
- `#cdkNagExplainRule` — accepts `{ ruleId: string }`. Returns the curated rule name, description, severity, remediation snippet, and upstream RULES.md link.

Both tools gate side-effects through `prepareInvocation.confirmationMessages`, so agent mode asks the user before synthesising the CDK app. Cancellation is honoured end-to-end — the `CancellationToken` is threaded into the runner child process, which receives `SIGTERM` if Copilot abandons the invocation.

**3. AI-assisted quick-fix (opt-in)** — when a finding has **no** curated static remediation, you can ask Copilot to draft one. Enable the flag in your `settings.json`:

```jsonc
{
  "cdkNagValidator.enableAiSuggestions": true
}
```

With the flag on, the lightbulb on an uncurated CDK-NAG diagnostic surfaces a third action: **CDK NAG: Ask Copilot to suggest a fix (`<ruleId>`)**. The flow is deliberately conservative:

1. **Three gates** must all be true before the action appears: the setting is on, the host exposes `vscode.lm.selectChatModels`, and the rule id has no curated fix in `src/ruleDocs.ts`. A deterministic curated fix always wins over an AI one — we never offer both.
2. **Consent** — the first invocation shows a modal with `Allow once` / `Always allow` / `Cancel`. `Always allow` is persisted in your VS Code `globalState` (cross-workspace). Reset it any time via the `CDK NAG: Reset AI-assisted-fix consent` command.
3. **Scoped snippet** — we extract ±10 lines around the flagged range, never the whole file.
4. **Scrubbed** — every snippet is run through `src/ai/scrubber.ts` before leaving the extension host. SSNs, credit-card PANs, US phone numbers, IBANs, AWS AKIA/ASIA tokens, `aws_access_key_id` / `secretAccessKey` key-values, 12-digit account ids inside ARNs, and `process.env.<NAME>` references are redacted. Every redaction is logged to the `CDK NAG` Output channel with the rule id that fired.
5. **Show-before-apply** — the response is staged as a `WorkspaceEdit` with `needsConfirmation: true`, which routes it through VS Code's built-in **Refactor Preview** panel. Review the diff side-by-side and click **Apply** (or **Discard**) yourself. We never silently edit your code.
6. **Cancellable** — the `sendRequest` streams inside a `vscode.window.withProgress` notification with a cancel button. Cancelling promptly stops the stream and the edit is never staged.

Cost + privacy: the snippet is sent to whichever Copilot model resolves (we prefer `gpt-4o-mini` for latency, fall back to any Copilot model). Your GitHub Copilot data-handling settings apply. Turn the feature off by flipping the setting, or revoke trust by running `CDK NAG: Reset AI-assisted-fix consent`.

## 🧭 Roadmap

The following features are **planned but not yet wired up**. They are declared in `package.json` or mentioned in the codebase so the contract is stable, but they are shipped in upcoming PRs:

| Feature | Setting / Surface | Status |
|---|---|---|
| Auto-validate on save | `cdkNagValidator.autoValidate` | ✅ Shipped (PR 3a) |
| Progress notification + cancellation | — | ✅ Shipped (PR 3a) |
| Quick-fix lightbulbs for common findings | `CodeActionProvider` + curated `RULE_DOCS` | ✅ Shipped (PR 3b) |
| Hover tooltips with rule docs | `HoverProvider` + curated `RULE_DOCS` | ✅ Shipped (PR 3b) |
| Suppressions persisted to `.vscode/cdk-nag-config.json` | `cdk-nag-validator.suppressFinding` command | ✅ Shipped (PR 3b) |
| Multi-line constructor anchoring (AST-grade parser) | — | ✅ Shipped (PR 3b) |
| Copilot Chat participant (`@cdk-nag`) — ask-only | `chatParticipants` | ✅ Shipped (PR 5) |
| Language Model Tools (`cdkNag_validateFile`, `cdkNag_explainRule`) | `languageModelTools` | ✅ Shipped (PR 6) |
| Natural-language intent routing in the chat participant | — | ✅ Shipped (PR 6) |
| AI-suggested fixes (opt-in, scrubbed snippets, show-before-apply) | `cdkNagValidator.enableAiSuggestions` | ✅ Shipped (PR 7) |

See [BACKLOG.md](BACKLOG.md) for the full engineering backlog.

## ⚠️ Known Issues

- **Languages** — only TypeScript and JavaScript CDK projects are supported. Python, Java, and .NET CDK apps are not currently validated.
- **Quick-fix coverage** — curated remediations ship for the most common `AwsSolutions` rules (see Features). Uncurated rule ids still produce diagnostics + hover docs + suppressions. Opt into `cdkNagValidator.enableAiSuggestions` to surface an **Ask Copilot to suggest a fix** lightbulb action for uncurated rules (scrubbed snippet, show-before-apply Refactor Preview).
- **Dependencies** — the extension requires `aws-cdk-lib` and `cdk-nag` to be installed in your workspace. A graceful install prompt lands in PR 8.

## 🛠️ Development

### Prerequisites

- Node.js 18.x, 20.x, or 22.x
- npm 9.x or newer
- VS Code 1.97.0 or newer

### Setup

```bash
git clone https://github.com/alphacrack/cdk-nag-extension.git
cd cdk-nag-extension
npm install
npm run compile
```

### Test layers

| Command | Scope |
|---|---|
| `npm test` | Sandbox + unit tests (node:test). |
| `npm run test:jest` | Jest unit tests (e.g. `ConfigManager`). |
| `npm run test:functional` | Functional runner tests (spawns the compiled runner against CloudFormation fixtures). |
| `npm run test:integration` | Integration tests — launches a real VS Code instance via `@vscode/test-electron`. |
| `npm run test:all` | Lint + compile + all of the above. |

### Debugging

1. Open the project in VS Code.
2. Press `F5` to start the Extension Development Host.
3. A second VS Code window opens with this extension loaded.

### Packaging

```bash
npm run package    # produces cdk-nag-validator-<version>.vsix
```

### Releases

Releases are **tag-triggered**, not merge-triggered. Cutting a release is three commands:

```bash
npm version patch          # bump package.json and create a git tag (or minor/major)
git push origin main --follow-tags
```

The `release.yml` workflow validates that `package.json` and the tag agree, runs the full four-layer test suite, packages the `.vsix`, attaches it to a GitHub Release (with auto-generated notes from the changelog), and publishes to the VS Code Marketplace via `vsce publish` (if `VSCE_PAT` is configured).

Every PR against `main` or `development` must touch `CHANGELOG.md` — the `CHANGELOG check` workflow enforces this for any PR that modifies `src/`, `package.json`, `.github/workflows/`, `media/`, `.vscodeignore`, or `tsconfig.json`. Doc-only and dependency-bump PRs are exempt via the `docs`, `chore`, `dependencies`, or `skip-changelog` labels.

## 🤝 Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, commit conventions, and the four-layer test expectation for every PR.

## 📝 License

MIT — see [LICENSE](LICENSE).

## 🙏 Acknowledgments

- [AWS CDK](https://aws.amazon.com/cdk/)
- [cdk-nag](https://github.com/cdklabs/cdk-nag)
- [VS Code Extension API](https://code.visualstudio.com/api)

## 📫 Support

- [GitHub Issues](https://github.com/alphacrack/cdk-nag-extension/issues)
- [Security Policy](SECURITY.md)

## 🔄 Changelog

See [CHANGELOG.md](CHANGELOG.md).
