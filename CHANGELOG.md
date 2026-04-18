# Changelog

All notable changes to the CDK NAG Validator VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `CDK NAG` LogOutputChannel for structured diagnostic output (replaces 68 scattered `console.log` calls). All logs now respect the user's Log Level setting.
- `migrateLegacyConfig()` activation step: copies user-set values from the legacy `cdk-nag-validator.*` settings namespace to `cdkNagValidator.*` and surfaces a one-shot migration notice.
- Jest unit coverage for `ConfigManager` (round-trip save/load, defaults, malformed JSON fallback, package-detection in dependencies vs devDependencies).
- Marketplace metadata: 128×128 icon (`media/icon.png`), gallery banner, keywords, badges, `bugs` + `homepage` URLs, `Linters` category.
- `.vscodeignore` — trims the published `.vsix` from **48.9 MB → ~214 KB** by excluding `aws-cdk-lib`, `cdk-nag`, `@aws-cdk/*`, layer zips, tests, source maps, and dev-tooling directories (`.vscode-test/`, `.husky/`, `.github/`, `.claude/`, `skills/`, `sample/`). The heavy AWS deps are resolved from the user's workspace at runtime via `require.resolve({ paths: [workspacePath] })`, so bundling them in the VSIX buys nothing.
- Roadmap section + Known Issues section in README — explicit truth-up on which advertised features are shipped vs planned.

### Changed
- Activation events are now targeted: `onLanguage:typescript`, `onLanguage:javascript`, the three extension commands, and `workspaceContains:**/cdk.json`. The blanket `onStartupFinished` event has been removed so the extension no longer activates on every VS Code startup.
- All settings now consolidated under the `cdkNagValidator.*` namespace (see Deprecated).
- Extension description rewritten to a marketplace-grade single sentence naming the supported rule packs.
- Replaced deprecated `vsce@^2.15.0` devDep with `@vscode/vsce@^3.2.1` (published successor).
- Pinned `@types/vscode` to `~1.96.0` so declared API surface cannot drift ahead of `engines.vscode ^1.96.2`. Fixes the CI release job failure "`@types/vscode` greater than `engines.vscode`".

### Deprecated
- Settings under the `cdk-nag-validator.*` namespace (currently only `useProjectCdkNag` and `defaultRules`). Values will be auto-migrated to `cdkNagValidator.*` on extension activation. The legacy namespace will be **removed in v0.3.0**.

### Removed
- Internal dead code: `validateCdkCode`, `validateCurrentFile`, `shouldValidateFile`, `shouldShowInlineSuggestions`, `checkNodeVersion`, `checkAndInstallAwsCdk`, `checkCdkNagDependency`, `installCdkNag`, and a duplicate unused `configureRules` function. Extension entry-point trimmed from ~848 to ~430 lines with no behaviour change for end users.
- README claims for features that are not yet wired up (real-time validation on save, quick-fix lightbulbs, hover docs, Python / Java CDK support). Those features remain on the roadmap and are tracked per-PR in the Roadmap section.

### Fixed
- CI release job will now successfully run `npm run package` — the `@types/vscode` version mismatch was blocking the VSIX build.

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