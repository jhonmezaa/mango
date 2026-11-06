import { CfnResource, IAspect, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct, IConstruct } from "constructs";
import { Installation } from "../config/schema.js";
import { agentNames, mangoName, roleNames } from "../names.js";
import { acknowledge } from "../nag.js";

export interface EvalsProps {
  readonly installation: Installation;
  /** Key of the installation's tables. */
  readonly dataKey: kms.IKey;
}

/**
 * Evals (D110, D111; threat model `evals-threat-model.md`).
 *
 * Table `Mango-<ns>-Evals`: the suites, their cases (content, D26: kept with their suite and
 * deleted with it), the runs and their result per case (verdicts and fixed reason codes, never
 * an answer of the agent), and the requests to stop requiring a suite (two people). It holds
 * data, so it lives in Core (D99 (2)): retained, with PITR and deletion protection. Only
 * mango-api reads and writes it.
 */
export class Evals extends Construct {
  readonly table: dynamodb.TableV2;
  /** Environment mango-api needs. */
  readonly apiEnvironment: Record<string, string>;
  private readonly namespace: string;
  private readonly dataKey: kms.IKey;

  constructor(scope: Construct, id: string, props: EvalsProps) {
    super(scope, id);
    const cfg = props.installation;
    this.namespace = cfg.namespace;
    this.dataKey = props.dataKey;
    // Its id names its throttling alarm (D71).
    this.table = new dynamodb.TableV2(this, "Evals", {
      tableName: mangoName(cfg.namespace, "Evals"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // Runs (180 days) and closed requests (90 days); suites and their cases never.
      timeToLiveAttribute: "ttl",
    });
    this.apiEnvironment = { EVALS_TABLE: this.table.tableName };
  }

  /** mango-api: the suites, cases, runs and requests (only it writes the table). */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiEvals"),
      description: "mango-api: eval suites, cases, runs and requests (D110, D111)",
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "EvalsTable",
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:ConditionCheckItem",
          ],
          resources: [this.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "EvalsTableKey",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [this.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
      ],
    });
  }
}

/** The evals harness (D110 (3)): `Mango_<ns>_a_evals`, its runtime and its role. */
export const evalsHarness = {
  id: "evals",
  harnessName: (ns: string) => `${agentNames.harnessPrefix(ns)}evals`,
  runtimePrefix: (ns: string) => `${agentNames.runtimePrefix(ns)}evals-`,
  roleName: (ns: string) => `${agentNames.rolePrefix(ns)}evals`,
};

/** The judge models of an installation (D110 (8)): its config, or the auxiliary model. */
export function judgeModels(cfg: Installation): string[] {
  return [...new Set(cfg.models.judges ?? [cfg.models.auxiliary])].sort();
}

export interface EvalsCaptureProps {
  readonly installation: Installation;
  readonly retainData: boolean;
}

/**
 * CloudWatch Logs actions that return, or send elsewhere, the events of a log group, denied on
 * the evals harness's log groups to every role of Mango but the evaluator (D110 (8)). Every
 * action here takes a `log-group` resource (Service Authorization Reference, 2026-11-06); the
 * ARN pattern ends in `*`, so it also names their log streams (`GetLogEvents`).
 *
 * - Read: `GetLogEvents`, `FilterLogEvents`, `GetLogRecord` (also `GetLogObject`), `Unmask`,
 *   `StartQuery` and `GetQueryResults` (Logs Insights), `StartLiveTail`, `GetLogGroupFields`.
 * - Export or copy: `CreateExportTask` (S3), `PutSubscriptionFilter`, `IntegrateWithS3Table`,
 *   `IntegrateWithDataset`, `ProcessWithPipeline`, and `CreateLogAnomalyDetector` (anomalies
 *   carry samples of the events).
 *
 * `DisassociateKmsKey` has a Deny of its own ({@link EvalsCapture.denyStatements}): the log groups
 * keep their own key, and only the provisioner may take it off to bind it again (D110 (9)).
 *
 * Not here, because the evals harness's role or the provisioner need them on these log groups
 * and none returns an event: `CreateLogGroup`, `CreateLogStream`, `PutLogEvents`,
 * `DescribeLogStreams`, `PutResourcePolicy`, `AssociateKmsKey`, `PutRetentionPolicy`,
 * `TagResource`, `DeleteLogGroup`.
 */
export const EVALS_CONTENT_ACTIONS = [
  "logs:GetLogEvents",
  "logs:FilterLogEvents",
  "logs:GetLogRecord",
  "logs:Unmask",
  "logs:StartQuery",
  "logs:GetQueryResults",
  "logs:StartLiveTail",
  "logs:GetLogGroupFields",
  "logs:CreateExportTask",
  "logs:PutSubscriptionFilter",
  "logs:IntegrateWithS3Table",
  "logs:IntegrateWithDataset",
  "logs:ProcessWithPipeline",
  "logs:CreateLogAnomalyDetector",
] as const;

/**
 * Account-wide ways to send log events elsewhere, which name no log group (their API takes no
 * resource, so the statement uses `*`): an account subscription policy (`PutAccountPolicy`),
 * an S3 Tables or OpenSearch integration, a telemetry pipeline and a scheduled query. No role
 * of Mango uses them.
 */
export const ACCOUNT_LOG_EXPORT_ACTIONS = [
  "logs:PutAccountPolicy",
  "logs:AssociateSourceToS3TableIntegration",
  "logs:PutIntegration",
  "logs:PutPipelineRule",
  "logs:CreateScheduledQuery",
  "logs:UpdateScheduledQuery",
] as const;

/**
 * Where the content of the evals harness lives (D110 (3), (8)): the log groups of its own runtime,
 * encrypted with a key of their own. It lives in Core because the provisioner (Core) associates
 * it with those log groups when it deploys the harness; the evaluator, in its nested stack, is
 * named here by its fixed role name.
 *
 * IAM, not the key, decides who reads the content (D110 (8), precised 2026-11-06). An
 * administrator of the account read these log groups without error: CloudWatch Logs checked
 * that reader with a dry-run `kms:Decrypt` (CloudTrail shows the reader's role, invoked by
 * Logs) and the key's Deny below did not stop it. Why it did not, and whether another Deny in
 * the key would, is still being tested; until then the key promises nothing about readers.
 * Every role of Mango but the evaluator carries an explicit Deny of {@link EVALS_CONTENT_ACTIONS}
 * on them ({@link contentDeny}, attached by {@link DenyEvalsContent}, and in the boundaries of
 * the roles created at runtime). An administrator of the account can still read them, like any
 * data of the account. The key keeps what it does give: a customer managed key of its own, only
 * for these log groups (encryption context), whose every use is in CloudTrail and whose deletion
 * makes the content unreadable.
 */
export class EvalsCapture extends Construct {
  readonly key: kms.Key;
  readonly logGroupArns: string;
  readonly judgeRoleArn: string;
  /** The provisioner's role, the only one that may take the key off to bind it again. */
  readonly provisionerRoleArn: string;
  readonly judgeFunctionArn: string;
  readonly judgeFunctionName: string;
  /** `Mango-<ns>-evals-content-deny`: attached to every role of the installation but the evaluator. */
  readonly contentDeny: iam.ManagedPolicy;
  private readonly namespace: string;

  constructor(scope: Construct, id: string, props: EvalsCaptureProps) {
    super(scope, id);
    const ns = (this.namespace = props.installation.namespace);
    const { region, account } = Stack.of(this);
    this.logGroupArns = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${evalsHarness.runtimePrefix(ns)}*`;
    this.judgeRoleArn = `arn:aws:iam::${account}:role/${roleNames.evalJudge(ns)}`;
    this.provisionerRoleArn = `arn:aws:iam::${account}:role/${roleNames.provisioner(ns)}`;
    this.judgeFunctionName = roleNames.evalJudge(ns);
    this.judgeFunctionArn = `arn:aws:lambda:${region}:${account}:function:${this.judgeFunctionName}`;
    this.key = new kms.Key(this, "LogsKey", {
      alias: `alias/${mangoName(ns, "evals-logs")}`,
      description: "Encrypts the log groups of the evals harness, the only ones with content (D110)",
      enableKeyRotation: true,
      // Retained on uninstall; deleted only if the operation that created it rolls back, so a
      // failed first update leaves no orphan key behind (D58 (27)).
      removalPolicy: props.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
    });
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsEvalsHarness",
        principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
        resources: ["*"],
        conditions: { ArnLike: { "kms:EncryptionContext:aws:logs:arn": this.logGroupArns } },
      }),
    );
    // Did not stop a reader: an administrator of the account read these log groups through
    // CloudWatch Logs (2026-11-06), whose dry-run Decrypt as that reader was allowed. Why is
    // being tested; it is kept unchanged until then, and who reads is decided in IAM
    // ({@link contentDeny}).
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyTheEvaluatorReadsTheContent",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:ViaService": `logs.${region}.amazonaws.com` },
          ArnNotEquals: { "aws:PrincipalArn": this.judgeRoleArn },
          Null: { "aws:PrincipalArn": "false" },
        },
      }),
    );
    this.contentDeny = new iam.ManagedPolicy(this, "ContentDeny", {
      managedPolicyName: mangoName(ns, "evals-content-deny"),
      description: "No role of Mango but the evaluator reads or exports the evals harness's log groups (D110)",
      statements: this.denyStatements(),
    });
  }

  /** The Deny of {@link EVALS_CONTENT_ACTIONS} and {@link ACCOUNT_LOG_EXPORT_ACTIONS}. */
  denyStatements(): iam.PolicyStatement[] {
    return [
      new iam.PolicyStatement({
        sid: "NoEvalsContent",
        effect: iam.Effect.DENY,
        actions: [...EVALS_CONTENT_ACTIONS],
        resources: [this.logGroupArns],
      }),
      new iam.PolicyStatement({
        // D110 (9): an association X-Ray cannot use is only repaired by taking the key off and
        // associating it again. Only the provisioner does it, and only while no eval may run.
        // The full ARN, never a name compared in CDK (a token in the release).
        sid: "NoEvalsKeyRemoval",
        effect: iam.Effect.DENY,
        actions: ["logs:DisassociateKmsKey"],
        resources: [this.logGroupArns],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": this.provisionerRoleArn } },
      }),
      new iam.PolicyStatement({
        sid: "NoAccountWideLogExport",
        effect: iam.Effect.DENY,
        actions: [...ACCOUNT_LOG_EXPORT_ACTIONS],
        resources: ["*"],
      }),
    ];
  }

  /** The same Deny in the boundary of roles created at runtime (agents, packs, KB sources). */
  denyInBoundary(boundary: iam.ManagedPolicy): void {
    boundary.addStatements(...this.denyStatements());
  }

  /** The ceiling of agent roles: only the evals role sets the trace destination of its log groups. */
  allowAgents(boundary: iam.ManagedPolicy): void {
    boundary.addStatements(
      new iam.PolicyStatement({
        sid: "EvalsUnifiedTraces",
        actions: ["logs:PutResourcePolicy", "logs:DescribeResourcePolicies"],
        resources: [this.logGroupArns],
      }),
    );
    acknowledge(boundary, {
      id: `AwsSolutions-IAM5[Resource::${this.logGroupArns}]`,
      reason:
        "A boundary is a ceiling: only the evals harness's runtime log groups (named by AgentCore after the " +
        "generated runtime id), so its role can let X-Ray deliver its spans there (D110 (8)).",
    });
  }

  /** The provisioner: associate the key with the log groups, and ask the evaluator for a canary. */
  grantProvisioner(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "EvalsLogsKey",
        actions: ["kms:DescribeKey"],
        resources: [this.key.keyArn],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // D110 (9): bind the key again while the canary has not verified the harness (the
        // association made seconds after AgentCore created the log group gets no spans).
        sid: "RebindEvalsLogsKey",
        actions: ["logs:DisassociateKmsKey"],
        resources: [this.logGroupArns],
      }),
    );
    acknowledge(role, {
      id: `AwsSolutions-IAM5[Resource::${this.logGroupArns}]`,
      reason:
        "Only the evals harness's runtime log groups (named by AgentCore after the generated runtime id): the " +
        "provisioner takes their key off and associates it again while no eval may run (D110 (9)).",
    });
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "AskTheEvalsCanary",
        actions: ["lambda:InvokeFunction"],
        resources: [this.judgeFunctionArn],
      }),
    );
  }

  /** mango-api: the verdict of one case (D110). Never the log group itself. */
  grantApi(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "AskTheEvalJudge",
        actions: ["lambda:InvokeFunction"],
        resources: [this.judgeFunctionArn],
      }),
    );
  }

  /** Environment the provisioner needs (D110). */
  get provisionerEnvironment(): Record<string, string> {
    return { EVALS_LOGS_KEY_ARN: this.key.keyArn, EVAL_JUDGE_FUNCTION: this.judgeFunctionName };
  }
}

/**
 * Attaches {@link EvalsCapture.contentDeny} to every IAM role of the stack it is added to and of
 * the stacks nested in it, but the evaluator's (D110 (8)). A role added later gets it without
 * anyone remembering to; `infra/test/evals.test.ts` checks every role of the template.
 */
export class DenyEvalsContent implements IAspect {
  constructor(
    private readonly capture: EvalsCapture,
    // The role itself, not its name: in a release the name is a token (the Namespace parameter,
    // passed again into the nested stack), which never equals the name the stack computes.
    private readonly evaluator: iam.IRole,
  ) {}

  visit(node: IConstruct): void {
    if (node instanceof iam.Role) {
      if (node === this.evaluator) return;
      node.addManagedPolicy(this.capture.contentDeny);
      return;
    }
    // Roles CDK writes as a plain resource (CustomResourceProvider, e.g. the S3 auto-delete one).
    if (node instanceof CfnResource && node.cfnResourceType === "AWS::IAM::Role" && !(node instanceof iam.CfnRole)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = ((node as any)._cfnProperties?.ManagedPolicyArns ?? []) as unknown[];
      node.addPropertyOverride("ManagedPolicyArns", [...current, this.capture.contentDeny.managedPolicyArn]);
    }
  }
}
