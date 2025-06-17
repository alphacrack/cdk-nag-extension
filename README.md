# CDK NAG Validator VS Code Extension

[![Version](https://img.shields.io/visual-studio-marketplace/v/bishwasjha.cdk-nag-validator.svg)](https://marketplace.visualstudio.com/items?itemName=bishwasjha.cdk-nag-validator)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/bishwasjha.cdk-nag-validator.svg)](https://marketplace.visualstudio.com/items?itemName=bishwasjha.cdk-nag-validator)
[![Build Status](https://github.com/bishwasjha/cdk-nag-validator/actions/workflows/ci.yml/badge.svg)](https://github.com/bishwasjha/cdk-nag-validator/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/bishwasjha/cdk-nag-validator.svg)](https://github.com/bishwasjha/cdk-nag-validator/blob/main/LICENSE)

A powerful VS Code extension that brings AWS CDK-NAG (CDK Nag) validation directly into your editor. This extension helps you write secure and compliant AWS CDK code by providing real-time validation, inline suggestions, and detailed explanations of security and compliance issues.

## ✨ Features

- 🔍 **Real-time Validation**: Automatically validates your CDK code as you type
- 🎯 **Inline Suggestions**: Get immediate feedback with inline warnings and errors
- 📚 **Multiple Language Support**: Works with TypeScript, JavaScript, Python, and Java CDK code
- ⚙️ **Configurable Rules**: Enable/disable specific rule packs and customize validation settings
- 🔧 **Quick Fixes**: Apply suggested fixes directly from the editor
- 📖 **Detailed Documentation**: Access comprehensive explanations and remediation guides
- 🛡️ **Multiple Compliance Standards**: Support for AWS Solutions, HIPAA, NIST, PCI DSS, and more

## 🚀 Installation

1. Open VS Code
2. Press `Ctrl+P` (Windows/Linux) or `Cmd+P` (Mac)
3. Paste the following command:
   ```
   ext install bishwasjha.cdk-nag-validator
   ```
4. Press Enter

## 📋 Requirements

- Visual Studio Code 1.60.0 or higher
- Node.js 14.x or higher
- AWS CDK project
- CDK-NAG installed globally (`npm install -g cdk-nag`)

## 🎮 Usage

### Automatic Validation

The extension automatically validates your CDK code when you save files. You'll see:
- Inline warnings and errors in the editor
- A summary in the Problems panel
- Quick fixes available through the lightbulb menu

### Manual Validation

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type "CDK NAG: Validate Current File"
3. Press Enter

### Configuration

Access settings through VS Code's settings panel:

```json
{
  "cdkNagValidator.enabledRulePacks": ["AwsSolutionsChecks"],
  "cdkNagValidator.autoValidate": true,
  "cdkNagValidator.showInlineSuggestions": true
}
```

Available rule packs:
- `AwsSolutionsChecks`
- `HIPAA.SecurityChecks`
- `NIST.800-53.R4Checks`
- `NIST.800-53.R5Checks`
- `PCI.DSS.321Checks`
- `ServerlessChecks`

## 🛠️ Development

### Prerequisites

- Node.js 14.x or higher
- npm 6.x or higher
- VS Code Extension Development Tools

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/bishwasjha/cdk-nag-validator.git
   cd cdk-nag-validator
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
   npm test
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

- [GitHub Issues](https://github.com/bishwasjha/cdk-nag-validator/issues)
- [Documentation](https://github.com/bishwasjha/cdk-nag-validator/wiki)

## 🔄 Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes in each version. 