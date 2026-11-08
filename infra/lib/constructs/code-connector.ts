import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { PythonFunction } from "./python-function.js";
import { renderDocumentName } from "./render-document.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Gateway target of the code tools (D114 (1)); keep in sync with `mango_core.harness_tools.CODE_TARGET`. */
export const CODE_TARGET_NAME = "code";
/** The connector's own cutoff of a cell (`mango_core.code_sandbox.CELL_SECONDS`, D114 (5)). */
export const CODE_CELL_SECONDS = 300;
/** Its shared limits per person (`mango_code_interpreter.handler`), in the RateLimits table. */
export const CODE_LIMITS = ["code.run", "code.session"];
/** Where the cells' files land in the chat files bucket (`outputs.object_key`): ids only. */
export const CODE_FILES_PREFIX = "owner/";

/** `Mango-<ns>-CodeInterpreter`: the connector's role, named so Core can trust it without reading the nested stack (D99 (4)). */
export const codeConnectorRoleName = (ns: string) => mangoName(ns, "CodeInterpreter");

export function codeConnectorRoleArn(scope: Construct, ns: string): string {
  const { partition, account } = Stack.of(scope);
  return `arn:${partition}:iam::${account}:role/${codeConnectorRoleName(ns)}`;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: agentcore.CfnGatewayTarget.SchemaDefinitionProperty;
}

/** The tools of `connectors/code-interpreter/tool-schema.json`. */
export function codeTools(): ToolDefinition[] {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, "connectors/code-interpreter/tool-schema.json"), "utf8"),
  ) as ToolDefinition[];
}

export interface CodeConnectorProps {
  readonly installation: Installation;
  readonly codeInterpreter: agentcore.CfnCodeInterpreterCustom;
  /** Where the sessions and the cells live, under each person's partition (RLS). */
  readonly conversations: dynamodb.ITableV2;
  /** The key of the tables of Core (Conversations, RateLimits, AuditIndex). */
  readonly dataKey: kms.IKey;
  /** `Mango-<ns>-ConversationData`, assumed per person with a `LeadingKeys` session policy. */
  readonly dataAccessRoleArn: string;
  readonly chatFiles: { readonly bucket: s3.IBucket; readonly key: kms.IKey };
  readonly rateLimits: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Encrypts the function's environment (it holds no secret). */
  readonly configKey: kms.IKey;
  readonly issuer: string;
  readonly webClientId: string;
  /** Task runs (D78) run code as their owner, with a token of this client. */
  readonly tasksClientId: string;
  readonly gateway: { readonly id: string; readonly arn: string; readonly roleArn: string };
  /** Cedar policy engine of the Gateway (L2, default deny). */
  readonly policyEngineId: string;
  /**
   * Whether `Mango-<ns>-RenderDocument` exists (D117 (8): only in a release). Then the tool
   * `render_document` invokes it, and this connector is the only principal that may (D119).
   */
  readonly renderDocument?: boolean;
}

/**
 * The code connector (D114; threat model `code-interpreter-threat-model.md`): the Lambda
 * target `code` of the Gateway, its Cedar policy (L2) and what it may reach. Nothing here holds
 * data that outlives a session (D99 (2)): the sessions and the cells are rows of Core's
 * `Conversations`, the files objects of Core's chat files bucket.
 *
 * - Sessions of `Mango_<ns>_sandbox` only: start, invoke and stop, on its exact ARN (TM-CI10).
 * - Rows of one person at a time: it assumes `Mango-<ns>-ConversationData` with a session policy
 *   on `USER#<sub>` (AGENTS.md), never the table directly.
 * - The data key of Core seals the `sessionId`, with `purpose = code-session`, the person and
 *   the conversation as encryption context (TM-CI1). A key of its own would be data in a nested
 *   stack (D99 (2)) or one more resource of Core; whoever else may decrypt with the data key
 *   (mango-api) has no permission on the Code Interpreter, so an id is of no use to it.
 * - Writes the cells' files under `owner/` of the chat files bucket, never a tag (D116 (10)), and
 *   reads from there the files a person attached, which the bucket opens only once scanned.
 * - Its own limits in RateLimits, and `code.execute` to the audit trail.
 */
export class CodeConnector extends Construct {
  readonly function: lambda.Function;
  readonly role: iam.Role;
  readonly target: agentcore.CfnGatewayTarget;

  constructor(scope: Construct, id: string, props: CodeConnectorProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const { region, partition, account } = Stack.of(this);
    const renderFunctionArn = `arn:${partition}:lambda:${region}:${account}:function:${renderDocumentName(ns)}`;
    const viaDynamoDb = { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } };

    this.role = new iam.Role(this, "Role", {
      roleName: codeConnectorRoleName(ns),
      description: "Code tools: run the model's Python in the code sandbox, one session per person and conversation",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    const policy = new iam.Policy(this, "Policy", {
      roles: [this.role],
      statements: [
        new iam.PolicyStatement({
          sid: "SandboxSessions",
          actions: [
            "bedrock-agentcore:StartCodeInterpreterSession",
            "bedrock-agentcore:InvokeCodeInterpreter",
            "bedrock-agentcore:StopCodeInterpreterSession",
          ],
          resources: [props.codeInterpreter.attrCodeInterpreterArn],
        }),
        new iam.PolicyStatement({
          sid: "OnePersonsRows",
          actions: ["sts:AssumeRole"],
          resources: [props.dataAccessRoleArn],
        }),
        new iam.PolicyStatement({
          sid: "SealSessionIds",
          actions: ["kms:Encrypt", "kms:Decrypt"],
          // The data key of Core, never through a service: only to seal a session id, whose
          // encryption context also names the person and the conversation (TM-CI1).
          resources: [props.dataKey.keyArn],
          conditions: { StringEquals: { "kms:EncryptionContext:purpose": "code-session" } },
        }),
        new iam.PolicyStatement({
          sid: "WriteCellFiles",
          actions: ["s3:PutObject"],
          resources: [props.chatFiles.bucket.arnForObjects(`${CODE_FILES_PREFIX}*`)],
        }),
        // The files a person attached, into their session (D116 (4)): the bucket refuses any
        // object its scan did not clear (TBAC, D116 (10)).
        new iam.PolicyStatement({
          sid: "ReadAttachedFiles",
          actions: ["s3:GetObject"],
          resources: [props.chatFiles.bucket.arnForObjects(`${CODE_FILES_PREFIX}*`)],
        }),
        new iam.PolicyStatement({
          sid: "ChatFilesKey",
          actions: ["kms:GenerateDataKey", "kms:Decrypt"],
          resources: [props.chatFiles.key.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          sid: "LimitPerPerson",
          // Only the items of its own limits (`LIMIT#code.run#<sub>`…), never another's.
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [props.rateLimits.tableArn],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": CODE_LIMITS.map((l) => `LIMIT#${l}#*`) },
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
          conditions: viaDynamoDb,
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditTrail",
          actions: ["firehose:PutRecord"],
          resources: [props.auditStream.deliveryStreamArn],
        }),
        // D119: `render_document`, with the keys this connector builds from the signature
        // (D117 (7)); it then reads the pages under `renders/` with ReadAttachedFiles.
        ...(props.renderDocument
          ? [
              new iam.PolicyStatement({
                sid: "InvokeRenderDocument",
                actions: ["lambda:InvokeFunction"],
                resources: [renderFunctionArn],
              }),
            ]
          : []),
      ],
    });
    acknowledge(this.role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    acknowledge(policy, {
      id: arnWildcardFinding(
        props.chatFiles.bucket.node.defaultChild as CfnResource,
        `/${CODE_FILES_PREFIX}*`,
        "Arn",
        this,
      ),
      reason: "The cells write their files under the owner prefix; the key of each is built from ids (D116 (3)).",
    });

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-code-interpreter",
      packagePath: "connectors/code-interpreter",
      retainLogs: cfg.retainData,
      // A create that rolls back deletes its log group, so that a retry does not find it (D58 (27)).
      logsRemovalPolicy: cfg.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
      handler: "mango_code_interpreter.handler.lambda_handler",
      functionName: mangoName(ns, "CodeInterpreter"),
      description: "Code tools: run the model's Python in the code sandbox (D114)",
      role: this.role,
      // A cell runs up to its cutoff; its files are read and copied after it. A render waits
      // for two malware scans (60 s and 90 s) and the render function (3 min): less than this.
      timeout: Duration.seconds(CODE_CELL_SECONDS + 60),
      memorySize: 1536,
      environment: {
        MANGO_NAMESPACE: ns,
        COGNITO_ISSUER: props.issuer,
        COGNITO_CLIENT_ID: props.webClientId,
        TASKS_CLIENT_ID: props.tasksClientId,
        CODE_INTERPRETER_ID: props.codeInterpreter.attrCodeInterpreterId,
        CONVERSATIONS_TABLE: props.conversations.tableName,
        CONVERSATIONS_TABLE_ARN: props.conversations.tableArn,
        DATA_KEY_ARN: props.dataKey.keyArn,
        DATA_ROLE_ARN: props.dataAccessRoleArn,
        SESSION_KEY_ARN: props.dataKey.keyArn,
        CHAT_FILES_BUCKET: props.chatFiles.bucket.bucketName,
        RATE_LIMITS_TABLE: props.rateLimits.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        CELL_SECONDS: String(CODE_CELL_SECONDS),
        ...(props.renderDocument ? { RENDER_FUNCTION: renderDocumentName(ns) } : {}),
      },
      environmentEncryption: props.configKey,
    }).function;
    this.function.node.addDependency(policy);

    // --- Behind the Gateway (rule 3) -----------------------------------------------------
    // The Gateway's role is Core's; its permission to invoke this function lives here, so that
    // Core never reads this stack (D99 (4)).
    const gatewayRole = iam.Role.fromRoleArn(this, "GatewayRole", props.gateway.roleArn, { mutable: true });
    const invoke = new iam.Policy(this, "GatewayInvoke", {
      roles: [gatewayRole],
      statements: [
        new iam.PolicyStatement({
          sid: "InvokeCodeConnector",
          actions: ["lambda:InvokeFunction"],
          resources: [this.function.functionArn],
        }),
      ],
    });
    const tools = codeTools();
    this.target = new agentcore.CfnGatewayTarget(this, "Target", {
      gatewayIdentifier: props.gateway.id,
      name: CODE_TARGET_NAME,
      description: "Code sandbox of Mango's agents",
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: {
        mcp: { lambda: { lambdaArn: this.function.functionArn, toolSchema: { inlinePayload: tools } } },
      },
    });
    this.target.node.addDependency(invoke);
    // Like the knowledge search: any signed-in user on an invocation mango-api signed may call
    // it (D33). Which agent version has the tools, and which conversation they reach, the
    // signature decides (the interceptor refuses a call without conversation, TM-CI2).
    const actions = tools.map((t) => `AgentCore::Action::"${CODE_TARGET_NAME}___${t.name}"`);
    const cedar = new agentcore.CfnPolicy(this, "CedarPolicy", {
      name: `Mango_${ns}_CodeInterpreter`,
      description: "Signed-in users may run code in their own conversations; the signature decides which",
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
