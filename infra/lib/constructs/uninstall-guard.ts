import { Aspects, CfnResource, CustomResource, Duration, Stack } from "aws-cdk-lib";
import * as agentcoreL1 from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct, IConstruct } from "constructs";
import { Installation } from "../config/schema.js";
import { acknowledge, REASONS } from "../nag.js";
import { agentNames, mangoName, packNames, roleNames } from "../names.js";
import { AgentPlatform } from "./agent-platform.js";
import { Alerts } from "./alerts.js";
import { PackPlatform } from "./pack-platform.js";
import { PythonFunction } from "./python-function.js";

export interface UninstallGuardProps {
  readonly installation: Installation;
  readonly platform: AgentPlatform;
  readonly packs: PackPlatform;
  readonly gateway: agentcoreL1.CfnGateway;
  readonly policyEngine: agentcoreL1.CfnPolicyEngine;
  /** Gateway targets the stack declares itself: the guard never deletes them. */
  readonly connectorTargets: string[];
  /** Key encrypting the function's environment. */
  readonly configKey: kms.IKey;
  readonly alerts: Alerts;
}

/**
 * Uninstall guard (D58): a custom resource that, when **the stack is being deleted**, removes
 * what the provisioners created by API (agent harnesses, pack runtimes, their Gateway targets,
 * Cedar policies, roles and log groups) and waits until it is gone. Without it the stack
 * deletion fails: those roles carry permissions boundaries of the stack.
 *
 * It depends on **every other resource of the stack** (D58 (16)), so it is created last and
 * deleted first. CloudFormation does not delete what a resource that failed to delete depends
 * on: if the guard fails, the stack ends in `DELETE_FAILED` with the installation still
 * standing, instead of half deleted (seen on 2026-10-07, when it depended only on what agents
 * and packs hold on to). Resources with a condition stay out: see `dependsOnTheRestOfTheStack`.
 *
 * Its role only deletes, only by the name prefixes of the installation, and roles only with
 * one of the two boundaries. It reads no data of the installation. Only CloudFormation (and
 * the function itself, to keep waiting) invokes it; any `Delete` outside a stack deletion is
 * a no-op (TM-D13, TM-D14). Code: `functions/provisioner/src/mango_provisioner/uninstall.py`.
 */
export class UninstallGuard extends Construct {
  /** Where an invocation that failed every retry lands (watched by `OperationalAlarms`). */
  readonly deadLetters: sqs.Queue;

  constructor(scope: Construct, id: string, props: UninstallGuardProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const { platform, packs } = props;
    const functionName = roleNames.uninstallGuard(ns);
    const functionArn = `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:${functionName}`;
    const agentcore = `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}`;
    const workloadIdentities = `${agentcore}:workload-identity-directory/default`;
    const boundaries = [platform.boundary.managedPolicyArn, packs.boundary.managedPolicyArn];

    const role = new iam.Role(this, "Role", {
      roleName: functionName,
      description: "Mango uninstall guard: deletes agents and packs created by API, only while the stack is deleted",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, ...(conditions ? { conditions } : {}) }));

    // The one fact that decides whether it acts at all.
    allow("ReadOwnStackStatus", ["cloudformation:DescribeStacks"], [stack.stackId]);
    allow("FindWhatProvisionersCreated", ["bedrock-agentcore:ListHarnesses", "bedrock-agentcore:ListAgentRuntimes"], ["*"]);
    allow(
      "DeleteAgentHarnesses",
      [
        // No GetHarness: a harness stores the agent's prompt and nothing here needs it.
        "bedrock-agentcore:ListHarnessEndpoints",
        "bedrock-agentcore:DeleteHarnessEndpoint",
        "bedrock-agentcore:DeleteHarness",
      ],
      [platform.harnessArns, `${platform.harnessArns}/harness-endpoint/*`],
    );
    allow(
      "DeleteRuntimes",
      [
        // AgentCore reads the managed runtime of a harness with the caller's permissions.
        "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:GetAgentRuntimeEndpoint",
        "bedrock-agentcore:ListAgentRuntimeEndpoints",
        "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
        "bedrock-agentcore:DeleteAgentRuntime",
      ],
      // Pack runtimes, and the managed runtime AgentCore removes with each harness.
      [packs.runtimeArns, `${packs.runtimeArns}/runtime-endpoint/*`, platform.runtimeArns, `${platform.runtimeArns}/*`],
    );
    allow(
      "DeleteWorkloadIdentities",
      ["bedrock-agentcore:DeleteWorkloadIdentity"],
      [
        workloadIdentities,
        `${workloadIdentities}/workload-identity/${agentNames.runtimePrefix(ns)}*`,
        `${workloadIdentities}/workload-identity/${packNames.runtimePrefix(ns)}*`,
      ],
    );
    allow(
      "DeletePackTargets",
      ["bedrock-agentcore:ListGatewayTargets", "bedrock-agentcore:DeleteGatewayTarget"],
      [props.gateway.attrGatewayArn],
    );
    const policyEngineArn = props.policyEngine.attrPolicyEngineArn;
    allow(
      "DeletePackPolicies",
      ["bedrock-agentcore:ListPolicies", "bedrock-agentcore:DeletePolicy"],
      [policyEngineArn, `${policyEngineArn}/policy/${packNames.policyPrefix(ns)}*`],
    );
    // A pack's Cedar policy is scoped to this Gateway, and AgentCore authorizes deleting it
    // against the Gateway too: without this, DeletePolicy is denied and the stack deletion
    // fails with the installation half deleted (seen on 2026-10-07, D58 (13)). It is not an
    // API call of its own: with no CreatePolicy or UpdatePolicy in this role, all it lets
    // through is the deletion above. Neither GetGateway nor InvokeGateway was needed.
    allow(
      "DeletePackPoliciesScopedToGateway",
      ["bedrock-agentcore:ManageResourceScopedPolicy"],
      [props.gateway.attrGatewayArn],
    );
    const roles = [platform.agentRoleArns, packs.roleArns];
    allow("FindRoles", ["iam:ListRoles"], ["*"]);
    allow("ReadProvisionedRoles", ["iam:GetRole", "iam:ListRolePolicies"], roles);
    // Only roles made by a provisioner: they carry one of the two boundaries (TM-M1).
    allow("DeleteProvisionedRoles", ["iam:DeleteRolePolicy", "iam:DeleteRole"], roles, {
      StringEquals: { "iam:PermissionsBoundary": boundaries },
    });
    allow("FindRuntimeLogGroups", ["logs:DescribeLogGroups"], ["*"]);
    allow("DeleteRuntimeLogGroups", ["logs:DeleteLogGroup"], [platform.runtimeLogGroupArns, packs.runtimeLogGroupArns]);
    // Deletions in AgentCore are asynchronous: the function invokes itself to keep waiting.
    allow("KeepWaiting", ["lambda:InvokeFunction"], [functionArn]);

    // That self-invocation is asynchronous: an event that fails every retry lands here (AGENTS.md).
    const deadLetters = (this.deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "UninstallGuard-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.alerts.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    }));
    allow("DeadLetterQueueKey", ["kms:Decrypt", "kms:GenerateDataKey"], [props.alerts.key.keyArn], {
      StringEquals: { "kms:ViaService": `sqs.${stack.region}.amazonaws.com` },
    });

    const guard = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      retainLogs: cfg.retainData,
      handler: "mango_provisioner.uninstall.lambda_handler",
      functionName,
      description: "Removes agents and packs created by API when the stack is deleted (invoked only by CloudFormation)",
      role,
      // One invocation polls for 13 minutes and hands over to the next (uninstall.py).
      timeout: Duration.minutes(15),
      memorySize: 256,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        GATEWAY_ID: props.gateway.attrGatewayIdentifier,
        POLICY_ENGINE_ID: props.policyEngine.attrPolicyEngineId,
        CONNECTOR_TARGETS: props.connectorTargets.join(","),
        ROLE_BOUNDARY_ARNS: boundaries.join(","),
      },
      environmentEncryption: props.configKey,
    }).function;

    // No property that changes between releases and a fixed physical id: an update never
    // replaces it. If one ever did, the function still refuses to act (stack not deleting).
    const resource = new CustomResource(this, "Resource", {
      serviceToken: guard.functionArn,
      resourceType: "Custom::MangoUninstallGuard",
      // CloudFormation waits this long for the answer; the function gives up a little earlier.
      serviceTimeout: Duration.minutes(60),
    });
    dependsOnTheRestOfTheStack(resource.node.defaultChild as CfnResource);

    acknowledge(
      role,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          `${REASONS.xray} bedrock-agentcore:ListHarnesses, bedrock-agentcore:ListAgentRuntimes, iam:ListRoles and ` +
          "logs:DescribeLogGroups have no resource scope; they only list names.",
      },
      ...[
        platform.harnessArns,
        `${platform.harnessArns}/harness-endpoint/*`,
        packs.runtimeArns,
        `${packs.runtimeArns}/runtime-endpoint/*`,
        platform.runtimeArns,
        `${platform.runtimeArns}/*`,
        `${workloadIdentities}/workload-identity/${agentNames.runtimePrefix(ns)}*`,
        `${workloadIdentities}/workload-identity/${packNames.runtimePrefix(ns)}*`,
        `${policyEngineArn}/policy/${packNames.policyPrefix(ns)}*`,
        ...roles,
        platform.runtimeLogGroupArns,
        packs.runtimeLogGroupArns,
      ].map((resourceArn) => ({
        id: `AwsSolutions-IAM5[Resource::${resourceArn}]`,
        reason:
          "Agents and packs are created at runtime, one harness, runtime, role and log group each (D32, D19): the " +
          "name prefix of the installation is the scope. Delete-only, and roles only with a Mango boundary.",
      })),
    );
  }
}

/**
 * Makes `guard` depend on every other resource of its stack, whenever it is declared: an aspect,
 * so that what the stack adds after the guard, or in a later release, is included without
 * anyone remembering to list it. A test fails if a resource is left out (`release.test.ts`).
 *
 * A resource with a condition is not included: CloudFormation documents that what depends on
 * a resource its condition leaves out is not created either, and the guard must always exist.
 */
function dependsOnTheRestOfTheStack(guard: CfnResource): void {
  Aspects.of(guard.stack).add({
    visit(node: IConstruct): void {
      if (!CfnResource.isCfnResource(node) || node === guard || node.stack !== guard.stack) return;
      if (node.cfnOptions.condition !== undefined) return;
      guard.addResourceDependency(node);
    },
  });
}
