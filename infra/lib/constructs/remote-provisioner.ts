import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcoreL1 from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { remoteNames, roleNames } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { PythonFunction } from "./python-function.js";
import { remoteProvisionerName } from "./remote-mcp-api.js";
import { RemoteRelease } from "./remote-release.js";

/** `mango_core.remote_mcp.SIGNING_ALGORITHM`: the only algorithm the provisioner signs with. */
const REMOTE_SIGNING_ALGORITHM = "ECDSA_SHA_256";

/** `REMOTE#<reg>` / `REGISTRATION`: written by mango-api, its lifecycle by this provisioner. */
export const REMOTE_REGISTRATION_PARTITION = "REMOTE#";
/** `REMOTE_CHANGE#<reg>`: the requests mango-api records; read only here. */
export const REMOTE_CHANGE_PARTITION = "REMOTE_CHANGE#";
/**
 * `MCP_REMOTE#<reg>` / `APPROVED`: the signed approved catalog. Only this provisioner writes
 * it; keep in sync with `mango_core.remote_mcp.APPROVED_PREFIX`.
 */
export const REMOTE_APPROVED_PARTITION = "MCP_REMOTE#";

/**
 * Attributes of a registration the remote provisioner may name in a write (IAM
 * `dynamodb:Attributes`, which also counts those of the condition expression): its lifecycle,
 * its lock and the failure (D98 (12)). Never the organization, the tenant, the app, the
 * toolsets, the groups, the generation or who asked: those are mango-api's; what is live is
 * the signed catalog. Keep in sync with
 * `functions/provisioner/src/mango_provisioner/remotes/store.py`.
 */
export const REMOTE_PROVISIONER_WRITABLE_ATTRIBUTES = [
  "PK",
  "SK",
  "status",
  "updated_at",
  "version",
  "approval_id",
  "failure_code",
  "failed_step",
  "provision_lock",
  "provision_lock_until",
];

export interface RemoteMcpProvisionerProps {
  readonly installation: Installation;
  readonly settingsTable: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the tables above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** The installation's tools Gateway and its Cedar policy engine (L2). */
  readonly gateway: agentcoreL1.CfnGateway;
  readonly policyEngine: agentcoreL1.CfnPolicyEngine;
  /** Gateway targets of Mango connectors: never taken or touched. */
  readonly connectorTargets: string[];
  /** The signed remote profiles of the release (D98 (14)). */
  readonly remotes: RemoteRelease;
  /** PEM of the provider's signing key that verifies the profiles, or "" without one. */
  readonly signingPublicKey: string;
  /** Origin of the SPA (`https://<domain>`): the return URL is its `/conexiones/vuelta`. */
  readonly appOrigin: string;
  /** `alias/Mango-<ns>-remote-mcp` (`Tools`): its key policy lets only this role sign. */
  readonly signingKey: kms.IKey;
}

/**
 * Remote MCP provisioner (D93, D98, plan PR-4): a Step Functions state machine whose tasks are
 * one Lambda that turns an approved registration of a third-party MCP server into a Gateway
 * target `remote-<reg>`, its Cedar policies and the signed approved catalog, and removes them
 * on disable. By SDK only (D25): nothing is built, downloaded or deployed at runtime.
 *
 * It has its own role, apart from the pack and agent provisioners. It is the only role that may
 * sign with `alias/Mango-<ns>-remote-mcp` (the key policy denies everyone else, TM-012): what
 * mango-api writes cannot widen what the interceptor lets through. It cannot create OAuth2
 * providers (mango-api does, with the secret, D93 (7)), only delete those of remote MCPs.
 */
export class RemoteMcpProvisioner extends Construct {
  readonly function: lambda.Function;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RemoteMcpProvisionerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const agentcore = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}`;
    const policyEngineArn = props.policyEngine.attrPolicyEngineArn;
    const remotePoliciesSuffix = `/policy/${remoteNames.policyPrefix(ns)}*`;
    const tokenVault = `${agentcore}:token-vault/default`;
    const providers = `${tokenVault}/oauth2credentialprovider/${remoteNames.providerPrefix(ns)}*`;
    // CloudFormation returns the Gateway's workload identity only as an object: AgentCore names
    // it after the Gateway (finding of 2026-10-27), and the function reads it from GetGateway.
    const workloadIdentities = `${agentcore}:workload-identity-directory/default`;
    const gatewayIdentity = `${workloadIdentities}/workload-identity/mango-${ns}-tools-*`;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.remoteMcpProvisioner(ns),
      description: "Remote MCP provisioner: Gateway targets remote-*, their policies and the signed approved catalog",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // --- Gateway: targets and Cedar policies of this installation ------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RemoteGatewayTargets",
        // Target ids are generated, so IAM cannot pin `remote-<reg>` by name: the function
        // only ever touches that name, and refuses one that is not its own (`foreign_target`).
        actions: [
          "bedrock-agentcore:CreateGatewayTarget",
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:UpdateGatewayTarget",
          "bedrock-agentcore:DeleteGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
        ],
        resources: [props.gateway.attrGatewayArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RemotePolicies",
        actions: [
          "bedrock-agentcore:CreatePolicy",
          "bedrock-agentcore:GetPolicy",
          "bedrock-agentcore:UpdatePolicy",
          "bedrock-agentcore:DeletePolicy",
          "bedrock-agentcore:ListPolicies",
        ],
        resources: [policyEngineArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageRemotePolicies",
        // Only the policies named after a remote target: never a connector's or a pack's.
        actions: ["bedrock-agentcore:GetPolicy", "bedrock-agentcore:UpdatePolicy", "bedrock-agentcore:DeletePolicy"],
        resources: [`${policyEngineArn}${remotePoliciesSuffix}`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ScopeRemotePoliciesToGateway",
        // As for packs (finding of 2026-10-07): a policy scoped to the Gateway is also
        // authorized on it, and the engine validates actions against its tools. The Gateway's
        // inbound authorization is a Cognito JWT, so this does not let the role call tools.
        actions: [
          "bedrock-agentcore:GetGateway",
          "bedrock-agentcore:InvokeGateway",
          "bedrock-agentcore:ManageResourceScopedPolicy",
        ],
        resources: [props.gateway.attrGatewayArn],
      }),
    );

    // --- Identity: the return URL and the deletion of providers --------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "GatewayReturnUrl",
        // The Gateway's own workload identity, and the directory AgentCore also authorizes on.
        actions: ["bedrock-agentcore:GetWorkloadIdentity", "bedrock-agentcore:UpdateWorkloadIdentity"],
        resources: [workloadIdentities, gatewayIdentity],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteRemoteProviders",
        // Never CreateOauth2CredentialProvider or UpdateOauth2CredentialProvider: the secret
        // only goes through mango-api (D93 (7)). Identity takes the provider's secret with it;
        // whether it asks the caller for more is to be seen live (D98, V-1), not granted before.
        actions: ["bedrock-agentcore:DeleteOauth2CredentialProvider"],
        resources: [tokenVault, providers],
      }),
    );

    // --- The approved catalog: sign with the remote MCP key only -------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "SignApprovedRemoteCatalog",
        // `alias/Mango-<ns>-remote-mcp` (D93 (9)) and no other key. Its key policy denies
        // kms:Sign to every other principal (TM-012). Only the way `remotes/signing.py`
        // signs: a SHA-256 digest with ECDSA, as the provider's release key.
        actions: ["kms:Sign"],
        resources: [props.signingKey.keyArn],
        conditions: {
          StringEquals: { "kms:SigningAlgorithm": REMOTE_SIGNING_ALGORITHM, "kms:MessageType": "DIGEST" },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadRemoteCatalogPublicKey",
        actions: ["kms:GetPublicKey"],
        resources: [props.signingKey.keyArn],
      }),
    );

    // --- Release: read only the profiles this release names ------------------------------
    props.remotes.grantRead(role);

    // --- Data: read registrations and requests, write lifecycle and the catalog ----------
    const settings = props.settingsTable.tableArn;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadRemoteRegistrations",
        actions: ["dynamodb:GetItem"],
        resources: [settings],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              `${REMOTE_REGISTRATION_PARTITION}*`,
              `${REMOTE_CHANGE_PARTITION}*`,
              `${REMOTE_APPROVED_PARTITION}*`,
            ],
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteRemoteLifecycle",
        actions: ["dynamodb:UpdateItem"],
        resources: [settings],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${REMOTE_REGISTRATION_PARTITION}*`] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": REMOTE_PROVISIONER_WRITABLE_ATTRIBUTES },
          // Never get whole items back from a write.
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteApprovedRemoteCatalog",
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [settings],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${REMOTE_APPROVED_PARTITION}*`] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteAuditIndex",
        actions: ["dynamodb:PutItem"],
        resources: [props.auditIndex.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DAY#*"] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteAuditTrail",
        actions: ["firehose:PutRecord"],
        resources: [props.auditStream.deliveryStreamArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DataKeyViaDynamoDB",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [props.dataKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      retainLogs: cfg.retainData,
      handler: "mango_provisioner.remotes.handler.lambda_handler",
      functionName: roleNames.remoteMcpProvisioner(ns),
      description: "Remote MCP provisioner step (invoked only by its state machine)",
      role,
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        MANGO_NAMESPACE: ns,
        MANGO_ACCOUNT_ID: stack.account,
        MANGO_STACK_ID: stack.stackId,
        SETTINGS_TABLE: props.settingsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        PACKS_BUCKET: props.remotes.bucketName,
        // What may become a target comes from the template only: the key that verifies the
        // profiles (not a secret) and the one signed statement per profile of this release.
        PACK_SIGNING_PUBLIC_KEY: props.signingPublicKey,
        ...props.remotes.environment,
        GATEWAY_ID: props.gateway.attrGatewayIdentifier,
        POLICY_ENGINE_ID: props.policyEngine.attrPolicyEngineId,
        // By ARN, as the interceptor verifies with it: an alias moved to another key signs nothing.
        REMOTE_MCP_KEY_ARN: props.signingKey.keyArn,
        REMOTE_RETURN_URL: `${props.appOrigin}${remoteNames.returnPath}`,
        CONNECTOR_TARGETS: JSON.stringify(props.connectorTargets),
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray },
      {
        id: arnWildcardFinding(props.policyEngine, remotePoliciesSuffix, "PolicyEngineArn", role),
        reason: "Cedar policies of remote targets are created at runtime; the name prefix keeps the connectors' and packs' out of reach.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${providers}]`,
        reason: "OAuth2 providers of remote MCPs are created by mango-api at runtime (D93 (7)): the name prefix is the scope. Delete only.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${gatewayIdentity}]`,
        reason:
          "The Gateway's workload identity is named after the Gateway by AgentCore and CloudFormation does not return " +
          "it as a string: the Gateway's name prefix is the scope, and the function checks it against GetGateway.",
      },
    );

    this.stateMachine = this.buildStateMachine(cfg);
  }

  /** Only mango-api starts executions, with `{registration_id, approval_id}`. */
  grantStart(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "StartRemoteMcpProvisioner",
        actions: ["states:StartExecution"],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );
  }

  private buildStateMachine(cfg: Installation): sfn.StateMachine {
    const name = remoteProvisionerName(cfg.namespace);

    // One task per step. The state is only identifiers and flags; the execution name comes
    // from the context, not from the state.
    const step = (id: string, stepName: string): tasks.LambdaInvoke =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: this.function,
        payload: sfn.TaskInput.fromObject({
          step: stepName,
          state: sfn.JsonPath.entirePayload,
          execution: sfn.JsonPath.stringAt("$$.Execution.Name"),
        }),
        payloadResponseOnly: true,
        retryOnServiceExceptions: true,
        taskTimeout: sfn.Timeout.duration(Duration.seconds(80)),
      });
    const retryTransient = (task: tasks.LambdaInvoke, interval: number, maxAttempts: number, backoffRate: number) =>
      task.addRetry({ errors: ["RetryableStepError"], interval: Duration.seconds(interval), maxAttempts, backoffRate });

    const failed = new sfn.Fail(this, "RemoteFailed", {
      error: "RemoteMcpProvisioningFailed",
      cause: "The remote MCP was not enabled or disabled; see failed_step and failure_code on its registration.",
    });
    const markFailed = step("MarkFailed", "mark_failed");
    retryTransient(markFailed, 5, 4, 2);
    markFailed.addCatch(failed, { errors: ["States.ALL"], resultPath: "$.mark_error" });
    markFailed.next(failed);

    // Deleting policies and a target is asynchronous.
    const compensate = step("Compensate", "compensate");
    retryTransient(compensate, 10, 30, 1);
    compensate.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.compensation_error" });
    compensate.next(markFailed);

    const forward = (id: string, stepName: string): tasks.LambdaInvoke => {
      const task = step(id, stepName);
      retryTransient(task, 5, 6, 1.5);
      task.addCatch(compensate, { errors: ["States.ALL"], resultPath: "$.error" });
      return task;
    };

    const isReady = sfn.Condition.booleanEquals("$.ready", true);
    const waitFor = (id: string, check: tasks.LambdaInvoke, seconds: number, next: sfn.IChainable) => {
      const wait = new sfn.Wait(this, `Wait${id}`, { time: sfn.WaitTime.duration(Duration.seconds(seconds)) });
      wait.next(check).next(new sfn.Choice(this, `${id}Ready?`).when(isReady, next).otherwise(wait));
      return wait;
    };

    // The signed catalog goes last: until then the interceptor lets nothing through.
    const active = forward("SignItem", "sign_item")
      .next(forward("MarkActive", "mark_active"))
      .next(new sfn.Succeed(this, "Enabled"));
    const policies = forward("EnsurePolicies", "ensure_policies").next(
      waitFor("Policies", forward("CheckPolicies", "check_policies"), 4, active),
    );
    const enable = forward("EnsureReturnUrl", "ensure_return_url")
      .next(forward("EnsureTarget", "ensure_target"))
      .next(waitFor("Target", forward("CheckTarget", "check_target"), 4, policies));

    // A removal is never undone: it is retried until every resource is gone.
    const remove = step("Remove", "remove");
    retryTransient(remove, 10, 60, 1);
    remove.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.error" });
    remove.next(new sfn.Succeed(this, "Disabled"));

    const definition = forward("Load", "load").next(
      new sfn.Choice(this, "Action?")
        .when(sfn.Condition.stringEquals("$.action", "noop"), new sfn.Succeed(this, "NothingToDo"))
        .when(sfn.Condition.stringEquals("$.action", "disable"), remove)
        .otherwise(enable),
    );

    const logGroup = new logs.LogGroup(this, "StateMachineLogs", {
      logGroupName: `/aws/vendedlogs/states/${name}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: name,
      comment: "Enables, changes or disables a remote MCP registration (D93, D98)",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      // Shorter than the provisioner lock (45 minutes): a running execution never loses it.
      timeout: Duration.minutes(40),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
    acknowledge(
      stateMachine,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: `CloudWatch Logs delivery APIs (vended logs) and X-Ray have no resource scope. ${REASONS.xray}`,
      },
      {
        id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).resolve(Stack.of(this).getLogicalId(this.function.node.defaultChild as lambda.CfnFunction))}.Arn>:*]`,
        reason: REASONS.cdkGrant,
      },
    );
    return stateMachine;
  }
}
