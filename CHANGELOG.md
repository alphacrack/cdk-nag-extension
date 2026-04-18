# Changelog

All notable changes to the CDK NAG Validator VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `CDK NAG` LogOutputChannel for structured diagnostic output (replaces 68 scattered `console.log` calls). All logs now respect the user's Log Level setting.
- `migrateLegacyConfig()` activation step: copies user-set values from the legacy `cdk-nag-validator.*` settings namespace to `cdkNagValidator.*` and surfaces a one-shot migration notice.
- Jest unit coverage for `ConfigManager` (round-trip save/load, defaults, malformed JSON fallback, package-detection in dependencies vs devDependencies).

### Changed
- Activation events are now targeted: `onLanguage:typescript`, `onLanguage:javascript`, the three extension commands, and `workspaceContains:**/cdk.json`. The blanket `onStartupFinished` event has been removed so the extension no longer activates on every VS Code startup.
- All settings now consolidated under the `cdkNagValidator.*` namespace (see Deprecated).

### Deprecated
- Settings under the `cdk-nag-validator.*` namespace (currently only `useProjectCdkNag` and `defaultRules`). Values will be auto-migrated to `cdkNagValidator.*` on extension activation. The legacy namespace will be **removed in v0.3.0**.

### Removed
- Internal dead code: `validateCdkCode`, `validateCurrentFile`, `shouldValidateFile`, `shouldShowInlineSuggestions`, `checkNodeVersion`, `checkAndInstallAwsCdk`, `checkCdkNagDependency`, `installCdkNag`, and a duplicate unused `configureRules` function. Extension entry-point trimmed from ~848 to ~430 lines with no behaviour change for end users.

### Fixed
- None

### Security
- None

## [0.0.1] - 2024-03-19

### Added
- Initial release
- Basic CDK-NAG validation functionality
- Support for TypeScript and JavaScript CDK code
- Inline suggestions for security and compliance issues
- Configuration options for rule packs
- Automatic validation on file save 