import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { CfnResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CHECKOV_EXCEPTIONS, suppressCheckov } from "../checkov.js";
import { Installation } from "../config/schema.js";
import { agentNames } from "../names.js";
import { acknowledge } from "../nag.js";

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
  /** Encrypts the AgentCore runtime log groups of all agents. */
  readonly runtimeLogsKey: kms.Key;
  /** Ceiling of what any agent execution role may be allowed to do. */
  readonly boundary: iam.ManagedPolicy;

  /** `role/Mango-<ns>-agent-*`. */
  readonly agentRoleArns: string;
  /** `harness/Mango_<ns>_a_*`: harnesses the provisioner manages and mango-api invokes. */
  readonly harnessArns: string;
  /** `runtime/harness_Mango_<ns>_a_*`: the runtimes AgentCore creates for those harnesses. */
  readonly runtimeArns: string;
  /** Log groups of those runtimes (one per runtime endpoint). */
  readonly runtimeLogGroupArns: string;

  constructor(scope: Construct, id: string, props: AgentPlatformProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
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
          "AWS_ACCESS_KEY",
          "AWS_SECRET_KEY",
          "CREDIT_DEBIT_CARD_NUMBER",
          "CREDIT_DEBIT_CARD_CVV",
          "PASSWORD",
        ].map((type) => ({ type, action: "BLOCK" })),
      },
    });
    this.guardrailVersion = new bedrock.CfnGuardrailVersion(this, "GuardrailVersion", {
      guardrailIdentifier: this.guardrail.attrGuardrailId,
      description: "Pinned base guardrail",
    });

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

    // These resources were first created inside the FinOps agent construct. Keeping their
    // logical ids moves them here without CloudFormation replacing the guardrail (its id is in
    // use) or the key (its alias name would collide).
    (this.guardrail as CfnResource).overrideLogicalId("FinOpsAgentGuardrailEC59A646");
    (this.guardrailVersion as CfnResource).overrideLogicalId("FinOpsAgentGuardrailVersion2A836BE7");
    (this.runtimeLogsKey.node.defaultChild as CfnResource).overrideLogicalId("FinOpsAgentRuntimeLogsKey5A378BE8");
    (this.runtimeLogsKey.node.findChild("Alias").node.defaultChild as CfnResource).overrideLogicalId(
      "FinOpsAgentRuntimeLogsKeyAliasD7F791BF",
    );

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
