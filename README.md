# CDK NAG Validator VS Code Extension

[![Version](https://img.shields.io/visual-studio-marketplace/v/alphacrack.cdk-nag-validator.svg)](https://marketplace.visualstudio.com/items?itemName=alphacrack.cdk-nag-validator)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/alphacrack.cdk-nag-validator.svg)](https://marketplace.visualstudio.com/items?itemName=alphacrack.cdk-nag-validator)
[![Build Status](https://github.com/alphacrack/cdk-nag-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/alphacrack/cdk-nag-extension/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/alphacrack/cdk-nag-extension.svg)](https://github.com/alphacrack/cdk-nag-extension/blob/main/LICENSE)

A VS Code extension that runs [cdk-nag](https://github.com/cdklabs/cdk-nag) against your AWS CDK project from inside the editor. It synthesises your CDK app, applies the configured rule packs to the resulting CloudFormation template, and surfaces findings as diagnostics in the Problems panel.

## ✨ Features

- 🛡️ **Multiple compliance standards**: `AwsSolutionsChecks`, `HIPAA.SecurityChecks`, `NIST.800-53.R4Checks`, `NIST.800-53.R5Checks`, `PCI.DSS.321Checks`, and `ServerlessChecks` — any subset can be enabled via settings.
- ⚙️ **Custom rules**: Add project-specific rules targeted at CloudFormation resource types; conditions are evaluated in a sandboxed Node `vm` context with no access to `require`/`process`/globals and a hard 500 ms timeout.
- 🔍 **On-demand validation**: Commands to validate the current file or the full workspace from the Command Palette.
- 🎯 **Diagnostics integration**: Findings appear in the Problems panel, anchored to the matching resource declaration in your source when a single-line match is available.
- 🔒 **No shell execution**: The underlying runner is invoked with `spawn` (shell disabled); all template/config data is passed via a JSON input file — no user input is ever interpolated into a shell string.

## 🚀 Installation

1. Open VS Code
2. Press `Ctrl+P` (Windows/Linux) or `Cmd+P` (Mac)
3. Paste the following command:
   ```
   ext install alphacrack.cdk-nag-validator
   ```
4. Press Enter

## 📋 Requirements

- Visual Studio Code 1.96.2 or higher
- Node.js 18.x, 20.x, or 22.x
- An AWS CDK project with a `cdk.json` and `aws-cdk-lib` + `cdk-nag` installed as project dependencies (the extension resolves `cdk-nag` from your workspace's `node_modules`)
- AWS CDK CLI available on PATH (the extension runs `cdk synth --no-staging` in your workspace)

## 🎮 Usage

### Commands

All actions are triggered manually from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `CDK NAG: Validate Current File` | Synthesises the workspace, runs the configured rule packs + custom rules, and surfaces findings mapped to the active file. |
| `CDK NAG: Validate Workspace` | Same as above but scopes diagnostic mapping across all `*.ts` files. |
| `CDK NAG: Configure Rules` | Interactive picker to enable rule packs and add custom rules. |

> **Note**: The `cdkNagValidator.autoValidate` setting is declared but not yet wired up — validation today is manual. See [backlog item M1](BACKLOG.md).

### Configuration

Access settings through VS Code's settings panel or `settings.json`:

```json
{
  "cdkNagValidator.enabledRulePacks": ["AwsSolutionsChecks"],
  "cdkNagValidator.customRules": [],
  "cdkNagValidator.autoInstall": false
}
```

Available rule packs:
- `AwsSolutionsChecks`
- `HIPAA.SecurityChecks`
- `NIST.800-53.R4Checks`
- `NIST.800-53.R5Checks`
- `PCI.DSS.321Checks`
- `ServerlessChecks`

`cdkNagValidator.autoInstall` (default `false`) is an opt-in switch; when enabled, the extension runs `npm install aws-cdk aws-cdk-lib cdk-nag yaml --save-dev` in your workspace before each validation. Most projects should leave this off and manage these as project deps themselves.

## 🛠️ Development

### Prerequisites

- Node.js 18.x, 20.x, or 22.x
- npm 9.x or higher
- VS Code 1.96.2 or higher

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/alphacrack/cdk-nag-extension.git
   cd cdk-nag-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run compile
   ```

4. Run tests:
   ```bash
   npm test                    # sandbox + unit (node:test)
   npm run test:jest           # Jest unit tests
   npm run test:integration    # spawns VS Code, checks activation
   ```

### Debugging

1. Open the project in VS Code
2. Press F5 to start debugging
3. A new VS Code window will open with the extension loaded

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [AWS CDK](https://aws.amazon.com/cdk/)
- [CDK-NAG](https://github.com/cdklabs/cdk-nag)
- [VS Code Extension API](https://code.visualstudio.com/api)

## 📫 Support

- [GitHub Issues](https://github.com/alphacrack/cdk-nag-extension/issues)
- [Documentation](https://github.com/alphacrack/cdk-nag-extension/wiki)

## 🔄 Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes in each version. 