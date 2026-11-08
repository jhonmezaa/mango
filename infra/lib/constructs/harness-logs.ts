import { CustomResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { agentNames, roleNames } from "../names.js";
import { acknowledge } from "../nag.js";
import { evalsHarness } from "./evals.js";
import { PythonFunction } from "./python-function.js";

export interface HarnessLogsGovernorProps {
  readonly installation: Installation;
  /** `alias/Mango-<ns>-harness-runtime-logs`, in Core (it encrypts content, D99 (2)). */
  readonly keyArn: string;
  /** The Core stack's id: the event of a custom resource in a nested stack names the nested one. */
  readonly coreStackId: string;
  /** Changes with every version, so that CloudFormation calls the function on every update. */
  readonly release: string;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
}

/**
 * Harness log governor (D16, precised 2026-11-08): on install and on every version update, the
 * log groups of the harnesses already published get the harness logs key, 7 days and their tags
 * (`mango_provisioner.harness_logs`). A harness published again gets them from the provisioner;
 * this corrects the ones a release does not publish again. Nothing is deleted and the evals
 * harness's log groups are never touched (its own key and 30 days, D110 (3)).
 *
 * Writes: `AssociateKmsKey`, `PutRetentionPolicy` and `TagResource`, only on the runtime log groups
 * of this installation's harnesses. Reads: their names, key and retention (`DescribeLogGroups`, no
 * resource scope) and Core's status and tags. It reads no event: the Deny of the harnesses' log
 * groups (`Mango-<ns>-evals-content-deny`) applies to its role like to every other.
 */
export class HarnessLogsGovernor extends Construct {
  readonly function: PythonFunction["function"];
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: HarnessLogsGovernorProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    const { region, account } = Stack.of(this);
    const groups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${agentNames.runtimePrefix(ns)}*`;
    const evals = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${evalsHarness.runtimePrefix(ns)}*`;
    const core = `arn:aws:cloudformation:${region}:${account}:stack/Mango-${ns}-Core/*`;

    this.role = new iam.Role(this, "Role", {
      roleName: roleNames.harnessLogs(ns),
      description: "Harness log governor: key, retention and tags of the harnesses' runtime log groups (D16)",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const allow = (sid: string, actions: string[], resources: string[]) =>
      this.role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources }));
    allow("GovernHarnessLogGroups", ["logs:AssociateKmsKey", "logs:PutRetentionPolicy", "logs:TagResource"], [
      groups,
      `${groups}:*`,
    ]);
    // Names, key and retention of the log groups; no resource scope.
    allow("FindHarnessLogGroups", ["logs:DescribeLogGroups"], ["*"]);
    // CloudWatch Logs checks that the caller can use the key it associates.
    allow("HarnessLogsKey", ["kms:DescribeKey"], [props.keyArn]);
    // Core's status (it never acts while Core rolls back) and its tags (D76).
    allow("ReadCoreStack", ["cloudformation:DescribeStacks"], [core]);
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "NeverTheEvalsHarness",
        // Its own key and 30 days (D110 (3)). The function also skips it; this makes it a rule.
        effect: iam.Effect.DENY,
        actions: ["logs:*"],
        resources: [evals, `${evals}:*`],
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      // A fixed name: a log group retained by a rolled-back create would make the retry fail
      // ("already exists"). RetainExceptOnCreate deletes it only then (D58 (27)).
      logsRemovalPolicy: props.installation.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
      handler: "mango_provisioner.harness_logs.lambda_handler",
      functionName: roleNames.harnessLogs(ns),
      description: "Key, retention and tags of the harnesses' runtime log groups (invoked only by CloudFormation)",
      role: this.role,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: { MANGO_NAMESPACE: ns, MANGO_ACCOUNT_ID: account, HARNESS_LOGS_KEY_ARN: props.keyArn },
      environmentEncryption: props.configKey,
    }).function;

    const resource = new CustomResource(this, "Resource", {
      serviceToken: this.function.functionArn,
      resourceType: "Custom::MangoHarnessLogs",
      properties: { Release: props.release, CoreStackId: props.coreStackId },
      serviceTimeout: Duration.minutes(10),
    });
    // Its permissions exist before it runs.
    resource.node.addDependency(this.role);

    acknowledge(
      this.role,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: "logs:DescribeLogGroups has no resource scope; it only reads names, keys and retention.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${groups}]`,
        reason:
          "Key, retention and tags only, on the runtime log groups of this installation's harnesses " +
          "(`harness_Mango_<ns>_a_*`): their names end in an id AgentCore assigns (D16).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${groups}:*]`,
        reason: "`:*` is how IAM names those log groups for some logs actions; same log groups as above.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${core}]`,
        reason: "The Core stack of this installation, by name; its id ends in a generated suffix. Read only.",
      },
    );
  }
}
