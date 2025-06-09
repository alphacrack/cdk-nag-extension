# CDK NAG Validator VS Code Extension

This VS Code extension automatically validates your AWS CDK code using CDK-NAG (CDK Nag) when you save your files. It provides inline warnings and errors for security and compliance issues in your CDK code.

## Features

- Automatic validation of CDK code on file save
- Support for multiple CDK languages (TypeScript, JavaScript, Python, Java)
- Inline warnings and errors with detailed explanations
- Quick fixes and links to documentation
- Configurable validation settings

## Requirements

- Visual Studio Code 1.60.0 or higher
- Node.js 14.x or higher
- CDK-NAG installed globally (`npm install -g cdk-nag`)

## Installation

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Press F5 in VS Code to start debugging and test the extension

## Usage

The extension will automatically validate your CDK code when you save files that contain CDK constructs. You can also manually trigger validation using the command palette:

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type "CDK NAG: Validate Current File"
3. Press Enter

## Configuration

You can configure the extension in VS Code settings:

- `cdkNagValidator.enableOnSave`: Enable/disable automatic validation on save (default: true)

## How it Works

The extension uses CDK-NAG to analyze your CDK code and provides:

1. Inline warnings and errors in the editor
2. Detailed explanations of each issue
3. Links to relevant documentation
4. Suggestions for fixing the issues

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License 