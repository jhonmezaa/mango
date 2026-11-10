import { CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { roleNames } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { PythonFunction } from "./python-function.js";

/** What a guardrail policy is made of here: the fields `UpdateGuardrail` takes, as CloudFormation names them. */
export interface GuardrailPolicy {
  readonly name: string;
  readonly description: string;
  readonly blockedInputMessaging: string;
  readonly blockedOutputsMessaging: string;
  readonly contentPolicyConfig: { readonly filtersConfig: { type: string; inputStrength: string; outputStrength: string }[] };
  readonly sensitiveInformationPolicyConfig: {
    readonly piiEntitiesConfig: {
      type: string;
      action: string;
      inputAction?: string;
      inputEnabled?: boolean;
      outputAction?: string;
      outputEnabled?: boolean;
    }[];
  };
}

/** The turn policy (decision 44, D34): the base policy without its input `PROMPT_ATTACK` filter. */
export function turnPolicyOf(base: GuardrailPolicy): GuardrailPolicy {
  return {
    ...base,
    contentPolicyConfig: {
      filtersConfig: base.contentPolicyConfig.filtersConfig.filter((f) => f.type !== "PROMPT_ATTACK"),
    },
  };
}

export interface TurnGuardrailVersionProps {
  readonly installation: Installation;
  readonly guardrail: bedrock.CfnGuardrail;
  /** The pinned base version: the turn version is made after it, and again when it changes. */
  readonly baseVersion: bedrock.CfnGuardrailVersion;
  /** The policy of the base guardrail, the same object its template is made from. */
  readonly basePolicy: GuardrailPolicy;
  /** Digest of the turn policy, in the version's description: a new policy makes a new version. */
  readonly digest: string;
}

/**
 * The turn version of the base guardrail (decision 44, D34): the version the chat's harness
 * invocations carry. The person's new message is checked with the base version first
 * (`mango-api`); the harness evaluates the whole conversation, where the base's input
 * `PROMPT_ATTACK` filter blocked harmless second questions.
 *
 * A version of the same guardrail, so the agent roles already published (allowed to apply the
 * guardrail's ARN, which covers its versions) need nothing new. `mango_provisioner.turn_guardrail`
 * puts the turn policy in the `DRAFT`, creates the version and always puts the base policy back,
 * and fails unless the `DRAFT` then equals the base policy. Its role can only read, update and
 * version this guardrail, and the function refuses any turn policy but the base without
 * `PROMPT_ATTACK`.
 */
export class TurnGuardrailVersion extends Construct {
  /** The number of the turn version (`TURN_GUARDRAIL_VERSION` of `mango-api`). */
  readonly version: string;
  readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: TurnGuardrailVersionProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    const stack = Stack.of(this);

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.turnGuardrail(ns),
      description: "Turn version of the base guardrail (decision 44, D34): only this guardrail",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "VersionTheBaseGuardrail",
        actions: ["bedrock:GetGuardrail", "bedrock:UpdateGuardrail", "bedrock:CreateGuardrailVersion"],
        resources: [props.guardrail.attrGuardrailArn],
      }),
    );

    const fn = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      handler: "mango_provisioner.turn_guardrail.lambda_handler",
      functionName: roleNames.turnGuardrail(ns),
      description: "Turn version of the base guardrail (invoked only by CloudFormation)",
      role,
      // A fixed name: a log group retained by a rolled-back create would make the retry fail
      // ("already exists"). RetainExceptOnCreate deletes it only then (D58 (27)).
      logsRemovalPolicy: props.installation.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
      timeout: Duration.minutes(5),
      memorySize: 256,
    }).function;

    this.resource = new CustomResource(this, "Resource", {
      serviceToken: fn.functionArn,
      resourceType: "Custom::MangoTurnGuardrail",
      properties: {
        GuardrailId: props.guardrail.attrGuardrailId,
        BaseVersion: props.baseVersion.attrVersion,
        Base: stack.toJsonString(props.basePolicy),
        Turn: stack.toJsonString(turnPolicyOf(props.basePolicy)),
        Description: `Turn guardrail (policy ${props.digest}, base v${props.baseVersion.attrVersion})`,
      },
      serviceTimeout: Duration.minutes(10),
    });
    // Its permissions exist before it runs.
    this.resource.node.addDependency(role);
    this.version = this.resource.getAttString("Version");
    // The function's tracing (X-Ray) has no resource scope; its own permissions are above.
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
  }
}
