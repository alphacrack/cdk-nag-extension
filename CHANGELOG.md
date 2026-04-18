# Changelog

All notable changes to the CDK NAG Validator VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Tag-triggered release workflow** (`.github/workflows/release.yml`) — cutting a release is now `npm version patch && git push --follow-tags`. The workflow refuses to publish if the tag and `package.json` version disagree, runs the full four-layer test battery, packages the `.vsix`, attaches it to a GitHub Release with auto-generated notes, and publishes to the VS Code Marketplace via `npx @vscode/vsce publish` when `VSCE_PAT` is configured.
- **CHANGELOG enforcement workflow** (`.github/workflows/changelog-check.yml`) — every PR that touches `src/`, `package.json`, `.github/workflows/`, `media/`, `.vscodeignore`, or `tsconfig.json` must include a `CHANGELOG.md` change. Doc, chore, dependency, and explicit `skip-changelog`-labelled PRs are exempt.
- **Quick-fix CodeActionProvider** (`src/providers/codeActionProvider.ts`) — registered for TS + JS. Reads `source === 'CDK-NAG'` diagnostics, looks the rule id up in a curated `RULE_DOCS` map, and offers two actions per finding: **Apply suggested fix** (inserts the remediation snippet as a comment block above the flagged construct, preserving leading indentation) and **Suppress "ruleId" for this workspace**. Ships curated fixes for 17 rules covering S3 (`S1`/`S2`/`S3`/`S10`), EC2 security groups (`EC23`/`EC27`), IAM (`IAM4`/`IAM5`), Lambda (`L1`), API Gateway (`APIG1`/`APIG2`), DynamoDB (`DDB3`), RDS (`RDS3`/`RDS6`), CloudFront (`CFR1`), SNS (`SNS2`), and SQS (`SQS3`).
- **HoverProvider** (`src/providers/hoverProvider.ts`) — hovering over a CDK-NAG diagnostic range renders a MarkdownString with rule name, severity, description, remediation snippet (typescript code block), and a link to the upstream cdk-nag RULES.md anchor. Uncurated rule ids fall back to a prefix-level entry (AwsSolutions-/HIPAA.Security-/NIST.800-53./PCI.DSS.321-/Serverless-) so users always get some context.
- **Per-workspace suppressions** — `cdk-nag-validator.suppressFinding` command persists a rule id (or `ruleId:resourceId` tuple) to `.vscode/cdk-nag-config.json` via `ConfigManager.addSuppression`. The command is invoked via CodeAction payload only (hidden from command palette via `"when": "false"`). The runner reads the list on input and filters findings server-side so suppressed rules never re-appear. Diagnostics for the suppressed rule are removed from the `DiagnosticCollection` immediately for instant feedback.
- **Multi-line constructor anchoring** — new `src/resourceParser.ts` replaces the fragile single-line regex (old extension.ts:464) with a brace-balanced scanner that tracks strings, line/block comments, template-literal `${...}` substitutions, and balances nested braces. Handles the two-argument form (`new Bucket(this, 'Id')` with no props), multi-line props objects, and objects containing strings that themselves contain `}`. Unknown tokens no longer silently match — diagnostics now anchor precisely.
- **`src/ruleDocs.ts`** — curated `EXACT_RULE_DOCS` (17 entries) + `PREFIX_RULE_DOCS` (5 fallback entries) keyed by real cdk-nag rule ids. Single source of truth consumed by both the CodeActionProvider and HoverProvider.
- **Jest coverage for providers + parser**: 13 `resourceParser` tests (multi-line, 2-arg form, comments, strings, non-overlap, rejection of `newBucket`), 6 `CodeActionProvider` tests (apply + suppress generation, non-CDK-NAG filtering, multi-diagnostic batching, diagnostics without code), 5 `HoverProvider` tests (position filtering, curated rendering, prefix fallback, non-CDK-NAG filtering, multi-diagnostic merging), and 5 `ConfigManager.addSuppression` / `getSuppressions` tests (append, idempotent, persist to JSON, no-config baseline).
- **Functional coverage for suppressions** — 4 new runner tests verifying baseline, rule-id suppression, `ruleId:resourceId` tuple suppression, and that unknown suppressions are ignored silently.
- **Auto-validate on save** (opt-in via `cdkNagValidator.autoValidate`, default `true`) — new `createSaveListener` debounces rapid saves (500 ms per URI) so format-on-save loops coalesce into a single validation. Only fires for TypeScript / JavaScript files.
- **Progress notification + cancellation** for every validation run. `vscode.window.withProgress` + a cancel button that sends SIGTERM to the runner child process. Cancellation is silent (no "validation failed" popup) when the user initiated it.
- **Async filesystem throughout the validation pipeline** — `fs.promises.mkdtemp` / `writeFile` / `rm` replace their `*Sync` counterparts in `runCdkNag`, so long validations no longer block the extension host event loop.
- Jest coverage for `createSaveListener` (9 new tests: debounce coalescing, language-id gating, auto-validate gating read on every save, dispose cancels pending timers).
- Functional coverage for runner SIGTERM cancellation — the runner exits promptly when killed mid-execution.
- `CDK NAG` LogOutputChannel for structured diagnostic output (replaces 68 scattered `console.log` calls). All logs now respect the user's Log Level setting.
- `migrateLegacyConfig()` activation step: copies user-set values from the legacy `cdk-nag-validator.*` settings namespace to `cdkNagValidator.*` and surfaces a one-shot migration notice.
- Jest unit coverage for `ConfigManager` (round-trip save/load, defaults, malformed JSON fallback, package-detection in dependencies vs devDependencies).
- Marketplace metadata: 128×128 icon (`media/icon.png`), gallery banner, keywords, badges, `bugs` + `homepage` URLs, `Linters` category.
- `.vscodeignore` — trims the published `.vsix` from **48.9 MB → ~214 KB** by excluding `aws-cdk-lib`, `cdk-nag`, `@aws-cdk/*`, layer zips, tests, source maps, and dev-tooling directories (`.vscode-test/`, `.husky/`, `.github/`, `.claude/`, `skills/`, `sample/`). The heavy AWS deps are resolved from the user's workspace at runtime via `require.resolve({ paths: [workspacePath] })`, so bundling them in the VSIX buys nothing.
- Roadmap section + Known Issues section in README — explicit truth-up on which advertised features are shipped vs planned.

### Changed
- `ci.yml` — the `release` job has been removed. Publishing is now tag-driven and lives in `release.yml`. CI on `main` still runs lint + build + all four test layers (via the `All checks passed` aggregate gate) but no longer also attempts to publish on every merge.
- `mapFindingsToSourceLocations` rewritten to consume `parseResourceDefinitions` output instead of the line-by-line regex. Now handles duplicate construct ids (Map of arrays), exposes a `diagnosticSeverity` helper mapping cdk-nag levels (`error`/`warning`/`info`) to `vscode.DiagnosticSeverity`, and only applies the S3 encryption-false-positive guard when the props config was actually parsed.
- `RunnerInput` (and JSON input file) gains an optional `suppressions?: string[]`. The runner post-processes findings, dropping exact rule-id matches and `ruleId:resourceId` tuple matches, before emitting to stdout. Backward-compatible — omitting the field means no suppression (same as today).
- `COMMON_FIXES` map removed from `extension.ts` — it was keyed by made-up ids like `S3_BUCKET_ENCRYPTION` that never matched real diagnostic codes (`AwsSolutions-S1`), so quick-fixes were silently unreachable. Replaced by the real-rule-id-keyed `src/ruleDocs.ts`.
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
- **Multi-line CDK constructors no longer silently miss diagnostic anchoring.** The old regex required the entire `new X(this, 'id', {...})` on one physical line; roughly 80% of real CDK code (including the insecure-stack sample's `new Bucket(this, 'UnencryptedBucket')` two-arg form) was never anchored. The new brace-balanced parser handles both forms across any number of lines.
- **Quick-fixes were previously unreachable** — the old `COMMON_FIXES` map was keyed by fake ids (`S3_BUCKET_ENCRYPTION`) that never matched the real diagnostic codes emitted by the runner (`AwsSolutions-S1`). Rebuilt from scratch against real rule ids and wired through a proper CodeActionProvider.
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