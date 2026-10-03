import {
  Aspects,
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { coreParameters } from "../config/release.js";
import { Installation } from "../config/schema.js";
import { AgentPlatform, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from "../constructs/agent-platform.js";
import { Alerts } from "../constructs/alerts.js";
import { ApiService } from "../constructs/api-service.js";
import { Deprovisioner } from "../constructs/deprovisioner.js";
import { Edge } from "../constructs/edge.js";
import { Governance, GROUPS_PARTITION } from "../constructs/governance.js";
import { Identity, SESSION_HOURS } from "../constructs/identity.js";
import { MemberAccess } from "../constructs/member-access.js";
import { Network } from "../constructs/network.js";
import { Observability } from "../constructs/observability.js";
import { importPackNetwork, PackNetwork, PackNetworkRef } from "../constructs/pack-network.js";
import {
  accountDataPacks,
  loadPackRelease,
  memberChainPacks,
  PackPlatform,
  payerChainPacks,
} from "../constructs/pack-platform.js";
import { PACK_INSTALLED_PARTITION, PackProvisioner } from "../constructs/pack-provisioner.js";
import { Provisioner } from "../constructs/provisioner.js";
import { Reconciler } from "../constructs/reconciler.js";
import { ReleaseAgents, releaseAgents } from "../constructs/release-agents.js";
import { Tools } from "../constructs/tools.js";
import { UninstallGuard } from "../constructs/uninstall-guard.js";
import { WriteTools } from "../constructs/write-tools.js";
import { acknowledge, KMS_GRANT_ACTIONS, REASONS } from "../nag.js";
import { CheckovSuppressions } from "../checkov.js";
import { GUARD_EXCEPTIONS, GuardSuppressions, suppressGuard } from "../guard.js";
import { LogsKey, ShortKeyDeletionWindow } from "../logs.js";
import { mangoName } from "../names.js";
import { tagNamespace } from "../params.js";
import { ReleaseTarget } from "../release-target.js";
import { MEMBER_READ_ONLY_DATA_ACTIONS } from "./member-stack.js";
import { BILLING_READER_DATA_ACTIONS } from "./payer-stack.js";

export interface CoreStackProps extends StackProps {
  /**
   * The values of one installation, written into the template. Omitted in a release (D58):
   * the template then asks for them as stack parameters and is the same for every customer.
   */
  readonly installation?: Installation;
  /** Where the release is published: its assets and the mango-api image are read from there. */
  readonly release?: ReleaseTarget;
}

/** `Mango-<ns>-Core`: the Mango installation in its dedicated account. */
export class CoreStack extends Stack {
  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);
    const release = props.installation === undefined ? coreParameters(this) : undefined;
    const cfg = props.installation ?? release!.installation;
    // A release names its resources after a parameter: the tag goes on them, not on the stack.
    if (release) tagNamespace(this, cfg.namespace);
    new LogsKey(this, { namespace: cfg.namespace, retainData: cfg.retainData });

    const accessLogs = new s3.Bucket(this, "AccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !cfg.retainData,
      lifecycleRules: [{ expiration: Duration.days(90) }],
    });
    suppressGuard(
      accessLogs.node.defaultChild as CfnResource,
      GUARD_EXCEPTIONS.logBucketLogging,
      GUARD_EXCEPTIONS.logBucketVersioning,
    );

    const network = new Network(this, "Network", { installation: cfg, accessLogs });
    const edge = new Edge(this, "Edge", { installation: cfg, alb: network.alb, accessLogs });
    const identity = new Identity(this, "Identity", {
      installation: cfg,
      appOrigin: edge.origin,
      ...(release ? { secondAdmin: { email: release.secondAdminEmail, when: release.hasSecondAdmin } } : {}),
    });

    const apiTaskRole = new iam.Role(this, "ApiTaskRole", {
      roleName: mangoName(cfg.namespace, "ApiTask"),
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    const governance = new Governance(this, "Governance", {
      installation: cfg,
      apiTaskRole,
      ...(release ? { auditLockMode: release.auditLockMode } : {}),
    });
    // D35: the pre-token trigger derives `mango_central` from the group registry (and reads
    // nothing else of the Settings table).
    identity.readGroupRegistry(governance.settings, governance.dataKey, GROUPS_PARTITION);

    // Signed MCP packs of the release (D36), verified here once. Those that read account
    // data act as the calling user through the Billing broker (D37).
    const packRelease = loadPackRelease(this, cfg);
    const tools = new Tools(this, "Tools", {
      installation: cfg,
      accountDataPacks: accountDataPacks(packRelease),
      payerChainPacks: payerChainPacks(packRelease),
      issuer: identity.issuer,
      discoveryUrl: identity.discoveryUrl,
      webClientId: identity.webClient.userPoolClientId,
      settingsTable: governance.settings,
      dataKey: governance.dataKey,
    });
    // Write tools with approval (D27): requests, the approval key and the approval executor.
    const writeTools = new WriteTools(this, "WriteTools", {
      installation: cfg,
      tools,
      apiTaskRole,
      dataKey: governance.dataKey,
      issuer: identity.issuer,
      webClientId: identity.webClient.userPoolClientId,
    });
    // Broker to the member accounts (§4.10); the spoke roles come from the OrgAccess StackSet.
    const memberAccess = new MemberAccess(this, "MemberAccess", {
      installation: cfg,
      adminProbe: tools.adminProbe,
      memberChainPacks: memberChainPacks(packRelease),
    });
    const agentPlatform = new AgentPlatform(this, "AgentPlatform", { installation: cfg });
    // Marketplace v1 (D18, D32): agents are published by SDK, not by this stack. The agents
    // of the release (FinOps) are seeded as approved versions and published the same way (D34).
    const shipped = releaseAgents(cfg);
    const releaseHashes = Object.fromEntries(shipped.map((a) => [a.id, a.contentHash]));
    const provisioner = new Provisioner(this, "Provisioner", {
      installation: cfg,
      platform: agentPlatform,
      agentsTable: governance.agents,
      settingsTable: governance.settings,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      gatewayUrl: tools.gatewayUrl,
      releaseAgents: releaseHashes,
    });
    const releaseAgentSeeds = new ReleaseAgents(this, "ReleaseAgents", {
      agents: shipped,
      agentsTable: governance.agents,
      dataKey: governance.dataKey,
      stateMachine: provisioner.stateMachine,
      provisioner: provisioner.function,
    });
    // D48: retiring an agent deletes its harness and its role, by SDK and with a role of its
    // own that can only delete. The agents of the release keep theirs.
    const deprovisioner = new Deprovisioner(this, "Deprovisioner", {
      installation: cfg,
      platform: agentPlatform,
      agentsTable: governance.agents,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      releaseAgents: releaseHashes,
    });
    const alerts = new Alerts(this, "Alerts", { installation: cfg });
    // Daily read-only reconciliation and the alarms of the publication path (TM-M6, TM-M9).
    // It also reports a release agent that serves content other than the release's (D42).
    new Reconciler(this, "Reconciler", {
      installation: cfg,
      platform: agentPlatform,
      agentsTable: governance.agents,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      provisioner: provisioner.stateMachine,
      deprovisioner: deprovisioner.stateMachine,
      alerts,
      releaseAgents: releaseHashes,
    });
    // Marketplace v1 (D19, D36): MCP packs are enabled by SDK from the release's signed zips.
    const packPlatform = new PackPlatform(this, "PackPlatform", {
      installation: cfg,
      platform: agentPlatform,
      accessLogs,
      release: packRelease,
      brokerRoleArn: tools.billingBrokerArn,
      memberBrokerRoleArn: memberAccess.readBrokerArn,
    });
    // R6: pack runtimes run in a VPC of their own with no way out but the VPC endpoints each
    // pack's signed manifest declares. Without packs in the release there is nothing to run.
    // A release keeps that network in its own stack, `Mango-<ns>-PackNetwork` (D58): AgentCore
    // holds network interfaces there for hours after a runtime is gone, and this stack must
    // not wait for them to be deleted.
    const ownPackNetwork =
      packRelease.packs.length > 0 && !release
        ? new PackNetwork(this, "PackNetwork", { installation: cfg, packs: packRelease.packs })
        : undefined;
    const packNetwork: PackNetworkRef | undefined =
      ownPackNetwork ??
      (packRelease.packs.length > 0 ? importPackNetwork(cfg.namespace, packRelease.packs) : undefined);
    const packProvisioner = new PackProvisioner(this, "PackProvisioner", {
      installation: cfg,
      platform: agentPlatform,
      packs: packPlatform,
      settingsTable: governance.settings,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      gateway: tools.gateway,
      policyEngine: tools.policyEngine,
      connectorTargets: tools.connectorTargets,
      brokerRoleArn: tools.billingBrokerArn,
      targetRoleArn: tools.billingReaderArn,
      brokeredActions: BILLING_READER_DATA_ACTIONS,
      memberBrokerRoleArn: memberAccess.readBrokerArn,
      memberRoleName: memberAccess.memberRoleName,
      memberActions: MEMBER_READ_ONLY_DATA_ACTIONS,
      packIdentityKey: tools.packIdentityKey,
      ...(packNetwork ? { network: packNetwork } : {}),
    });
    // D58: what the provisioners created by API goes away with the stack, before the
    // boundaries, the Gateway and the policy engine those resources hold on to.
    new UninstallGuard(this, "UninstallGuard", {
      installation: cfg,
      platform: agentPlatform,
      packs: packPlatform,
      gateway: tools.gateway,
      policyEngine: tools.policyEngine,
      connectorTargets: tools.connectorTargets,
      configKey: tools.configKey,
      alerts,
      before: [agentPlatform, packPlatform, tools, writeTools, alerts],
    });
    new Observability(this, "Observability", {
      installation: cfg,
      ...(release ? { when: release.ownsTransactionSearch } : {}),
    });

    // Harnesses the provisioner creates (D32), FinOps included. InvokeHarness can override
    // prompt and tools, so only this role has it (TM-M11); the provisioner cannot invoke.
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeAgentHarnesses",
        actions: ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          agentPlatform.harnessArns,
          `${agentPlatform.harnessArns}/harness-endpoint/*`,
          agentPlatform.runtimeArns,
          `${agentPlatform.runtimeArns}/*`,
        ],
      }),
    );
    provisioner.grantStart(apiTaskRole);
    deprovisioner.grantStart(apiTaskRole);
    deprovisioner.grantListExecutions(apiTaskRole);
    packProvisioner.grantStart(apiTaskRole);
    // The catalog of MCP lists the packs of the release from their signed statements.
    packPlatform.grantReadStatements(apiTaskRole);
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AuxiliaryModel",
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${cfg.models.auxiliary}`,
          `arn:aws:bedrock:*::foundation-model/${cfg.models.auxiliary.replace(/^(us|global)\./, "")}`,
        ],
      }),
    );
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PlatformAuthorization",
        actions: ["verifiedpermissions:IsAuthorized"],
        resources: [governance.policyStore.attrArn],
      }),
    );
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ConversationDataRls",
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: [governance.dataAccessRole.roleArn],
      }),
    );
    governance.budgets.grantReadWriteData(apiTaskRole);
    governance.auditStream.grantPutRecords(apiTaskRole);
    governance.auditIndex.grantReadWriteData(apiTaskRole);
    // Admin v0 (D17): only mango-api writes settings; only it may invoke the AdminProbe.
    governance.settings.grantReadWriteData(apiTaskRole);
    // What is installed for a pack is written by the pack provisioner only: mango-api decides
    // enablements (dual approval), never what the provisioner believes it deployed.
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InstalledPacksAreProvisionerOnly",
        effect: iam.Effect.DENY,
        // Every write action the grant above gives: `BatchWriteItem` is its own IAM action,
        // not `PutItem`/`DeleteItem` (transactions are authorized as the single-item ones).
        actions: ["dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [governance.settings.tableArn],
        conditions: {
          "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": [`${PACK_INSTALLED_PARTITION}*`] },
        },
      }),
    );
    // Marketplace v1 (D18): agent definitions as data.
    governance.grantAgents(apiTaskRole);
    // D20: MFA reset (dual approval in mango-api) on this installation's user pool only.
    identity.grantMfaReset(apiTaskRole);
    // D26: approved changes of the group registry create or delete the Cognito group.
    identity.grantGroupManagement(apiTaskRole);
    // D33: emails of the people an agent is shared with, for agent creators and admins.
    identity.grantDirectoryLookup(apiTaskRole);
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeAdminProbe",
        actions: ["lambda:InvokeFunction"],
        resources: [tools.adminProbe.functionArn],
      }),
    );
    tools.invocationKey.grantRead(apiTaskRole);
    acknowledge(
      apiTaskRole,
      ...KMS_GRANT_ACTIONS,
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:bedrock:*::foundation-model/${cfg.models.auxiliary.replace(/^(us|global)\./, "")}]`,
        reason: "Cross-region inference profiles route to the model in several regions.",
      },
      ...[
        agentPlatform.harnessArns,
        `${agentPlatform.harnessArns}/harness-endpoint/*`,
        agentPlatform.runtimeArns,
        `${agentPlatform.runtimeArns}/*`,
      ].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          "Agent harnesses are created at runtime by the provisioner, one per agent (D32): the name prefix " +
          "Mango_<ns>_a_ is the scope. mango-api builds every invocation from the published version.",
      })),
    );

    // The release agent: the default of a chat that names no agent. Its definition is data
    // (Agents table); mango-api only needs to know which one it is.
    const releaseAgent = shipped[0]!;
    const target = props.release;
    const api = new ApiService(this, "Api", {
      installation: cfg,
      ...(target
        ? {
            image: {
              repositoryArn: `arn:${this.partition}:ecr:${this.region}:${target.providerAccount}:repository/${target.imageRepository}`,
              repositoryName: target.imageRepository,
              digest: target.imageDigest,
            },
          }
        : {}),
      network,
      taskRole: apiTaskRole,
      environment: {
        MANGO_NAMESPACE: cfg.namespace,
        COGNITO_ISSUER: identity.issuer,
        COGNITO_CLIENT_ID: identity.webClient.userPoolClientId,
        COGNITO_USER_POOL_ID: identity.userPool.userPoolId,
        GATEWAY_URL: tools.gatewayUrl,
        AGENT_ID: releaseAgent.id,
        AGENT_MODEL: cfg.models.agent,
        GUARDRAIL_ID: agentPlatform.guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: agentPlatform.guardrailVersion.attrVersion,
        AGENT_SESSION_IDLE_SECONDS: String(SESSION_IDLE_SECONDS),
        AGENT_SESSION_MAX_SECONDS: String(SESSION_MAX_SECONDS),
        AUXILIARY_MODEL: cfg.models.auxiliary,
        MODEL_PRICES: JSON.stringify(cfg.modelPrices),
        POLICY_STORE_ID: governance.policyStore.attrPolicyStoreId,
        CONVERSATIONS_TABLE: governance.conversations.tableName,
        CONVERSATIONS_TABLE_ARN: governance.conversations.tableArn,
        DATA_KEY_ARN: governance.dataKey.keyArn,
        AUDIT_INDEX_TABLE: governance.auditIndex.tableName,
        ALLOWED_HOSTS: network.alb.loadBalancerDnsName,
        INVOCATION_KEY_SECRET_ARN: tools.invocationKey.secretArn,
        BUDGETS_TABLE: governance.budgets.tableName,
        DATA_ACCESS_ROLE_ARN: governance.dataAccessRole.roleArn,
        AUDIT_STREAM: governance.auditStream.deliveryStreamName,
        USER_MONTHLY_BUDGET_USD: String(cfg.budgets.userMonthlyUsd),
        AGENT_MONTHLY_BUDGET_USD: String(cfg.budgets.agentMonthlyUsd),
        SETTINGS_TABLE: governance.settings.tableName,
        AGENTS_TABLE: governance.agents.tableName,
        PROVISIONER_STATE_MACHINE_ARN: provisioner.stateMachine.stateMachineArn,
        DEPROVISIONER_STATE_MACHINE_ARN: deprovisioner.stateMachine.stateMachineArn,
        PACK_PROVISIONER_STATE_MACHINE_ARN: packProvisioner.stateMachine.stateMachineArn,
        ...packPlatform.apiEnvironment,
        ...writeTools.apiEnvironment,
        ADMIN_PROBE_FUNCTION: tools.adminProbe.functionName,
      },
    });
    // New tasks only start once the release agents are in the table.
    api.node.addDependency(...releaseAgentSeeds.seeds);

    // `-c skipSpa=true` allows synthesizing before the SPA is built (CI checks only).
    if (!this.node.tryGetContext("skipSpa")) {
      const spa = {
        region: this.region,
        cognitoDomain: `https://${identity.domain.domainName}.auth.${this.region}.amazoncognito.com`,
        userPoolId: identity.userPool.userPoolId,
        clientId: identity.webClient.userPoolClientId,
        apiBasePath: "/api",
        auth: {
          installationType: cfg.installationType,
          mfa: cfg.mfa,
          sessionHours: SESSION_HOURS,
        },
      };
      edge.deploySpa(
        release
          ? { ...spa, deployTime: release.spa }
          : {
              ...spa,
              signUpDomains: cfg.auth.signUpDomains,
              ...(cfg.auth.aiPolicyUrl ? { aiPolicyUrl: cfg.auth.aiPolicyUrl } : {}),
            },
      );
    }

    // CDK-managed singleton providers (custom resources, bucket deployment, auto-delete).
    for (const child of this.node.children) {
      if (/^(AWS[0-9a-f]{32}|Custom::)/.test(child.node.id)) {
        acknowledge(
          child,
          { id: "AwsSolutions-L1", reason: "CDK-managed provider; runtime is chosen by aws-cdk-lib." },
          {
            id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
            reason: "CDK-managed provider uses AWSLambdaBasicExecutionRole for its own logs.",
          },
          ...[
            "Action::s3:Abort*",
            "Action::s3:DeleteObject*",
            "Action::s3:GetBucket*",
            "Action::s3:GetObject*",
            "Action::s3:List*",
            "Resource::*",
            `Resource::arn:aws:s3:::${target ? `${target.bucket}-${this.region}` : `cdk-hnb659fds-assets-${this.account}-${this.region}`}/*`,
            `Resource::<${this.resolve(this.getLogicalId(edge.spaBucket.node.defaultChild as CfnResource))}.Arn>/*`,
            `Resource::<${this.resolve(this.getLogicalId(packPlatform.bucket.node.defaultChild as CfnResource))}.Arn>/*`,
          ].map((finding) => ({
            id: `AwsSolutions-IAM5[${finding}]`,
            reason: "CDK-managed provider policy generated by aws-cdk-lib (asset copy to the SPA and packs buckets).",
          })),
        );
      }
    }

    Aspects.of(this).add(new ShortKeyDeletionWindow());
    Aspects.of(this).add(new GuardSuppressions());
    Aspects.of(this).add(new CheckovSuppressions());

    new CfnOutput(this, "AppUrl", { value: edge.origin });
    new CfnOutput(this, "UserPoolId", { value: identity.userPool.userPoolId });
    new CfnOutput(this, "WebClientId", { value: identity.webClient.userPoolClientId });
    new CfnOutput(this, "GatewayUrl", { value: tools.gatewayUrl });
    new CfnOutput(this, "AgentProvisionerArn", { value: provisioner.stateMachine.stateMachineArn });
    new CfnOutput(this, "AgentDeprovisionerArn", { value: deprovisioner.stateMachine.stateMachineArn });
    new CfnOutput(this, "PackProvisionerArn", { value: packProvisioner.stateMachine.stateMachineArn });
    new CfnOutput(this, "PacksBucket", { value: packPlatform.bucket.bucketName });
    if (ownPackNetwork) {
      // The construct is `PackNetwork`; the output keeps that name for the operator.
      new CfnOutput(this, "PackNetworkOutput", { value: ownPackNetwork.provisionerSetting }).overrideLogicalId(
        "PackNetwork",
      );
    }
  }
}
