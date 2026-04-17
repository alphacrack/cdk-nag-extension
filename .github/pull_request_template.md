<!--
Thanks for contributing. A PR cannot merge until every CI job is green.
The merge gate is enforced by branch protection on `main`; the
`All checks passed` job is the single required status check and it
aggregates lint + build + unit + jest + functional + integration.
-->

## Summary

<!-- What does this change and why. Link the issue it closes, e.g. `Closes #42`. -->

## Change category

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / cleanup
- [ ] Docs / CI
- [ ] Security

## How this was tested

Fill this in honestly — "CI is green" is the floor, not the ceiling.

- [ ] `npm run test:all` passes locally (lint → compile → unit → jest → functional → integration).
- [ ] If the change touches the runner or rule-pack flow: added a fixture + assertion in `src/test/functional/` that would fail without this change.
- [ ] If the change touches the extension host surface (commands, activation, diagnostics): added or updated a test in `src/test/suite/`.
- [ ] If the change touches the sandbox: added an adversarial case in `src/test/runner-unit.mjs` and `src/test/functional/runner.test.mjs`.
- [ ] If the change is user-visible: README updated (no new false feature claims).

## Manual verification

- [ ] F5'd the Extension Development Host against `sample/insecure-stack.ts` (or another CDK sample) and confirmed the expected diagnostics appear in the Problems panel.
- [ ] If the default `AwsSolutionsChecks` pack is involved: confirmed findings still fire against an unencrypted S3 bucket (regression check for [#4](https://github.com/alphacrack/cdk-nag-extension/issues/4)).

## Risk and rollback

<!-- One sentence each. -->

- **Blast radius**:
- **Rollback**: revert this commit; no data migrations.

## Reviewer checklist

- [ ] Tests genuinely exercise the change (not just coverage theatre).
- [ ] No secrets, credentials, or customer data in the diff.
- [ ] No new dependencies without justification in the PR description.
- [ ] No `--no-verify`, `--force`, or skipped CI.

## Security checklist

- [ ] No API keys, tokens, private keys, credentials, or connection strings in code, tests, or fixtures.
- [ ] No PII in tests or fixtures (real names, emails, phone numbers, SSNs, payment data). Use `example.com` / `test@example.com` / `555-01XX` ranges; if a realistic-looking value is required for a test, add an inline `# gitleaks:allow` comment with justification.
- [ ] If adding a dependency: checked `npm audit --omit=dev` against it; noted severity in the PR description.
- [ ] If changing the custom-rule sandbox: added adversarial cases in both `src/test/runner-unit.mjs` and `src/test/functional/runner.test.mjs`.
- [ ] Confirmed the `Security — all scans passed` CI job is green (gitleaks + npm audit + CodeQL).
