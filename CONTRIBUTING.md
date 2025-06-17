# Contributing to CDK NAG Validator

Thank you for your interest in contributing to CDK NAG Validator! This document provides guidelines and instructions for contributing to this project.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the issue list as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- Use a clear and descriptive title
- Describe the exact steps to reproduce the problem
- Provide specific examples to demonstrate the steps
- Describe the behavior you observed after following the steps
- Explain which behavior you expected to see instead and why
- Include screenshots if possible
- Include the version of VS Code and the extension
- Include the version of CDK and CDK-NAG you're using

### Suggesting Enhancements

If you have a suggestion for a new feature or enhancement, please:

- Use a clear and descriptive title
- Provide a detailed description of the proposed functionality
- Explain why this enhancement would be useful
- List any similar features in other extensions

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. If you've changed APIs, update the documentation
4. Ensure the test suite passes
5. Make sure your code lints
6. Issue that pull request!

## Development Setup

### Prerequisites

- Node.js 14.x or higher
- npm 6.x or higher
- VS Code Extension Development Tools

### Getting Started

1. Fork and clone the repository
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

### Development Workflow

1. Create a new branch for your feature/fix
2. Make your changes
3. Run tests and ensure they pass
4. Update documentation if necessary
5. Submit a pull request

### Testing

We use Jest for testing. To run tests:

```bash
npm test
```

For watching mode:

```bash
npm run test:watch
```

### Code Style

We use ESLint for code linting. To check your code:

```bash
npm run lint
```

To automatically fix linting issues:

```bash
npm run lint:fix
```

### Documentation

- Update README.md if you're changing functionality
- Add JSDoc comments for new functions
- Update CHANGELOG.md with your changes

## Release Process

1. Update version in package.json
2. Update CHANGELOG.md
3. Create a new release on GitHub
4. Publish to VS Code Marketplace

## Questions?

Feel free to open an issue for any questions you might have about contributing.

## License

By contributing to CDK NAG Validator, you agree that your contributions will be licensed under the project's MIT License. 