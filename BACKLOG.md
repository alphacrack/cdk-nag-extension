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
| M1 | **Implement auto-validate on save** | Feature | M | Pending |
|    | Register `onDidSaveTextDocument` listener gated by `autoValidate` setting. The setting exists but is never used. | | | |
| M2 | **Implement CodeActionProvider for quick fixes** | Feature | L | Pending |
|    | Wire up `COMMON_FIXES` map to a registered CodeActionProvider so users get lightbulb suggestions. | | | |
| M3 | **Fix regex to handle multi-line CDK constructs** | Bug | M | Pending |
|    | Line 464 regex only matches single-line `new Foo(this, 'id', {...})`. Real CDK code spans multiple lines. Use AST parsing or multiline-aware regex. | | | |
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
| L1 | **Add HoverProvider for finding documentation** | Feature | M | Pending |
|    | Show remediation guidance on hover over CDK-NAG diagnostics. | | | |
| L2 | **Implement suppression support** | Feature | M | Pending |
|    | ConfigManager defines `suppressions` array but it's never used. Allow users to suppress specific findings. | | | |
| L3 | **Replace sync fs calls with async** | Performance | S | Pending |
|    | Lines 336, 351, 699–700 use `readFileSync` in async context. Switch to `fs.promises`. | | | |
| L4 | **Add progress indicator during validation** | UX | S | Pending |
|    | `cdk synth` can take 30+ seconds. Show `vscode.window.withProgress()` to the user. | | | |

---

## Effort key

- **S** = Small (< 1 hour)
- **M** = Medium (1–4 hours)
- **L** = Large (4+ hours)

## License & Dependency Audit Results

- **License**: MIT — fully compliant. All deps compatible (Apache-2.0, ISC, BSD-2-Clause, MIT).
- **No NOTICE file needed.**
- **Marketplace readiness**: icon + metadata + slim VSIX landed in PR 2. Remaining: Marketplace publish wiring is PR 4's release workflow.
- **aws-cdk-lib as production dep**: Stripped from the `.vsix` via `.vscodeignore` in PR 2 (resolved from the user's workspace at runtime). Formal `peerDependencies` migration deferred to PR 8.
- **`vsce` package**: Migrated to `@vscode/vsce@^3.2.1` in PR 2.
