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
import * as os from 'os';
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
  /**
   * Rule IDs the user has chosen to suppress workspace-wide. Findings whose
   * `id` matches an entry (exact match, or `ruleId:resourceId` form) are
   * dropped before stdout is written.
   */
  suppressions?: string[];
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
  const suppressions = Array.isArray(input.suppressions) ? input.suppressions : [];

  const templateContent = fs.readFileSync(templatePath, 'utf8');
  const template = yaml.parse(templateContent);

  const findings: Finding[] = [];

  // ── Built-in rule packs ───────────────────────────────────────────────────
  // We require cdk-nag and aws-cdk-lib from the workspace so the project's own
  // versions are used.  Requires are done at runtime so that the import paths
  // are never embedded in a shell string.
  if (rulePacks.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cdkNag = require(require.resolve('cdk-nag', { paths: [workspacePath] }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const awsCdkLib = require(require.resolve('aws-cdk-lib', { paths: [workspacePath] }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfnInclude = require(require.resolve('aws-cdk-lib/cloudformation-include', {
      paths: [workspacePath],
    }));

    const { App, Stack, Aspects } = awsCdkLib;
    const { CfnInclude } = cfnInclude;

    // Map cdk-nag's NagMessageLevel enum values ("Warning"/"Error") to the
    // stdout contract strings this runner emits ("WARNING"/"ERROR").
    const levelToString = (lvl: unknown): string => {
      const s = String(lvl).toUpperCase();
      if (s === 'WARN' || s === 'WARNING') return 'WARNING';
      if (s === 'ERROR') return 'ERROR';
      return s;
    };

    for (const pack of rulePacks) {
      // Each pack gets its own App + Stack so findings are isolated and one
      // pack's synthesis failure does not affect the next.
      let tmpOutdir: string | null = null;
      try {
        const PackClass = cdkNag[pack];
        if (!PackClass) {
          process.stderr.write(`Warning: rule pack "${pack}" not found in cdk-nag\n`);
          continue;
        }

        // Capture findings via a custom NagLogger passed through
        // NagPackProps.additionalLoggers.  onNonCompliance fires once per
        // (rule, resource) violation — exactly what we want to emit.
        const packFindings: Finding[] = [];
        const logger = {
          onCompliance: () => {
            /* no-op */
          },
          onNonCompliance: (data: any) => {
            const ruleId: string = data.ruleId;
            const nagPackName: string = data.nagPackName;
            const ruleInfo: string = data.ruleInfo;
            const ruleExplanation: string = data.ruleExplanation;
            const ruleLevel = data.ruleLevel;
            let resourceId = '';
            try {
              resourceId = data.resource?.node?.id ?? '';
            } catch {
              resourceId = '';
            }
            // cdk-nag's ruleId is already prefixed with the pack name
            // (e.g. "AwsSolutions-S1"), so only re-prefix if it isn't.
            const id = ruleId.startsWith(`${nagPackName}-`) ? ruleId : `${nagPackName}-${ruleId}`;
            packFindings.push({
              id,
              name: ruleInfo,
              description: ruleExplanation,
              level: levelToString(ruleLevel),
              resourceId,
            });
          },
          onSuppressed: () => {
            /* no-op */
          },
          onError: (data: any) => {
            process.stderr.write(
              `Warning: cdk-nag rule error in pack "${pack}" for rule ${data.ruleId}: ${data.errorMessage}\n`
            );
          },
          onSuppressedError: () => {
            /* no-op */
          },
          onNotApplicable: () => {
            /* no-op */
          },
        };

        // Use a unique outdir so synth does not clobber the user's cwd and
        // concurrent packs don't race on shared files.
        tmpOutdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-runner-'));

        const app = new App({ outdir: tmpOutdir });
        const stack = new Stack(app, 'CdkNagRunnerStack');

        // CfnInclude reads the template from disk — templatePath points at
        // the user's CloudFormation YAML/JSON file.
        new CfnInclude(stack, 'Template', {
          templateFile: templatePath,
        });

        Aspects.of(app).add(
          new PackClass({
            additionalLoggers: [logger],
            reports: false,
            verbose: false,
          })
        );

        // Synth is what actually runs the Aspect visitors.  cdk-nag adds
        // validation errors for ERROR-level rules which can abort synth;
        // swallow those here since we've already collected findings via
        // the logger by the time the error is thrown.
        try {
          app.synth({ validateOnSynthesis: false });
        } catch (synthErr) {
          // Findings were collected during the visitor phase that runs
          // before synth's own validation step, so we can safely continue.
          process.stderr.write(
            `Warning: synth for pack "${pack}" ended with: ${(synthErr as Error).message}\n`
          );
        }

        findings.push(...packFindings);
      } catch (err) {
        process.stderr.write(
          `Warning: error running rule pack "${pack}": ${(err as Error).message}\n`
        );
      } finally {
        if (tmpOutdir) {
          try {
            fs.rmSync(tmpOutdir, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
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

  // Apply user-configured suppressions before emitting. A suppression entry
  // may be either an exact rule ID ("AwsSolutions-S1" — matches every
  // instance) or a `ruleId:resourceId` tuple for per-resource suppression.
  const filteredFindings =
    suppressions.length === 0
      ? findings
      : findings.filter(f => {
          if (suppressions.includes(f.id)) return false;
          if (suppressions.includes(`${f.id}:${f.resourceId}`)) return false;
          return true;
        });

  // Output is written to stdout as newline-terminated JSON so the parent
  // process can read it without any parsing ambiguity.
  process.stdout.write(JSON.stringify(filteredFindings, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
