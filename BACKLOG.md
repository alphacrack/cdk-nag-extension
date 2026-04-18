# CDK NAG Validator — Sprint Backlog

**Sprint goal**: Make the extension production-ready in 2 weeks.
**Timeline**: April 11 – April 25, 2026
**Compliance target**: All frameworks (AWS Solutions, HIPAA, NIST, PCI DSS, Serverless)

---

## Week 1: Fix what's broken

### CRITICAL — Must fix before any release

| ID | Title | Category | Effort | Status |
|----|-------|----------|--------|--------|
| C1 | **Fix code injection in runCdkNag shell execution** | Security | L | ✅ Done (commit 5d0388e) |
|    | Previously extension.ts built a `node -e` command by interpolating unsanitized user input directly into shell-executed code. Now uses `spawn` with no shell, `vm.runInContext` sandbox in `cdkNagRunner.ts:44` (zero-global sandbox, 500ms timeout). | | | |
| C2 | **Fix path injection in template file path** | Security | M | ✅ Done (commit 5d0388e) |
|    | Runner now receives input via a JSON file path (argv[2]), nothing interpolated into shells. | | | |
| C3 | **Fix custom rule condition injection** | Security | L | ✅ Done (commit 5d0388e) |
|    | Conditions evaluated in a strictly restricted `vm.createContext` sandbox with no `require`/`process`/`global` and a 500ms timeout. Integration-verified against `require('child_process')`, `process.env`, and infinite-loop inputs. | | | |
| C4 | **Fix Node.js version check bug** | Bug | S | ✅ Done (this branch) |
|    | `version.split('.')[1]` → `[0]` in `extension.ts:392`. | | | |
| C5 | **Remove nonexistent CDK version 2.1018.0** | Bug | S | ✅ Done (this branch) |
|    | `aws-cdk@2.1018.0` → `aws-cdk@latest` in `extension.ts:360-373`. | | | |
| C6 | **Built-in rule packs silently produce zero findings** — [#4](https://github.com/alphacrack/cdk-nag-extension/issues/4) | Bug | L | ✅ Done (this branch) |
|    | `AwsSolutionsChecks`, HIPAA, NIST, PCI DSS, Serverless packs never fired. Root cause: runner called `pack.visit(yaml_parsed_obj)` but `NagPack.visit` expects `IConstruct` and returns `void`. Fixed by building an isolated CDK App per pack, loading the CFN template via `CfnInclude`, capturing findings through a `NagLogger` (`additionalLoggers`), and triggering Aspects via `app.synth()`. End-to-end verified against S3 + SG violations → `S1`/`S10`/`EC23` emitted. | | | |

### HIGH — Required for production

| ID | Title | Category | Effort | Status |
|----|-------|----------|--------|--------|
| H1 | **Unify dual configuration systems** | Architecture | L | ✅ Done (PR 1) |
|    | Settings consolidated under `cdkNagValidator.*`. Legacy `cdk-nag-validator.*` keys auto-migrated on activation via `migrateLegacyConfig()` (extension.ts), with a one-shot user notice. Legacy namespace kept for 2 releases, dropped in v0.3.0. `.vscode/cdk-nag-config.json` (ConfigManager) is reserved for workspace-shared custom rules + suppressions — two scopes, one schema. | | | |
| H2 | **Remove all dead code** | Cleanup | M | ✅ Done (PR 1) |
|    | Removed: `validateCdkCode()`, `validateCurrentFile()`, `shouldValidateFile()`, `shouldShowInlineSuggestions()`, `checkNodeVersion()`, `checkAndInstallAwsCdk()`, `checkCdkNagDependency()`, `installCdkNag()`, and the duplicate unused `configureRules()` function. Extension trimmed from 848 → ~430 lines. `COMMON_FIXES` and `shouldAutoValidate` retained for PR 3a/3b. All 68 `console.log` calls replaced by the `CDK NAG` LogOutputChannel. | | | |
| H3 | **Fix missing await on async configureRules** | Bug | S | ✅ Done (this branch) |
|    | `configureRulesCommand` handler now `async` and awaits `ConfigManager.configureRules`, with error-boundary messaging. | | | |
| H4 | **Fix JSON.parse crash on bad CDK-NAG output** | Bug | S | ✅ Done (this branch) |
|    | `validateFile` wraps `JSON.parse(output)` in try/catch with a preview of the offending output and a user-visible error message. | | | |
| H5 | **Fix race condition in temp directory** | Bug | M | ✅ Done (this branch) |
|    | `extension.ts` now uses `fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-'))` per invocation. Runner uses its own `cdk-nag-runner-*` mkdtemp per pack. | | | |
| H6 | **Stop auto-installing packages in user workspace** | Bug | M | ✅ Done (commit 5d0388e) |
|    | `npm install` is now opt-in via the `cdkNagValidator.autoInstall` setting (default `false`). Verified by `autoInstall default value is false` unit test. | | | |
| H7 | **Fix README: remove false feature claims** | Docs | M | ✅ Done (PR 2) |
|    | README rewritten: dropped unsupported-language claims, marketplace badges replaced with actionable CI/license/engine badges, install instructions corrected (extension not yet on Marketplace), added explicit "Roadmap" and "Known Issues" sections naming which claimed features are actually shipped vs deferred to PR 3a/3b/5/6/7. | | | |

---

## Week 2: Build what's missing + polish

### MEDIUM — Important for usability

| ID | Title | Category | Effort | Status |
|----|-------|----------|--------|--------|
| M1 | **Implement auto-validate on save** | Feature | M | ✅ Done (PR 3a) |
|    | `src/saveListener.ts` exports `createSaveListener({ shouldAutoValidate, validate, log, debounceMs })` — per-URI debounced, gated by setting, re-read on every save (not snapshotted). Wired in `activate()` and registered to `context.subscriptions`. Jest-covered: 9 tests for debounce coalescing, language-id gating, rapid-save deduplication, dispose semantics. | | | |
| M2 | **Implement CodeActionProvider for quick fixes** | Feature | L | ✅ Done (PR 3b) |
|    | `src/providers/codeActionProvider.ts` registered for TS + JS. Curated `RULE_DOCS` map (17 exact rule ids + 5 prefix fallbacks) drives both "Apply suggested fix" (WorkspaceEdit inserts fix comment above flagged construct) and "Suppress this finding" actions. The pre-existing `COMMON_FIXES` stub was deleted — it was keyed by fake ids (`S3_BUCKET_ENCRYPTION`) that never matched real diagnostic codes. | | | |
| M3 | **Fix regex to handle multi-line CDK constructs** | Bug | M | ✅ Done (PR 3b) |
|    | Replaced with `src/resourceParser.ts` — a brace-balanced scanner that tracks strings, line/block comments, and template-literal `${...}` substitutions. Handles multi-line props objects, the two-argument form (no props), and strings that contain `}`. 13 Jest tests lock the behaviour. | | | |
| M4 | **Fix test infrastructure** | Testing | L | ✅ Done (this branch) |
|    | Jest: `vscode` module mocked via `moduleNameMapper` → `src/test/__mocks__/vscode.ts`; `setup.ts` no longer top-level-imports `vscode`. `createDiagnosticCollection` mock now returns a functional stub. Integration: `test:integration` script now compiles first then runs `node out/test/runTest.js`. Mocha suite loader rewritten as `export function run()` with `new Mocha(...).addFile(...).run(cb)` (was using browser API). All three test layers now green: node 12/12, jest 19/19, integration 2/2. | | | |
| M5 | **Update CI workflow** | DevOps | S | Pending |
|    | Update Node matrix to 18.x, 20.x, 22.x (14/16 are EOL). Update actions/checkout and actions/setup-node to v4. | | | |
| M6 | **Update outdated dev dependencies** | Deps | S | Partial (PR 2) |
|    | `@types/vscode` now pinned `~1.96.0` (matches `engines.vscode ^1.96.2`). `vsce@^2.15.0` → `@vscode/vsce@^3.2.1`. `@types/node → ^20.x` and `typescript → 5.x` still pending (deferred to PR 8). | | | |
| M7 | **Add extension icon** | Publishing | S | ✅ Done (PR 2) |
|    | 128×128 `media/icon.png` added (AWS-orange shield-shape on navy). `package.json` now sets `icon`, `galleryBanner`, `badges`, `keywords`, `bugs`, `homepage`, and the `Linters` category. `.vscodeignore` added — VSIX shrinks from 48.9 MB → ~214 KB by excluding heavy AWS deps (resolved from user workspace at runtime). | | | |

### LOW — Nice to have

| ID | Title | Category | Effort | Status |
|----|-------|----------|--------|--------|
| L1 | **Add HoverProvider for finding documentation** | Feature | M | ✅ Done (PR 3b) |
|    | `src/providers/hoverProvider.ts` registered for TS + JS. Filters `vscode.languages.getDiagnostics(uri)` to CDK-NAG source containing the hover position, renders rule name + severity + description + remediation snippet (typescript code block) + link to upstream RULES.md. Curated 17 exact entries; uncurated ids fall back to prefix-level docs. | | | |
| L2 | **Implement suppression support** | Feature | M | ✅ Done (PR 3b) |
|    | `cdk-nag-validator.suppressFinding` command persists to `.vscode/cdk-nag-config.json` via new `ConfigManager.addSuppression`. Runner reads `suppressions` from input JSON and filters findings before emitting — supports both exact rule id (`AwsSolutions-S1`) and `ruleId:resourceId` tuple. Diagnostics for the suppressed rule are removed from the collection immediately so the lightbulb vanishes without waiting for the next validation. | | | |
| L3 | **Replace sync fs calls with async** | Performance | S | ✅ Done (PR 3a) |
|    | `runCdkNag` now uses `fs.promises.mkdtemp`, `fs.promises.writeFile`, `fs.promises.rm` instead of the `*Sync` variants so long validations do not block the extension host. | | | |
| L4 | **Add progress indicator during validation** | UX | S | ✅ Done (PR 3a) |
|    | `runValidationWithProgress` helper wraps every validation entry-point in `vscode.window.withProgress({ location: Notification, cancellable: true })`. The cancel button sends `SIGTERM` to the runner and the extension silently suppresses the resulting `ValidationCancelledError`. | | | |

---

## Effort key

- **S** = Small (< 1 hour)
- **M** = Medium (1–4 hours)
- **L** = Large (4+ hours)

## License & Dependency Audit Results

- **License**: MIT — fully compliant. All deps compatible (Apache-2.0, ISC, BSD-2-Clause, MIT).
- **No NOTICE file needed.**
- **Marketplace readiness**: icon + metadata + slim VSIX landed in PR 2. Tag-triggered release workflow (`.github/workflows/release.yml`) with full test-gate + VSIX GitHub Release asset + Marketplace publish landed in PR 4. The `release` job was removed from `ci.yml` so publishing is decoupled from merge.
- **aws-cdk-lib as production dep**: Stripped from the `.vsix` via `.vscodeignore` in PR 2 (resolved from the user's workspace at runtime). Formal `peerDependencies` migration deferred to PR 8.
- **`vsce` package**: Migrated to `@vscode/vsce@^3.2.1` in PR 2.
