import { createHash } from "node:crypto";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { CfnDeletionPolicy, CfnResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CHECKOV_EXCEPTIONS, suppressCheckov } from "../checkov.js";
import { Installation } from "../config/schema.js";
import { agentNames, roleNames } from "../names.js";
import { acknowledge } from "../nag.js";
import { AgentMemory } from "./agent-memory.js";

/**
 * Runtime session lifecycle (D39). mango-api keeps one session per conversation and receives
 * the same values, so it only continues a session AgentCore still has.
 *
 * Idle: follow-up questions usually come within a few minutes; after that the next turn
 * starts a new session and replays the stored history. A session bills its memory while it
 * waits, so a shorter timeout costs less than the 900 s default.
 */
export const SESSION_IDLE_SECONDS = 300;
/** AgentCore's default maximum lifetime of a session, set explicitly so both sides agree. */
export const SESSION_MAX_SECONDS = 28_800;

export interface AgentPlatformProps {
  readonly installation: Installation;
}

/**
 * What every agent of the installation shares (Marketplace v1): the base guardrail (D34), the
 * key of the runtime log groups (D16) and the permissions boundary of agent roles (TM-M1).
 *
 * Agents themselves are not stack resources: the provisioner creates a role and a harness per
 * agent by SDK (D25, D32), under the names in {@link agentNames}.
 */
export class AgentPlatform extends Construct {
  /** Base guardrail applied on every invocation (spec §6, D11) and stored in each harness. */
  readonly guardrail: bedrock.CfnGuardrail;
  readonly guardrailVersion: bedrock.CfnGuardrailVersion;
  /**
   * `alias/Mango-<ns>-agent-runtime-logs`: encrypted the runtime log groups of every harness until
   * 2026-11-08 and still encrypts the MCP packs' (D16). It stays: the events written before keep
   * it until their retention takes them.
   */
  readonly runtimeLogsKey: kms.Key;
  /**
   * `alias/Mango-<ns>-harness-runtime-logs`: the runtime log groups of the agents' and the
   * Playground's harnesses, which are content (D16, precised 2026-11-08). The evals harness has its
   * own key (D110 (3)).
   */
  readonly harnessLogsKey: kms.Key;
  /** Ceiling of what any agent execution role may be allowed to do. */
  readonly boundary: iam.ManagedPolicy;
  /** The AgentCore Memory of the installation (D122): on in the release since 2026-11-08. */
  readonly memory: AgentMemory;

  /** `role/Mango-<ns>-agent-*`. */
  readonly agentRoleArns: string;
  /** `harness/Mango_<ns>_a_*`: harnesses the provisioner manages and mango-api invokes. */
  readonly harnessArns: string;
  /** `runtime/harness_Mango_<ns>_a_*`: the runtimes AgentCore creates for those harnesses. */
  readonly runtimeArns: string;
  /** Log groups of those runtimes (one per runtime endpoint). */
  readonly runtimeLogGroupArns: string;

  /**
   * D16, precised 2026-11-08: no role of Mango reads or exports the runtime log groups of the
   * harnesses, but the trace reader of D108, which reads their `spans` stream (unified telemetry)
   * and keeps a closed list of span attributes. The same actions as the evals' (D110 (8)); the
   * evals harness's log groups match the pattern too and keep their own Deny, which exempts only
   * the evaluator. An administrator of the account can still read them, like any data of the
   * account (D110 (8)): that read is the break-glass, and CloudTrail records it (the dry-run
   * `kms:Decrypt` of each reader with the harness logs key).
   *
   * The trace reader is exempted by the full ARN of its role, never by a name compared in CDK
   * (a token in the release, D110 (9)).
   */
  harnessLogsDenyStatements(actions: readonly string[]): iam.PolicyStatement[] {
    const { account } = Stack.of(this);
    return [
      new iam.PolicyStatement({
        sid: "NoHarnessRuntimeContent",
        effect: iam.Effect.DENY,
        actions: [...actions],
        resources: [this.runtimeLogGroupArns],
        conditions: {
          ArnNotEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${account}:role/${roleNames.traceReader(this.namespace)}`,
          },
        },
      }),
      new iam.PolicyStatement({
        // The key stays on them. Only the provisioner takes a key off: the evals harness's log
        // groups match this pattern too, and it binds their key again (D110 (9)).
        sid: "NoHarnessLogsKeyRemoval",
        effect: iam.Effect.DENY,
        actions: ["logs:DisassociateKmsKey"],
        resources: [this.runtimeLogGroupArns],
        conditions: {
          ArnNotEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${account}:role/${roleNames.provisioner(this.namespace)}`,
          },
        },
      }),
    ];
  }

  private readonly namespace: string;

  constructor(scope: Construct, id: string, props: AgentPlatformProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = (this.namespace = cfg.namespace);
    const stack = Stack.of(this);
    const agentcore = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}`;
    this.agentRoleArns = `arn:aws:iam::${stack.account}:role/${agentNames.rolePrefix(ns)}*`;
    this.harnessArns = `${agentcore}:harness/${agentNames.harnessPrefix(ns)}*`;
    this.runtimeArns = `${agentcore}:runtime/${agentNames.runtimePrefix(ns)}*`;
    this.runtimeLogGroupArns =
      `arn:aws:logs:${stack.region}:${stack.account}:log-group:` +
      `/aws/bedrock-agentcore/runtimes/${agentNames.runtimePrefix(ns)}*`;

    this.guardrail = new bedrock.CfnGuardrail(this, "Guardrail", {
      name: `Mango-${ns}-base`,
      description: "Mango base guardrail: prompt attacks, harmful content and credentials",
      blockedInputMessaging:
        "No puedo procesar esta solicitud porque infringe las políticas de uso de Mango.",
      blockedOutputsMessaging:
        "No puedo mostrar esta respuesta porque infringe las políticas de uso de Mango.",
      contentPolicyConfig: {
        filtersConfig: [
          { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" },
          ...["HATE", "INSULTS", "SEXUAL", "VIOLENCE", "MISCONDUCT"].map((type) => ({
            type,
            inputStrength: "MEDIUM",
            outputStrength: "MEDIUM",
          })),
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          ...["AWS_ACCESS_KEY", "AWS_SECRET_KEY", "CREDIT_DEBIT_CARD_NUMBER", "CREDIT_DEBIT_CARD_CVV"].map(
            (type) => ({ type, action: "BLOCK" }),
          ),
          // Decision of the owner, 2026-11-09 (AGENTS.md exceptions, D34): a password is masked,
          // not blocked, in and out. Blocked, one example password in a Canvas document cut every
          // later turn of its conversation, since the harness sends that document again.
          { type: "PASSWORD", action: "ANONYMIZE", inputAction: "ANONYMIZE", outputAction: "ANONYMIZE" },
        ],
      },
    });
    // A change of the policy needs a new version (the turns use the pinned one): its
    // description carries a digest of the policy, so CloudFormation makes one when it changes.
    const policy = {
      content: this.guardrail.contentPolicyConfig,
      sensitive: this.guardrail.sensitiveInformationPolicyConfig,
      blocked: [this.guardrail.blockedInputMessaging, this.guardrail.blockedOutputsMessaging],
    };
    const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
    this.guardrailVersion = new bedrock.CfnGuardrailVersion(this, "GuardrailVersion", {
      guardrailIdentifier: this.guardrail.attrGuardrailId,
      description: `Pinned base guardrail (policy ${digest})`,
    });
    // A new policy replaces the version: the old one stays, since a harness published before
    // keeps it in its default configuration (mango-api sends the new one with every turn).
    this.guardrailVersion.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;

    this.runtimeLogsKey = new kms.Key(this, "RuntimeLogsKey", {
      alias: `alias/Mango-${ns}-agent-runtime-logs`,
      description: "Encrypts the AgentCore runtime log groups of Mango agents",
      enableKeyRotation: true,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.runtimeLogsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsAgentRuntimeLogGroups",
        principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
        actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
        resources: ["*"],
        conditions: { ArnLike: { "kms:EncryptionContext:aws:logs:arn": this.runtimeLogGroupArns } },
      }),
    );

    // D16, precised 2026-11-08: the log of a harness is content, like the evals' (D110 (8)). The
    // key encrypts it at rest with a key only for these log groups (the service uses it only with
    // their encryption context), leaves every use in CloudTrail, the dry-run Decrypt CloudWatch
    // Logs makes as each reader included, and makes the content unreadable if it is deleted. Who
    // reads it is decided in IAM ({@link harnessLogsDenyStatements}): a Deny of the key does not
    // stop `GetLogEvents` (2026-11-06, D110 (8)).
    this.harnessLogsKey = new kms.Key(this, "HarnessLogsKey", {
      alias: `alias/Mango-${ns}-harness-runtime-logs`,
      description: "Encrypts the runtime log groups of the Mango harnesses, which are content (D16)",
      enableKeyRotation: true,
      // Retained on uninstall; deleted only if the operation that created it rolls back, so a
      // failed first update leaves no orphan key behind (D58 (27)).
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
    });
    this.harnessLogsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsHarnessRuntimeLogGroups",
        principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
        actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
        resources: ["*"],
        conditions: { ArnLike: { "kms:EncryptionContext:aws:logs:arn": this.runtimeLogGroupArns } },
      }),
    );

    // These resources were first created inside the FinOps agent construct. Keeping their
    // logical ids moves them here without CloudFormation replacing the guardrail (its id is in
    // use) or the key (its alias name would collide).
    (this.guardrail as CfnResource).overrideLogicalId("FinOpsAgentGuardrailEC59A646");
    (this.guardrailVersion as CfnResource).overrideLogicalId("FinOpsAgentGuardrailVersion2A836BE7");
    (this.runtimeLogsKey.node.defaultChild as CfnResource).overrideLogicalId("FinOpsAgentRuntimeLogsKey5A378BE8");
    (this.runtimeLogsKey.node.findChild("Alias").node.defaultChild as CfnResource).overrideLogicalId(
      "FinOpsAgentRuntimeLogsKeyAliasD7F791BF",
    );

    // D122: what the agents remember of each person. It holds data: here, in Core (D99 (2)).
    this.memory = new AgentMemory(this, "Memory", { installation: cfg });

    // --- Permissions boundary of agent roles (TM-M1) ---------------------------------------
    // The provisioner can only create roles that carry this policy, so whatever it writes in an
    // agent role, the role can never do more than this: call Bedrock models through the base
    // guardrail, and what the managed harness runtime needs for itself.
    this.boundary = new iam.ManagedPolicy(this, "Boundary", {
      managedPolicyName: agentNames.boundary(ns),
      description: "Permissions boundary of Mango agent execution roles (created by the provisioner)",
      statements: [
        new iam.PolicyStatement({
          sid: "InvokeModels",
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          // Which models an agent may use is set in its role, from the model catalog.
          resources: [
            `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/*`,
            "arn:aws:bedrock:*::foundation-model/*",
          ],
        }),
        new iam.PolicyStatement({
          sid: "ApplyBaseGuardrail",
          actions: ["bedrock:ApplyGuardrail"],
          resources: [this.guardrail.attrGuardrailArn],
        }),
        new iam.PolicyStatement({
          sid: "ManagedRuntimeImage",
          // Required by the managed harness environment; these APIs have no resource scope.
          actions: ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "RuntimeLogs",
          actions: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:DescribeLogStreams",
          ],
          resources: [this.runtimeLogGroupArns],
        }),
        new iam.PolicyStatement({
          sid: "Tracing",
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "Metrics",
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
        }),
        new iam.PolicyStatement({
          sid: "WorkloadIdentity",
          actions: [
            "bedrock-agentcore:GetWorkloadAccessToken",
            "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          ],
          resources: [
            `${agentcore}:workload-identity-directory/default`,
            `${agentcore}:workload-identity-directory/default/workload-identity/${agentNames.runtimePrefix(ns)}*`,
          ],
        }),
      ],
    });
    // Same agreed exception as the agent execution role (AGENTS.md): the boundary must allow
    // what that role needs to pull the managed harness image.
    suppressCheckov(this.boundary.node.defaultChild as CfnResource, CHECKOV_EXCEPTIONS.runtimeImageToken);
    acknowledge(
      this.boundary,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "Managed harness image pull (ecr-public:GetAuthorizationToken, sts:GetServiceBearerToken), " +
          "X-Ray and CloudWatch metrics (namespace-conditioned) have no resource scope.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/*]`,
        reason:
          "A boundary is a ceiling, not a grant: each agent role lists only the models of its approved " +
          "version, validated against the model catalog by the provisioner.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::arn:aws:bedrock:*::foundation-model/*]",
        reason:
          "A boundary is a ceiling, not a grant: each agent role lists only the models of its approved " +
          "version; cross-region inference profiles route to the model in several regions.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${this.runtimeLogGroupArns}]`,
        reason: "AgentCore names runtime log groups after the generated runtime id; the prefix pins this installation's agents.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${agentcore}:workload-identity-directory/default/workload-identity/${agentNames.runtimePrefix(ns)}*]`,
        reason: "The workload identity of a harness is named after its generated runtime id; the prefix pins this installation's agents.",
      },
    );
  }
}
