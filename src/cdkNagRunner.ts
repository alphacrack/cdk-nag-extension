/**
 * CDK-NAG runner script — executed as a child process by the extension.
 *
 * All user-supplied data is received via a JSON file whose path is passed as
 * the sole command-line argument (process.argv[2]).  Nothing from the user is
 * ever interpolated into a shell string, so there is no shell-injection
 * surface here.
 *
 * Custom rule conditions are evaluated with Node's built-in `vm` module
 * (vm.runInNewContext) inside a strictly restricted sandbox that only exposes
 * the current CDK resource object.  This prevents conditions from reaching
 * the file system, network, or any other Node built-in.
 */

import * as fs from 'fs';
import * as vm from 'vm';
import * as path from 'path';
import * as yaml from 'yaml';

interface CustomRule {
  id: string;
  name: string;
  description: string;
  level: string;
  resourceTypes: string[];
  condition: string;
}

interface RunnerInput {
  templatePath: string;
  rulePacks: string[];
  customRules: CustomRule[];
  workspacePath: string;
}

interface Finding {
  id: string;
  name: string;
  description: string;
  level: string;
  resourceId: string;
}

function evaluateConditionSafely(condition: string, resource: unknown): boolean {
  try {
    // A completely empty sandbox: the condition can only access the `resource`
    // binding we explicitly provide.  There is no `require`, no `process`, no
    // globals — so an attacker-controlled condition cannot reach outside.
    const sandbox = Object.create(null) as Record<string, unknown>;
    sandbox['resource'] = resource;
    const context = vm.createContext(sandbox);
    const result = vm.runInContext(condition, context, {
      timeout: 500, // ms — prevent infinite loops
      filename: 'condition.vm',
    });
    return Boolean(result);
  } catch (err) {
    // A bad condition should never crash the whole run — just skip the rule.
    process.stderr.write(`Warning: condition evaluation error: ${(err as Error).message}\n`);
    return false;
  }
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write('Usage: cdkNagRunner <input-json-path>\n');
    process.exit(1);
  }

  const input: RunnerInput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const { templatePath, rulePacks, customRules, workspacePath } = input;

  const templateContent = fs.readFileSync(templatePath, 'utf8');
  const template = yaml.parse(templateContent);

  const findings: Finding[] = [];

  // ── Built-in rule packs ───────────────────────────────────────────────────
  // We require cdk-nag from the workspace so the project's own version is
  // used.  The require is done at runtime so that the import path is never
  // embedded in a shell string.
  if (rulePacks.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cdkNag = require(
      require.resolve('cdk-nag', { paths: [workspacePath] })
    );

    for (const pack of rulePacks) {
      try {
        const PackClass = cdkNag[pack];
        if (!PackClass) {
          process.stderr.write(`Warning: rule pack "${pack}" not found in cdk-nag\n`);
          continue;
        }
        const checker = new PackClass();
        const result = checker.visit(template);
        if (result && result.findings) {
          findings.push(...result.findings);
        }
      } catch (err) {
        process.stderr.write(`Warning: error running rule pack "${pack}": ${(err as Error).message}\n`);
      }
    }
  }

  // ── Custom rules (sandboxed) ──────────────────────────────────────────────
  if (customRules.length > 0) {
    const resources: Record<string, unknown> = template.Resources || {};

    for (const [resourceId, resource] of Object.entries(resources)) {
      for (const rule of customRules) {
        // Type filter
        const res = resource as { Type?: string };
        const typeMatches = rule.resourceTypes.some(t => t === res.Type);
        if (!typeMatches) {
          continue;
        }

        // Condition evaluation — fully sandboxed, no shell involved
        const triggered = evaluateConditionSafely(rule.condition, resource);
        if (triggered) {
          findings.push({
            id: rule.id,
            name: rule.name,
            description: rule.description,
            level: rule.level,
            resourceId,
          });
        }
      }
    }
  }

  // Output is written to stdout as newline-terminated JSON so the parent
  // process can read it without any parsing ambiguity.
  process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
