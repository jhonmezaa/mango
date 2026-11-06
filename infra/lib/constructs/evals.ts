import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
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
 * Where the content of the evals harness lives (D110 (3), (8)): the log groups of its own runtime,
 * encrypted with a key of their own that only the evaluator may decrypt. It lives in Core because
 * the provisioner (Core) associates it with those log groups when it deploys the harness; the
 * evaluator, in its nested stack, is named here by its fixed role name.
 *
 * The key policy, not only IAM, decides who reads the content: CloudWatch Logs asks KMS, as the
 * caller (`kms:ViaService`), to decrypt what a reader reads, and the policy denies that to every
 * principal but the evaluator's role. The services that write (CloudWatch Logs, X-Ray) are no
 * principal with an ARN and are not denied.
 */
export class EvalsCapture extends Construct {
  readonly key: kms.Key;
  readonly logGroupArns: string;
  readonly judgeRoleArn: string;
  readonly judgeFunctionArn: string;
  readonly judgeFunctionName: string;
  private readonly namespace: string;

  constructor(scope: Construct, id: string, props: EvalsCaptureProps) {
    super(scope, id);
    const ns = (this.namespace = props.installation.namespace);
    const { region, account } = Stack.of(this);
    this.logGroupArns = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${evalsHarness.runtimePrefix(ns)}*`;
    this.judgeRoleArn = `arn:aws:iam::${account}:role/${roleNames.evalJudge(ns)}`;
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
          // Only principals with an ARN: the services that write are not denied.
          Null: { "aws:PrincipalArn": "false" },
        },
      }),
    );
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
