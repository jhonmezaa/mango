import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { PythonFunction } from "./python-function.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Gateway target of the Canvas tools (D124 (2)); keep in sync with `mango_core.harness_tools.TEXTDOC_TARGET`. */
export const TEXTDOC_TARGET_NAME = "textdoc";
/** Its shared limit per person (`mango_textdoc.handler.CALLS_LIMIT`), in the RateLimits table. */
export const TEXTDOC_LIMITS = ["textdoc.write"];

/** `Mango-<ns>-Textdoc`: the connector's role, named so Core can trust it without reading the nested stack (D99 (4)). */
export const textdocConnectorRoleName = (ns: string) =>
  mangoName(ns, "Textdoc");

export function textdocConnectorRoleArn(scope: Construct, ns: string): string {
  const { partition, account } = Stack.of(scope);
  return `arn:${partition}:iam::${account}:role/${textdocConnectorRoleName(ns)}`;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: agentcore.CfnGatewayTarget.SchemaDefinitionProperty;
}

/** The tools of `connectors/textdoc/tool-schema.json`. */
export function textdocTools(): ToolDefinition[] {
  return JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "connectors/textdoc/tool-schema.json"),
      "utf8",
    ),
  ) as ToolDefinition[];
}

export interface TextdocConnectorProps {
  readonly installation: Installation;
  /** Where the documents live, under each person's partition (RLS). */
  readonly conversations: dynamodb.ITableV2;
  /** The key of the tables of Core (Conversations, RateLimits, AuditIndex). */
  readonly dataKey: kms.IKey;
  /** `Mango-<ns>-ConversationData`, assumed per person with a `LeadingKeys` session policy. */
  readonly dataAccessRoleArn: string;
  readonly rateLimits: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Encrypts the function's environment (it holds no secret). */
  readonly configKey: kms.IKey;
  readonly issuer: string;
  readonly webClientId: string;
  /** Task runs (D78) run as their owner, with a token of this client. */
  readonly tasksClientId: string;
  readonly gateway: {
    readonly id: string;
    readonly arn: string;
    readonly roleArn: string;
  };
  /** Cedar policy engine of the Gateway (L2, default deny). */
  readonly policyEngineId: string;
}

/**
 * The Canvas connector (D124; threat model `canvas-threat-model.md`): the Lambda target
 * `textdoc` of the Gateway and its Cedar policy (L2). It writes only in Mango: the documents of a
 * conversation are rows of Core's `Conversations`, in the person's partition (D99 (2): nothing
 * here holds data).
 *
 * - Rows of one person at a time: it assumes `Mango-<ns>-ConversationData` with a session policy
 *   on `USER#<sub>` (AGENTS.md), never the table directly.
 * - No other system: no S3, no KMS but through DynamoDB, nothing outside the account (rule 3).
 * - Its own limit in RateLimits, and `textdoc.write` to the audit trail.
 */
export class TextdocConnector extends Construct {
  readonly function: lambda.Function;
  readonly role: iam.Role;
  readonly target: agentcore.CfnGatewayTarget;

  constructor(scope: Construct, id: string, props: TextdocConnectorProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const { region } = Stack.of(this);

    this.role = new iam.Role(this, "Role", {
      roleName: textdocConnectorRoleName(ns),
      description:
        "Canvas tools: the documents and code of a conversation, written only in Mango",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    const policy = new iam.Policy(this, "Policy", {
      roles: [this.role],
      statements: [
        new iam.PolicyStatement({
          sid: "OnePersonsRows",
          actions: ["sts:AssumeRole"],
          resources: [props.dataAccessRoleArn],
        }),
        new iam.PolicyStatement({
          sid: "LimitPerPerson",
          // Only the items of its own limit (`LIMIT#textdoc.write#<sub>`), never another's.
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [props.rateLimits.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": TEXTDOC_LIMITS.map((l) => `LIMIT#${l}#*`),
            },
          },
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditIndex",
          actions: ["dynamodb:PutItem"],
          resources: [props.auditIndex.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "DataKeyViaDynamoDB",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [props.dataKey.keyArn],
          conditions: {
            StringEquals: {
              "kms:ViaService": `dynamodb.${region}.amazonaws.com`,
            },
          },
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditTrail",
          actions: ["firehose:PutRecord"],
          resources: [props.auditStream.deliveryStreamArn],
        }),
      ],
    });
    acknowledge(this.role, {
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: REASONS.xray,
    });

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-textdoc",
      packagePath: "connectors/textdoc",
      retainLogs: cfg.retainData,
      // A create that rolls back deletes its log group, so that a retry does not find it (D58 (27)).
      logsRemovalPolicy: cfg.retainData
        ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE
        : RemovalPolicy.DESTROY,
      handler: "mango_textdoc.handler.lambda_handler",
      functionName: mangoName(ns, "Textdoc"),
      description:
        "Canvas tools: create, update and comment the documents of a conversation (D124)",
      role: this.role,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        COGNITO_ISSUER: props.issuer,
        COGNITO_CLIENT_ID: props.webClientId,
        TASKS_CLIENT_ID: props.tasksClientId,
        CONVERSATIONS_TABLE: props.conversations.tableName,
        CONVERSATIONS_TABLE_ARN: props.conversations.tableArn,
        DATA_KEY_ARN: props.dataKey.keyArn,
        DATA_ROLE_ARN: props.dataAccessRoleArn,
        RATE_LIMITS_TABLE: props.rateLimits.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
      },
      environmentEncryption: props.configKey,
    }).function;
    this.function.node.addDependency(policy);

    // --- Behind the Gateway (rule 3) -----------------------------------------------------
    // The Gateway's role is Core's; its permission to invoke this function lives here, so that
    // Core never reads this stack (D99 (4)).
    const gatewayRole = iam.Role.fromRoleArn(
      this,
      "GatewayRole",
      props.gateway.roleArn,
      { mutable: true },
    );
    const invoke = new iam.Policy(this, "GatewayInvoke", {
      roles: [gatewayRole],
      statements: [
        new iam.PolicyStatement({
          sid: "InvokeTextdocConnector",
          actions: ["lambda:InvokeFunction"],
          resources: [this.function.functionArn],
        }),
      ],
    });
    const tools = textdocTools();
    this.target = new agentcore.CfnGatewayTarget(this, "Target", {
      gatewayIdentifier: props.gateway.id,
      name: TEXTDOC_TARGET_NAME,
      description: "Canvas of Mango's chat",
      credentialProviderConfigurations: [
        { credentialProviderType: "GATEWAY_IAM_ROLE" },
      ],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: this.function.functionArn,
            toolSchema: { inlinePayload: tools },
          },
        },
      },
    });
    this.target.node.addDependency(invoke);
    // As the code tools: any signed-in user on an invocation mango-api signed may call them
    // (D33). Which agent version has them, and which conversation they reach, the signature
    // decides (the interceptor refuses a call without conversation, TM-CV1).
    const actions = tools.map(
      (t) => `AgentCore::Action::"${TEXTDOC_TARGET_NAME}___${t.name}"`,
    );
    const cedar = new agentcore.CfnPolicy(this, "CedarPolicy", {
      name: `Mango_${ns}_Textdoc`,
      description:
        "Signed-in users may write the Canvas of their own conversations; the signature decides which",
      policyEngineId: props.policyEngineId,
      definition: {
        cedar: {
          statement: [
            "permit (",
            "  principal is AgentCore::OAuthUser,",
            `  action in [${actions.join(", ")}],`,
            `  resource == AgentCore::Gateway::"${props.gateway.arn}"`,
            ");",
          ].join("\n"),
        },
      },
    });
    cedar.addResourceDependency(this.target);
  }
}
