# Contributing to CDK NAG Validator

Thanks for your interest in contributing. This document defines the **merge gate** — the rules a change must satisfy before it lands on `main` — and the workflow for getting a PR through it.

## Merge gate — hard rules

A PR does **not** merge until **all** of the following are true:

1. **All CI jobs green** — the aggregate `All checks passed` status check (which waits on `lint`, `build` across Node 18/20/22, `unit`, `jest`, `functional`, and `integration`) must succeed. Enforced via branch protection on `main`.
2. **No skipped tests** — if a test is skipped (`.skip`, `xit`, `xdescribe`, commented-out code), the PR must explain why in the description and link an issue to re-enable it.
3. **No `--no-verify`, `--force`, or `[skip ci]`** — if a pre-commit hook fails, fix the underlying issue; don't bypass it.
4. **At least one approving review** from a maintainer.
5. **Branch is up to date** with target.

The single required status check is `All checks passed`. It aggregates every sub-job so one required check covers the whole pipeline.

## Running the gate locally

```bash
npm ci
npm run test:all
```

`test:all` runs the exact sequence CI runs, in order. If this passes locally on a clean checkout, CI will pass.

## Test layers

| Layer | Command | Purpose |
|-------|---------|---------|
| Lint | `npm run lint` | Style + hygiene. Auto-fix with `npm run lint:fix`. |
| Compile | `npm run compile` | TypeScript correctness across Node 18/20/22. |
| Unit (sandbox) | `npm test` | `node:test` runner for the custom-rule vm sandbox. |
| Unit (Jest) | `npm run test:jest` | VS Code API mocks, config defaults. |
| Functional | `npm run test:functional` | Drives `out/cdkNagRunner.js` against CFN fixtures; asserts specific findings. Regression gate for [#4](https://github.com/alphacrack/cdk-nag-extension/issues/4). |
| Integration | `npm run test:integration` | Spawns a real VS Code process; verifies activation and command registration. Linux CI runs this under xvfb. |

## When you must add a test

Not optional for these changes:

- **Runner or rule-pack flow** — add a fixture under `src/test/functional/fixtures/` and an assertion in `runner.test.mjs` that would fail without your change.
- **Sandbox / custom-rule evaluation** — add an adversarial case in `src/test/runner-unit.mjs` *and* a corresponding integration case in `src/test/functional/runner.test.mjs`.
- **Extension commands or activation** — add or update a case in `src/test/suite/extension.test.ts`.
- **VS Code API usage in new files** — extend `src/test/__mocks__/vscode.ts` and the Jest suite.

## Manual smoke test before marking ready for review

1. F5 the Extension Development Host.
2. Open `sample/insecure-stack.ts` (or any CDK file in a project with `cdk.json`).
3. Run `CDK NAG: Validate Current File` from the Command Palette.
4. Confirm findings appear in the Problems panel.

If you touched the rule-pack path, the S3 + SG sample must still produce `AwsSolutions-S1`, `S10`, and `EC23` findings.

## Prerequisites

- Node.js 18.x, 20.x, or 22.x
- npm 9.x or higher
- VS Code 1.96.2 or higher

## Getting started

```bash
git clone https://github.com/alphacrack/cdk-nag-extension.git
cd cdk-nag-extension
npm ci
npm run compile
npm run test:all
```

## Commit + PR hygiene

- One logical change per PR.
- Commit messages explain **why**, not just what.
- Fill out the PR template honestly. The "How this was tested" checklist is load-bearing.
- Never commit `.env`, credentials, or anything resembling a token.

## Destructive-action policy

- **Never force-push to `main`.**
- **Never amend or rebase commits that are already on `main`.**
- Rebasing your own PR branch before merge is fine.

## Release process

1. Bump `version` in `package.json`.
2. Update `CHANGELOG.md`.
3. Push to `main` (through a normal PR).
4. GitHub Actions `release` job runs only on `main` and only after `All checks passed`; it packages + publishes to the VS Code Marketplace using `VSCE_PAT`.

## Setting up / verifying branch protection (maintainers)

```bash
gh api -X PUT repos/alphacrack/cdk-nag-extension/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["All checks passed"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON
```

Verify with `gh api repos/alphacrack/cdk-nag-extension/branches/main/protection`.

## License

By contributing to CDK NAG Validator, you agree that your contributions will be licensed under the project's MIT License.
