import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import {
  APPROVAL_SESSION_TAG,
  mangoName,
  OPERATE_SESSION_TAG_KEYS,
  roleArn,
  roleNames,
  writeResourcePrefix,
} from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { PythonFunction } from "./python-function.js";
import { OPS_TARGET_NAME, Tools } from "./tools.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONNECTOR = resolve(REPO_ROOT, "connectors/aws-budgets");
/** FinOps roles of the pre token claim `mango_role` (D13). */
const CENTRAL_ROLE = "finops-central";
const AREA_ROLE = "bu-lead";

/** Index names of the Approvals table; keep in sync with `mango_api.approvals_store`. */
export const APPROVALS_BY_STATE = "ByState";
export const APPROVALS_BY_REQUESTER = "ByRequester";

/**
 * Attributes an enforcement point may name when it spends an approval
 * (`mango_core.approval_use`): the key and its own mark, nothing else. IAM does not tell an
 * attribute read in a condition from one written, so the status, the signatures, the hash of
 * the arguments and who asked are simply not nameable by them (TM-W7).
 */
const CLAIM_ATTRIBUTES = ["PK", "SK"];
const GATEWAY_MARK = "gateway_used_at";
const EXECUTOR_MARK = "executor_used_at";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: agentcore.CfnGatewayTarget.SchemaDefinitionProperty;
}

interface WriteManifest {
  gateway_target: string;
  tools: { name: string; access: "read" | "write"; audience: "all" | "central" }[];
}

/** Write tools of the release as the manifest of the write connector declares them. */
export function writeTools(): { name: string; central: boolean }[] {
  const manifest = JSON.parse(readFileSync(resolve(CONNECTOR, "manifest.json"), "utf8")) as WriteManifest;
  if (manifest.gateway_target !== OPS_TARGET_NAME) {
    throw new Error(`the write connector must use the Gateway target ${OPS_TARGET_NAME}`);
  }
  for (const tool of manifest.tools) {
    // Every tool of this target needs an approval: a read tool here would get one for free.
    if (tool.access !== "write") throw new Error(`${tool.name}: only write tools go behind the approval executor`);
  }
  return manifest.tools.map((tool) => ({ name: tool.name, central: tool.audience === "central" }));
}

export interface WriteToolsProps {
  readonly installation: Installation;
  /** Gateway, interceptor and policy engine the write tools are added to. */
  readonly tools: Tools;
  /** mango-api: decides approvals and is the only principal that can sign their tokens. */
  readonly apiTaskRole: iam.IRole;
  /** Key that encrypts the tables with customer data. */
  readonly dataKey: kms.IKey;
  readonly issuer: string;
  readonly webClientId: string;
}

/**
 * Write tools with approval (D27, §4.10; threat model `write-tools-approval-threat-model.md`).
 *
 * - `Approvals` table: one item per write tool call that asked for confirmation.
 * - Approval key (KMS, asymmetric): only mango-api signs; the Gateway interceptor and the
 *   approval executor verify with the public half (TM-W7).
 * - Approval executor: the only function that changes anything in an AWS account, behind its
 *   own Gateway target, and the only principal that can assume the operate broker.
 * - Operate broker: reaches the write role of the payer account, always as the person who
 *   asked (`SourceIdentity`) and naming the approval (`mango_approval` session tag).
 */
export class WriteTools extends Construct {
  readonly approvals: dynamodb.TableV2;
  readonly approvalKey: kms.Key;
  /** Environment mango-api needs to decide and run approvals. */
  readonly apiEnvironment: Record<string, string>;

  constructor(scope: Construct, id: string, props: WriteToolsProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const { account, region } = Stack.of(this);
    const { tools } = props;
    const interceptorRole = tools.interceptor.role!;

    // --- Requests -------------------------------------------------------------------------
    this.approvals = new dynamodb.TableV2(this, "Approvals", {
      tableName: mangoName(ns, "Approvals"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // Closed requests expire from the table; the audit trail keeps the evidence.
      timeToLiveAttribute: "ttl",
      globalSecondaryIndexes: [
        {
          // Sparse: requests that need approvers, waiting or closed (the inbox).
          indexName: APPROVALS_BY_STATE,
          partitionKey: { name: "state_pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "sort", type: dynamodb.AttributeType.STRING },
        },
        {
          // What each person asked for.
          indexName: APPROVALS_BY_REQUESTER,
          partitionKey: { name: "requester_pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "sort", type: dynamodb.AttributeType.STRING },
        },
      ],
    });
    // mango-api decides: it creates, reads and moves requests, by key and by the two indexes.
    // No `Scan` and no `DeleteItem`.
    props.apiTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ApprovalsTable",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
        resources: [
          this.approvals.tableArn,
          ...[APPROVALS_BY_STATE, APPROVALS_BY_REQUESTER].map((index) => `${this.approvals.tableArn}/index/${index}`),
        ],
      }),
    );

    // --- Approval tokens ------------------------------------------------------------------
    // Asymmetric, so that whoever verifies (interceptor, executor) cannot sign (TM-W7).
    this.approvalKey = new kms.Key(this, "ApprovalKey", {
      alias: `alias/${mangoName(ns, "approval")}`,
      description: "Signs the approval tokens of write tool calls; only mango-api can sign",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      // No data is encrypted with it and a token lives two minutes: a new key needs nothing else.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.approvalKey.grant(props.apiTaskRole, "kms:Sign");
    this.approvalKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyMangoApiSigns",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": props.apiTaskRole.roleArn } },
      }),
    );

    // --- Approval executor and the write chain (§4.10) ------------------------------------
    const executorRole = new iam.Role(this, "ExecutorRole", {
      roleName: roleNames.approvalExecutor(ns),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const brokerCaller = { ArnEquals: { "aws:PrincipalArn": executorRole.roleArn } };
    const broker = new iam.Role(this, "OperateBroker", {
      roleName: roleNames.operateBroker(ns),
      description: "Broker to Mango write roles; only the approval executor may use it, for one approved call",
      // A write session always names a person (SourceIdentity) and an approval (session tag).
      assumedBy: new iam.AccountPrincipal(account).withConditions({
        ...brokerCaller,
        Null: { "sts:SourceIdentity": "false", [`aws:RequestTag/${APPROVAL_SESSION_TAG}`]: "false" },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    broker.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [new iam.AccountPrincipal(account)],
        conditions: { ...brokerCaller, StringLike: { "sts:SourceIdentity": "*" } },
      }),
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [new iam.AccountPrincipal(account)],
        conditions: {
          ...brokerCaller,
          "ForAllValues:StringEquals": { "aws:TagKeys": OPERATE_SESSION_TAG_KEYS },
        },
      }),
    );
    const budgetsOperatorArn = roleArn(cfg.managementAccountId, roleNames.budgetsOperator(ns));
    const chain = ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"];
    broker.addToPolicy(new iam.PolicyStatement({ actions: chain, resources: [budgetsOperatorArn] }));
    executorRole.addToPolicy(new iam.PolicyStatement({ actions: chain, resources: [broker.roleArn] }));

    const executor = new PythonFunction(this, "Executor", {
      packageName: "mango-approval-executor",
      packagePath: "functions/approval-executor",
      retainLogs: cfg.retainData,
      handler: "mango_approval_executor.handler.lambda_handler",
      functionName: roleNames.approvalExecutor(ns),
      description: "Runs approved write tools (AgentCore Gateway target); never without a valid approval",
      role: executorRole,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        COGNITO_ISSUER: props.issuer,
        COGNITO_CLIENT_ID: props.webClientId,
        OPERATE_BROKER_ROLE_ARN: broker.roleArn,
        BUDGETS_OPERATOR_ROLE_ARN: budgetsOperatorArn,
        APPROVALS_TABLE: this.approvals.tableName,
        APPROVAL_KEY_ARN: this.approvalKey.keyArn,
        RESOURCE_PREFIX: writeResourcePrefix(ns),
      },
      environmentEncryption: tools.configKey,
    });
    acknowledge(executorRole, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });

    // --- Who verifies and spends an approval ----------------------------------------------
    // Each enforcement point reads the public key and sets its own mark on the request, with
    // the condition of `mango_core.approval_use`. Neither can read a request, change its
    // status or its signatures, nor sign a token.
    const spends = (role: iam.IRole, sid: string, marks: string[]) => {
      this.approvalKey.grant(role, "kms:GetPublicKey");
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid,
          actions: ["dynamodb:UpdateItem"],
          resources: [this.approvals.tableArn],
          conditions: {
            "ForAllValues:StringEquals": { "dynamodb:Attributes": [...CLAIM_ATTRIBUTES, ...marks] },
            // Nothing of the item comes back.
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: `${sid}Key`,
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [props.dataKey.keyArn],
          // Only through DynamoDB, never direct use of the shared data key.
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
      );
    };
    spends(interceptorRole, "SpendApprovalAtTheGateway", [GATEWAY_MARK]);
    // The executor's condition also names the Gateway's mark: it only runs what got through.
    spends(executorRole, "SpendApprovalAtTheExecutor", [GATEWAY_MARK, EXECUTOR_MARK]);

    const declared = writeTools();
    const gatewayTool = (name: string) => `${OPS_TARGET_NAME}___${name}`;
    tools.interceptor.addEnvironment("APPROVAL_TOOLS", JSON.stringify(declared.map((t) => gatewayTool(t.name))));
    tools.interceptor.addEnvironment("APPROVAL_KEY_ARN", this.approvalKey.keyArn);
    tools.interceptor.addEnvironment("APPROVALS_TABLE", this.approvals.tableName);

    // --- Gateway target and Cedar policies (L2) -------------------------------------------
    executor.function.grantInvoke(tools.gatewayRole);
    acknowledge(tools.gatewayRole, {
      id: arnWildcardFinding(executor.function.node.defaultChild as CfnResource, ":*"),
      reason: REASONS.cdkGrant,
    });
    const schema = JSON.parse(readFileSync(resolve(CONNECTOR, "tool-schema.json"), "utf8")) as ToolDefinition[];
    const names = declared.map((t) => t.name);
    if (schema.length !== names.length || schema.some((t) => !names.includes(t.name))) {
      throw new Error("the write connector's tool schema and manifest must list the same tools");
    }
    const target = new agentcore.CfnGatewayTarget(this, "OpsTarget", {
      gatewayIdentifier: tools.gateway.attrGatewayIdentifier,
      name: OPS_TARGET_NAME,
      description: "Mango write tools (approval executor)",
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: {
        mcp: { lambda: { lambdaArn: executor.function.functionArn, toolSchema: { inlinePayload: schema } } },
      },
    });

    // Who may call a write tool at all, by FinOps role; like the read tools, each permit has
    // its `forbid … unless` so no policy added to the engine later can open it to anyone else.
    // Cedar decides who; the approval decides whether this call runs.
    const resource = `AgentCore::Gateway::"${tools.gateway.attrGatewayArn}"`;
    const hasRole = (roles: string[]) =>
      `principal.hasTag("mango_role") && (${roles
        .map((r) => `principal.getTag("mango_role") == "${r}"`)
        .join(" || ")})`;
    const head = (effect: "permit" | "forbid", toolList: string[]) => [
      `${effect} (`,
      "  principal is AgentCore::OAuthUser,",
      `  action in [${toolList.map((t) => `AgentCore::Action::"${gatewayTool(t)}"`).join(", ")}],`,
      `  resource == ${resource}`,
    ];
    const groups: [string, string[], string[]][] = [
      ["WriteCentral", declared.filter((t) => t.central).map((t) => t.name), [CENTRAL_ROLE]],
      ["Write", declared.filter((t) => !t.central).map((t) => t.name), [CENTRAL_ROLE, AREA_ROLE]],
    ];
    for (const [name, toolList, roles] of groups) {
      if (toolList.length === 0) continue;
      const statements: Record<string, string[]> = {
        [name]: [...head("permit", toolList), `) when { ${hasRole(roles)} };`],
        [`${name}ForbidOthers`]: [...head("forbid", toolList), `) unless { ${hasRole(roles)} };`],
      };
      for (const [policyName, statement] of Object.entries(statements)) {
        new agentcore.CfnPolicy(this, `Policy${policyName}`, {
          name: `Mango_${ns}_${policyName}`,
          description: `Write tools: ${policyName.endsWith("ForbidOthers") ? "nobody else" : "who may ask for them"}`,
          policyEngineId: tools.policyEngine.attrPolicyEngineId,
          definition: { cedar: { statement: statement.join("\n") } },
        }).addResourceDependency(target);
      }
    }

    this.apiEnvironment = {
      APPROVALS_TABLE: this.approvals.tableName,
      APPROVAL_KEY_ARN: this.approvalKey.keyArn,
    };
  }
}
