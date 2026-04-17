# Security Policy

## Supported versions

Only the latest published version of `cdk-nag-validator` on the VS Code Marketplace receives security fixes. There is no LTS track.

| Version | Supported |
|---------|-----------|
| Latest marketplace release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Use GitHub's private vulnerability reporting:

1. Go to https://github.com/alphacrack/cdk-nag-extension/security/advisories/new
2. Fill in the advisory with enough detail to reproduce.
3. A maintainer will respond within 5 business days with an acknowledgement and a rough remediation timeline.

If you cannot use GitHub's advisory flow, you can also report to **[security@alphacrack.dev](mailto:security@alphacrack.dev)** — replace with your preferred contact; this address is illustrative. <!-- gitleaks:allow -->

## Scope

In scope:
- The extension code in `src/`.
- The CI workflows in `.github/workflows/`.
- The custom-rule sandbox (`evaluateConditionSafely` in `src/cdkNagRunner.ts`).
- Any dependency advisories that affect shipping behavior.

Out of scope (file a public issue instead):
- Issues in user-authored custom rules — the sandbox is the contract, not the user's condition logic.
- Usability bugs in the upstream cdk-nag library.
- Behavior specific to unsupported Node or VS Code versions.

## What we scan for

Every PR and every `main` push goes through these scans; none can be skipped:

| Scan | Trigger | Blocks merge on |
|------|---------|-----------------|
| `Gitleaks` | `.github/workflows/security.yml` | Any detected secret or PII pattern (rules in `.gitleaks.toml`) |
| `GitHub native secret scanning + push protection` | Server-side, always on | Known provider-issued tokens detected pre-push |
| `npm audit --omit=dev --audit-level=critical` | `.github/workflows/security.yml` | Any critical-severity vulnerability in production dependencies |
| `CodeQL` | `.github/workflows/security.yml` | High/critical static-analysis findings |
| `Dependabot` | `.github/dependabot.yml` | Opens PRs for security advisories immediately; non-security bumps grouped weekly |
| `Sandbox injection tests` | `src/test/functional/runner.test.mjs` + `src/test/runner-unit.mjs` | Any regression where `require`, `process`, globals, or infinite loops escape the custom-rule vm sandbox |

The aggregate job `Security — all scans passed` is a **required status check** on `main` in branch protection; merges are blocked until every scan succeeds.

## What to do if a secret is accidentally committed

1. **Rotate the secret immediately** — a credential in any public git history should be considered compromised regardless of whether it's been "removed" from the latest commit.
2. Open a private security advisory using the link above so maintainers can coordinate.
3. Do NOT `git push --force` to rewrite history until rotation is complete — it draws attention to the problem and a committed secret is already indexed.

## Sandbox guarantees

Custom rules are evaluated with Node's `vm.runInContext` inside a sandbox that:

- Has **no** `require`, `process`, `global`, or any Node built-in bound.
- Has a **500 ms** execution timeout that fires via `vm.runInContext`'s built-in timer.
- Receives only a single `resource` binding — the current CloudFormation resource object.
- Is rebuilt for every condition evaluation (no state leaks between rules).

A broken sandbox is a critical issue. The regression test for the sandbox lives in [src/test/runner-unit.mjs](src/test/runner-unit.mjs) and [src/test/functional/runner.test.mjs](src/test/functional/runner.test.mjs); if either is weakened, reject the PR.
