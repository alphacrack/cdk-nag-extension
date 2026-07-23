// Curated documentation + remediation hints for cdk-nag rules.
//
// This file is the single source of truth for:
//   • HoverProvider content (rule name, severity, remediation, doc link)
//   • CodeActionProvider quick-fix text (when a static fix template exists)
//
// We key by the exact cdk-nag rule identifier as it appears in a finding —
// e.g. `AwsSolutions-S1`, `HIPAA.Security-S3BucketVersioningEnabled`.
// Prefix-level defaults (keyed by `<NagPack>-*`) handle the long tail of
// rules we have not hand-curated yet.
//
// Why curated rather than introspected from cdk-nag's runtime metadata?
// cdk-nag exposes `ruleInfo` / `ruleExplanation` per finding, so the runtime
// diagnostic already carries a usable blurb. What this map adds is the
// *actionable* remediation snippet (for CodeActions) and the stable
// documentation URL. The curated set starts small and grows as users file
// coverage gaps (tracked in the BACKLOG).

export interface RuleDoc {
  /** Human-readable rule name (e.g. "S3 Bucket Server Access Logging"). */
  name: string;
  /** One-sentence explanation. */
  description: string;
  /** Low-level severity hint to complement diagnostic.severity. */
  severity: 'error' | 'warning' | 'info';
  /** Optional CDK code snippet that fixes the finding. Used by CodeActionProvider. */
  fix?: string;
  /** Stable URL to the upstream rule documentation. */
  docUrl?: string;
}

const CDK_NAG_RULES_README = 'https://github.com/cdklabs/cdk-nag/blob/main/RULES.md';

/** Curated rule docs keyed by exact cdk-nag rule ID. */
const EXACT_RULE_DOCS: { [ruleId: string]: RuleDoc } = {
  'AwsSolutions-S1': {
    name: 'S3 Bucket Server Access Logging Disabled',
    description: 'The S3 Bucket does not have server access logging enabled.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  serverAccessLogsBucket: loggingBucket,
  serverAccessLogsPrefix: 'access-logs/',
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-s1`,
  },
  'AwsSolutions-S2': {
    name: 'S3 Bucket Public Access',
    description: 'The S3 Bucket does not have public access restricted and blocked.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-s2`,
  },
  'AwsSolutions-S3': {
    name: 'S3 Bucket Default Encryption Disabled',
    description: 'The S3 Bucket does not have default encryption enabled.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  encryption: s3.BucketEncryption.S3_MANAGED,
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-s3`,
  },
  'AwsSolutions-S10': {
    name: 'S3 Bucket SSL Requests Only',
    description: 'The S3 Bucket or Bucket Policy does not require requests to use SSL.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  enforceSSL: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-s10`,
  },
  'AwsSolutions-EC23': {
    name: 'Security Group Inbound Access Unrestricted',
    description: 'The Security Group allows unrestricted inbound access (0.0.0.0/0 or ::/0).',
    severity: 'error',
    fix: `// Restrict the ingress source to a specific CIDR or security group:
sg.addIngressRule(
  ec2.Peer.ipv4('10.0.0.0/16'),
  ec2.Port.tcp(22),
  'Allow SSH from internal network only',
);`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-ec23`,
  },
  'AwsSolutions-EC27': {
    name: 'Security Group has no Description',
    description: 'The Security Group does not have a description.',
    severity: 'warning',
    fix: `new ec2.SecurityGroup(this, 'Sg', {
  vpc,
  description: 'Purpose of this security group',
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-ec27`,
  },
  'AwsSolutions-IAM4': {
    name: 'IAM Managed Policy',
    description:
      'The IAM user, role, or group uses AWS managed policies — prefer customer-managed policies scoped to least-privilege.',
    severity: 'warning',
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-iam4`,
  },
  'AwsSolutions-IAM5': {
    name: 'IAM Policy with Wildcards',
    description: 'The IAM policy contains wildcards (`*`) in Actions or Resources.',
    severity: 'error',
    fix: `// Scope the policy to specific actions and resources:
new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [bucket.arnForObjects('*')],
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-iam5`,
  },
  'AwsSolutions-L1': {
    name: 'Lambda Runtime Outdated',
    description: 'The Lambda function is not using the latest supported runtime.',
    severity: 'warning',
    fix: `new lambda.Function(this, 'Fn', {
  runtime: lambda.Runtime.NODEJS_20_X,
  // ...
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-l1`,
  },
  'AwsSolutions-APIG1': {
    name: 'API Gateway Access Logging',
    description: 'The API Gateway stage does not have access logging enabled.',
    severity: 'error',
    fix: `new apigateway.RestApi(this, 'Api', {
  deployOptions: {
    accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
    accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
  },
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-apig1`,
  },
  'AwsSolutions-APIG2': {
    name: 'API Gateway Request Validation',
    description: 'The REST API does not have request validation enabled.',
    severity: 'warning',
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-apig2`,
  },
  'AwsSolutions-DDB3': {
    name: 'DynamoDB Point-in-Time Recovery',
    description: 'The DynamoDB table does not have point-in-time recovery enabled.',
    severity: 'warning',
    fix: `new dynamodb.Table(this, 'Table', {
  pointInTimeRecovery: true,
  // ...
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-ddb3`,
  },
  'AwsSolutions-RDS3': {
    name: 'RDS Multi-AZ Disabled',
    description: 'The RDS DB instance does not have multi-AZ support enabled.',
    severity: 'warning',
    fix: `new rds.DatabaseInstance(this, 'Db', {
  multiAz: true,
  // ...
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-rds3`,
  },
  'AwsSolutions-RDS6': {
    name: 'RDS IAM Database Authentication',
    description: 'The RDS DB instance or cluster does not have IAM authentication enabled.',
    severity: 'warning',
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-rds6`,
  },
  'AwsSolutions-CFR1': {
    name: 'CloudFront Geo Restrictions',
    description: 'The CloudFront distribution does not have geographic restrictions configured.',
    severity: 'info',
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-cfr1`,
  },
  'AwsSolutions-SNS2': {
    name: 'SNS Topic Encryption at Rest',
    description: 'The SNS topic does not have encryption at rest enabled.',
    severity: 'error',
    fix: `new sns.Topic(this, 'Topic', {
  masterKey: kms.Key.fromKeyArn(this, 'Key', keyArn),
});`,
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-sns2`,
  },
  'AwsSolutions-SQS3': {
    name: 'SQS Dead-Letter Queue',
    description: 'The SQS queue is not configured with a dead-letter queue.',
    severity: 'warning',
    docUrl: `${CDK_NAG_RULES_README}#awssolutions-sqs3`,
  },

  // HIPAA Security pack — regulated-workload rules with static remediations.
  'HIPAA.Security-S3BucketVersioningEnabled': {
    name: 'S3 Bucket Versioning Enabled',
    description: 'The S3 Bucket does not have versioning enabled.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  versioned: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#hipaa.security-s3bucketversioningenabled`,
  },
  'HIPAA.Security-S3BucketSSLRequestsOnly': {
    name: 'S3 Bucket SSL Requests Only',
    description: 'The S3 Bucket or bucket policy does not require requests to use SSL.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  enforceSSL: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#hipaa.security-s3bucketsslrequestsonly`,
  },
  'HIPAA.Security-CloudTrailCloudWatchLogsEnabled': {
    name: 'CloudTrail CloudWatch Logs Enabled',
    description: 'The trail does not have CloudWatch logs enabled.',
    severity: 'error',
    fix: `new cloudtrail.Trail(this, 'Trail', {
  sendToCloudWatchLogs: true,
  cloudWatchLogGroup: logGroup,
});`,
    docUrl: `${CDK_NAG_RULES_README}#hipaa.security-cloudtrailcloudwatchlogsenabled`,
  },
  'HIPAA.Security-CloudTrailLogFileValidationEnabled': {
    name: 'CloudTrail Log File Validation Enabled',
    description: 'The trail does not have log file validation enabled.',
    severity: 'error',
    fix: `new cloudtrail.Trail(this, 'Trail', {
  enableFileValidation: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#hipaa.security-cloudtraillogfilevalidationenabled`,
  },
  'HIPAA.Security-RDSStorageEncrypted': {
    name: 'RDS Storage Encrypted',
    description: 'The RDS DB instance or Aurora DB cluster does not have storage encrypted.',
    severity: 'error',
    fix: `new rds.DatabaseInstance(this, 'Db', {
  storageEncrypted: true,
  // ...
});`,
    docUrl: `${CDK_NAG_RULES_README}#hipaa.security-rdsstorageencrypted`,
  },
  'HIPAA.Security-IAMPolicyNoStatementsWithAdminAccess': {
    name: 'IAM Policy No Statements With Admin Access',
    description: 'The IAM policy grants admin access, allowing a principal to perform all actions on all resources.',
    severity: 'error',
    fix: `// Scope the policy instead of granting '*' on '*':
new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [bucket.arnForObjects('*')],
});`,
    docUrl: `${CDK_NAG_RULES_README}#hipaa.security-iampolicynostatementswithadminaccess`,
  },

  // NIST 800-53 rev 5 pack — mirrors the HIPAA Security entries above where
  // the underlying cdk-nag check (and remediation) is the same.
  'NIST.800.53.R5-S3BucketVersioningEnabled': {
    name: 'S3 Bucket Versioning Enabled',
    description: 'The S3 Bucket does not have versioning enabled.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  versioned: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#nist.800.53.r5-s3bucketversioningenabled`,
  },
  'NIST.800.53.R5-S3BucketSSLRequestsOnly': {
    name: 'S3 Bucket SSL Requests Only',
    description: 'The S3 Bucket or bucket policy does not require requests to use SSL.',
    severity: 'error',
    fix: `new s3.Bucket(this, 'Bucket', {
  enforceSSL: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#nist.800.53.r5-s3bucketsslrequestsonly`,
  },
  'NIST.800.53.R5-CloudTrailCloudWatchLogsEnabled': {
    name: 'CloudTrail CloudWatch Logs Enabled',
    description: 'The trail does not have CloudWatch logs enabled.',
    severity: 'error',
    fix: `new cloudtrail.Trail(this, 'Trail', {
  sendToCloudWatchLogs: true,
  cloudWatchLogGroup: logGroup,
});`,
    docUrl: `${CDK_NAG_RULES_README}#nist.800.53.r5-cloudtrailcloudwatchlogsenabled`,
  },
  'NIST.800.53.R5-CloudTrailLogFileValidationEnabled': {
    name: 'CloudTrail Log File Validation Enabled',
    description: 'The trail does not have log file validation enabled.',
    severity: 'error',
    fix: `new cloudtrail.Trail(this, 'Trail', {
  enableFileValidation: true,
});`,
    docUrl: `${CDK_NAG_RULES_README}#nist.800.53.r5-cloudtraillogfilevalidationenabled`,
  },
  'NIST.800.53.R5-RDSStorageEncrypted': {
    name: 'RDS Storage Encrypted',
    description: 'The RDS DB instance or Aurora DB cluster does not have storage encrypted.',
    severity: 'error',
    fix: `new rds.DatabaseInstance(this, 'Db', {
  storageEncrypted: true,
  // ...
});`,
    docUrl: `${CDK_NAG_RULES_README}#nist.800.53.r5-rdsstorageencrypted`,
  },
  'NIST.800.53.R5-IAMPolicyNoStatementsWithAdminAccess': {
    name: 'IAM Policy No Statements With Admin Access',
    description: 'The IAM policy grants admin access, allowing a principal to perform all actions on all resources.',
    severity: 'error',
    fix: `// Scope the policy instead of granting '*' on '*':
new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [bucket.arnForObjects('*')],
});`,
    docUrl: `${CDK_NAG_RULES_README}#nist.800.53.r5-iampolicynostatementswithadminaccess`,
  },
};

/** Prefix-level fallback docs — applied when no exact match is found. */
const PREFIX_RULE_DOCS: Array<{ prefix: string; doc: RuleDoc }> = [
  {
    prefix: 'AwsSolutions-',
    doc: {
      name: 'AWS Solutions Rule',
      description:
        'A finding from the AWS Solutions best-practices pack. See the cdk-nag RULES.md for details.',
      severity: 'warning',
      docUrl: CDK_NAG_RULES_README,
    },
  },
  {
    prefix: 'HIPAA.Security-',
    doc: {
      name: 'HIPAA Security Rule',
      description: 'A HIPAA Security pack finding from cdk-nag.',
      severity: 'error',
      docUrl: CDK_NAG_RULES_README,
    },
  },
  {
    // Actual rule IDs are `NIST.800.53.R5-*` (see cdk-nag's
    // `Nist80053R5Checks.packName`) — not `NIST.800-53.*`.
    prefix: 'NIST.800.53.R5-',
    doc: {
      name: 'NIST 800-53 Rule',
      description: 'A NIST 800-53 rev 5 pack finding from cdk-nag.',
      severity: 'error',
      docUrl: CDK_NAG_RULES_README,
    },
  },
  {
    prefix: 'PCI.DSS.321-',
    doc: {
      name: 'PCI DSS 3.2.1 Rule',
      description: 'A PCI DSS 3.2.1 pack finding from cdk-nag.',
      severity: 'error',
      docUrl: CDK_NAG_RULES_README,
    },
  },
  {
    prefix: 'Serverless-',
    doc: {
      name: 'Serverless Best-Practices Rule',
      description: 'A Serverless pack finding from cdk-nag.',
      severity: 'warning',
      docUrl: CDK_NAG_RULES_README,
    },
  },
];

/**
 * Return the best-match RuleDoc for the given cdk-nag rule ID.
 * Exact match wins; otherwise we try known prefixes; otherwise `undefined`.
 */
export function lookupRuleDoc(ruleId: string): RuleDoc | undefined {
  const exact = EXACT_RULE_DOCS[ruleId];
  if (exact) return exact;
  for (const { prefix, doc } of PREFIX_RULE_DOCS) {
    if (ruleId.startsWith(prefix)) return doc;
  }
  return undefined;
}

/**
 * Shortcut — just the fix snippet, or `undefined` if no curated fix.
 * Intended for CodeActionProvider where only the snippet is needed.
 */
export function lookupRuleFix(ruleId: string): string | undefined {
  return EXACT_RULE_DOCS[ruleId]?.fix;
}

/** Exposed for tests to iterate the curated set. */
export function listCuratedRuleIds(): string[] {
  return Object.keys(EXACT_RULE_DOCS);
}
