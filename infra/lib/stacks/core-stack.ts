import {
  Aspects,
  CfnOutput,
  CfnResource,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { coreParameters, loadReleaseDefaults } from "../config/release.js";
import { Installation } from "../config/schema.js";
import { AgentPlatform, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from "../constructs/agent-platform.js";
import { Alerts } from "../constructs/alerts.js";
import { ApiService } from "../constructs/api-service.js";
import { AccountHealth } from "../constructs/account-health.js";
import { BudgetReconciler } from "../constructs/budget-reconciler.js";
import { CostAnomalyEvents } from "../constructs/cost-anomaly-events.js";
import { CUR_RECONCILER_ALARMS } from "../constructs/cur-reconciler.js";
import { CurExportBucket } from "../constructs/cur-export.js";
import { Deprovisioner } from "../constructs/deprovisioner.js";
import { Edge } from "../constructs/edge.js";
import { UI_SANDBOX_ALARMS, UiSandboxOrigin } from "../constructs/ui-sandbox-origin.js";
import { EVAL_JUDGE_ALARMS, EVALUATION_FEE_USD } from "../constructs/eval-judge.js";
import { CHAT_FILES_ALARMS } from "../constructs/chat-files-scan.js";
import { DenyEvalsContent, Evals, EvalsCapture, judgeModels } from "../constructs/evals.js";
import { Governance, GROUPS_PARTITION } from "../constructs/governance.js";
import { Identity, SESSION_HOURS } from "../constructs/identity.js";
import { INDEXING_PROFILE, Knowledge, KNOWLEDGE_PREFIXES } from "../constructs/knowledge.js";
import { Skills } from "../constructs/skills.js";
import { Tickets } from "../constructs/tickets.js";
import { ChatFiles, CHAT_FILES_PREFIXES } from "../constructs/chat-files.js";
import { codeConnectorRoleArn } from "../constructs/code-connector.js";
import { codeInterpreterPrices, SandboxVpc } from "../constructs/code-sandbox.js";
import { Presign } from "../constructs/presign.js";
import { RENDER_DOCUMENT_ALARMS } from "../constructs/render-document.js";
import { MemberAccess } from "../constructs/member-access.js";
import { Network } from "../constructs/network.js";
import { Observability } from "../constructs/observability.js";
import { importPackNetwork, PackNetwork, PackNetworkRef, packNetworkExports } from "../constructs/pack-network.js";
import { StackTagger } from "../constructs/stack-tagger.js";
import {
  accountDataPacks,
  loadPackRelease,
  memberChainPacks,
  PackPlatform,
  packReadTools,
  payerChainPacks,
} from "../constructs/pack-platform.js";
import { PACK_INSTALLED_PARTITION, PackProvisioner } from "../constructs/pack-provisioner.js";
import { PLAYGROUND_PARTITION, PlaygroundHarness } from "../constructs/playground.js";
import { RemoteMcpProvisioner } from "../constructs/remote-provisioner.js";
import { Provisioner } from "../constructs/provisioner.js";
import { Reconciler } from "../constructs/reconciler.js";
import { APPROVED_REMOTE_PARTITION, remoteProvisionerName } from "../constructs/remote-mcp-api.js";
import { RemoteRelease } from "../constructs/remote-release.js";
import { ReleaseAgents, releaseAgents, releaseVersion } from "../constructs/release-agents.js";
import { TaskReports } from "../constructs/task-reports.js";
import { TaskPlatform } from "../constructs/tasks.js";
import {
  ChatTurnQueue,
  CHAT_TURNS_QUEUE_ENV,
  turnWorkerRoleArn,
  turnWorkerServiceName,
} from "../constructs/turn-worker.js";
import { Tools } from "../constructs/tools.js";
import { UninstallGuard } from "../constructs/uninstall-guard.js";
import { WriteTools } from "../constructs/write-tools.js";
import { acknowledge, KMS_GRANT_ACTIONS, REASONS } from "../nag.js";
import { CheckovSuppressions } from "../checkov.js";
import { GUARD_EXCEPTIONS, GuardSuppressions, suppressGuard } from "../guard.js";
import { LogsKey, ShortKeyDeletionWindow } from "../logs.js";
import { mangoName, roleNames } from "../names.js";
import { tagNamespace } from "../params.js";
import { ReleaseTarget } from "../release-target.js";
import { MEMBER_READ_ONLY_DATA_ACTIONS } from "./member-stack.js";
import { BILLING_READER_DATA_ACTIONS } from "./payer-stack.js";
import {
  AuthorizationStack,
  CurReconciliationStack,
  EvalsStack,
  ObservabilityStack,
  OperationsStack,
  RemoteMcpStack,
  RenderDocumentStack,
  SandboxStack,
  TurnWorkerStack,
  UiSandboxStack,
} from "./core-nested.js";

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
    // D123: the second origin, for code Mango did not write (Canvas previews, MCP Apps). Its
    // distribution is in Core because the SPA's CSP names it; the SPA frames only that origin.
    const uiSandbox = new UiSandboxOrigin(this, "UiSandboxOrigin", {
      installation: cfg,
      accessLogs,
      webAclArn: edge.webAclArn,
    });
    edge.allowFrameFrom(uiSandbox.origin);
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
      // D121: the turn worker takes a person's rows the same way, and so does the code
      // connector, for the sessions and cells of the sandbox (D114 (4)).
      turnWorkerRoleArn: turnWorkerRoleArn(this, cfg.namespace),
      codeConnectorRoleArn: codeConnectorRoleArn(this, cfg.namespace),
      ...(release ? { auditLockMode: release.auditLockMode } : {}),
    });
    // D99: the Cedar policies of the store, in a stack nested in Core.
    new AuthorizationStack(this, "Authorization", { policyStoreId: governance.policyStore.attrPolicyStoreId });
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
      packReadTools: packReadTools(packRelease),
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
    // Tasks without chat (D78): runs of a published agent, on demand and on a schedule, as the
    // person who created them. Their token comes from a client of their own (CUSTOM_AUTH only).
    const tasks = new TaskPlatform(this, "Tasks", {
      installation: cfg,
      userPool: identity.userPool,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
    });
    tools.allowTasksClient(tasks.client.userPoolClientId);
    tasks.grantApi(apiTaskRole, identity.userPool);
    // Broker to the member accounts (§4.10); the spoke roles come from the OrgAccess StackSet.
    const memberAccess = new MemberAccess(this, "MemberAccess", {
      installation: cfg,
      adminProbe: tools.adminProbe,
      memberChainPacks: memberChainPacks(packRelease),
    });
    const agentPlatform = new AgentPlatform(this, "AgentPlatform", { installation: cfg });
    // D92: skills of instructions, versioned and approved; their SKILL.md is read by the
    // harness of each agent with that agent's role.
    const skills = new Skills(this, "Skills", {
      installation: cfg,
      dataKey: governance.dataKey,
      accessLogs,
    });
    skills.allowAgents(agentPlatform.boundary);
    skills.grantApi(apiTaskRole);
    // D122: «Memoria» of each person and the purge, only while memory is on.
    agentPlatform.memory.grantApi(apiTaskRole);
    // D110, D111: the suites, cases and runs of the evals (data: here, not nested, D99 (2)).
    const evals = new Evals(this, "Evals", { installation: cfg, dataKey: governance.dataKey });
    evals.grantApi(apiTaskRole);
    // D110 (3): the key of the evals harness's log groups, the only ones with content.
    const evalsCapture = new EvalsCapture(this, "EvalsCapture", { installation: cfg, retainData: cfg.retainData });
    evalsCapture.allowAgents(agentPlatform.boundary);
    // D110 (8): no role of Mango but the evaluator reads the evals content; IAM decides it.
    evalsCapture.denyInBoundary(agentPlatform.boundary);
    evalsCapture.grantApi(apiTaskRole);
    // D112: tickets of Mango, written by mango-api (and, for agents, by the tickets tool).
    const tickets = new Tickets(this, "Tickets", { installation: cfg, dataKey: governance.dataKey });
    tickets.grantApi(apiTaskRole);
    // D112 (9): the tickets tool runs in the approval executor (target `ops`).
    tickets.grantToolExecutor(writeTools.executor);
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
      skills: { bucketName: skills.bucket.bucketName, keyArn: skills.key.keyArn },
      evals: evalsCapture,
    });
    // D119 (5): the provisioner writes the document skills of the release, before naming them.
    skills.allowReleaseSkillWrites(provisioner.role);
    const releaseAgentSeeds = new ReleaseAgents(this, "ReleaseAgents", {
      agents: shipped,
      agentsTable: governance.agents,
      dataKey: governance.dataKey,
      stateMachine: provisioner.stateMachine,
      provisioner: provisioner.function,
    });
    // D91: the Playground's shared test harness, kept by the same provisioner.
    new PlaygroundHarness(this, "PlaygroundHarness", {
      stateMachine: provisioner.stateMachine,
      provisioner: provisioner.function,
      release: props.release?.label ?? "v0.0.0-unpublished",
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
    new UiSandboxStack(this, "UiSandbox", {
      installation: cfg,
      keyValueStoreArn: uiSandbox.keyValueStore.keyValueStoreArn,
      spaOrigin: edge.origin,
      distributionId: uiSandbox.distribution.distributionId,
      accessLogDestinationArn: edge.accessLogDestinationArn,
      alertsTopic: alerts.topic,
      // The runner and the mirror (D123 (3), (4)), built like the SPA: not when the web is skipped.
      ...(this.node.tryGetContext("skipSpa")
        ? {}
        : {
            content: {
              bucket: uiSandbox.bucket,
              assetsBucket: props.release
                ? `${props.release.bucket}-${this.region}`
                : `cdk-hnb659fds-assets-${this.account}-${this.region}`,
              distributionDomainName: uiSandbox.distribution.distributionDomainName,
              spaOrigin: edge.origin,
            },
          }),
    });
    // D78: a task run whose message failed every receipt never ran.
    tasks.alarmOnFailedRuns(alerts);
    // D86: the PDF of a task run, drawn by a function of the release and downloaded only by
    // the owner of the task with a link of 5 minutes.
    const taskReports = new TaskReports(this, "TaskReports", {
      installation: cfg,
      tasksTable: tasks.table,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      accessLogs,
      alerts,
    });
    taskReports.grantApi(apiTaskRole);
    // D88: the fixed resources of the knowledge bases (one Bedrock base over S3 Vectors, the
    // documents bucket, the registry and the boundary of the roles of existing buckets). A
    // knowledge base of Mango is a record and a prefix, never a resource of this stack.
    const knowledge = new Knowledge(this, "Knowledge", {
      installation: cfg,
      dataKey: governance.dataKey,
      accessLogs,
      alerts,
      appOrigin: edge.origin,
      budgetsTable: governance.budgets,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      configKey: tools.configKey,
      embeddingPrice: embeddingPrice(cfg),
      rateLimitsTable: governance.rateLimits,
      issuer: identity.issuer,
      webClientId: identity.webClient.userPoolClientId,
      tasksClientId: tasks.client.userPoolClientId,
      settingsTable: governance.settings,
    });
    knowledge.grantApi(apiTaskRole);
    // The knowledge search of the agents (D88 (14)): a Mango connector behind the Gateway.
    tools.addKnowledgeTarget(knowledge.retrieveFunction);
    // The browser posts documents to that bucket only (D88 (9)).
    edge.allowConnectTo(knowledge.uploadOrigin);
    // D116: the files of the chat (uploads and what the code sandbox generates), read only once
    // their malware scan cleared them. The bucket and its key hold data and stay in Core.
    const chatFiles = new ChatFiles(this, "ChatFiles", { installation: cfg, accessLogs, appOrigin: edge.origin });
    // The browser posts the chat's attachments to that bucket only (D116 (4)).
    edge.allowConnectTo(chatFiles.uploadOrigin);
    // D114: the network of the code sandbox. Its VPC is here because the stack tagger tags its
    // defaults; the subnets, the Code Interpreter and the scan plan are in a nested stack (D99).
    const sandboxVpc = new SandboxVpc(this, "SandboxVpc", { installation: cfg, accessLogs });
    // Its connector (D114 (1)) is a Mango connector behind the Gateway, in the same nested stack:
    // Core trusts its role by name and reads nothing of it (D99 (4)).
    new SandboxStack(this, "Sandbox", {
      installation: cfg,
      vpcId: sandboxVpc.vpc.vpcId,
      chatFiles: { bucket: chatFiles.bucket, key: chatFiles.key },
      // D116 (2): what each scan said, for mango-api, and mango-api's policy on the bucket.
      scanResults: {
        conversations: governance.conversations,
        dataKey: governance.dataKey,
        configKey: tools.configKey,
        alerts,
      },
      apiTaskRole,
      // D118 (7): mango-api asks the base guardrail about the texts of a chart or a table.
      guardrailArn: agentPlatform.guardrail.attrGuardrailArn,
      connector: {
        conversations: governance.conversations,
        dataKey: governance.dataKey,
        dataAccessRoleArn: governance.dataAccessRole.roleArn,
        chatFiles: { bucket: chatFiles.bucket, key: chatFiles.key },
        rateLimits: governance.rateLimits,
        auditIndex: governance.auditIndex,
        auditStream: governance.auditStream,
        configKey: tools.configKey,
        issuer: identity.issuer,
        webClientId: identity.webClient.userPoolClientId,
        tasksClientId: tasks.client.userPoolClientId,
        gateway: {
          id: tools.gateway.attrGatewayIdentifier,
          arn: tools.gateway.attrGatewayArn,
          roleArn: tools.gatewayRole.roleArn,
        },
        policyEngineId: tools.policyEngine.attrPolicyEngineId,
        // D119: `render_document` invokes the render function, which exists only in a release.
        renderDocument: props.release !== undefined,
      },
    });
    // D117: Word, Excel and PowerPoint to PDF and PNG pages, from the image of the release in the
    // repository of mango-api, by digest. Only in a release: there is no image to name without one.
    if (props.release) {
      new RenderDocumentStack(this, "RenderDocument", {
        installation: cfg,
        chatFiles: { bucket: chatFiles.bucket, key: chatFiles.key },
        image: {
          repositoryArn: `arn:${this.partition}:ecr:${this.region}:${props.release.providerAccount}:repository/${props.release.imageRepository}`,
          repositoryName: props.release.imageRepository,
          digest: props.release.renderDocumentDigest,
        },
        configKey: tools.configKey,
        alertsTopic: alerts.topic,
      });
    }
    // Every URL a browser uses is signed by a role of its own, never with the task's
    // credentials: GuardDuty reports those used outside AWS (2026-10-21).
    const presign = new Presign(this, "Presign", {
      namespace: cfg.namespace,
      apiTaskRole,
      documents: { bucket: knowledge.bucket, key: knowledge.key, prefix: KNOWLEDGE_PREFIXES.uploads },
      reports: { bucket: taskReports.bucket, key: taskReports.key, prefix: "owner/" },
      chatFiles: {
        bucket: chatFiles.bucket,
        key: chatFiles.key,
        uploads: CHAT_FILES_PREFIXES.uploads,
        owner: CHAT_FILES_PREFIXES.owner,
      },
    });
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
    // D84: every day, whether Mango can still enter each member account, as `mango-health`.
    // Its own function and role: the reconciler stays read-only in this account (D41) and the
    // AdminProbe only acts for an administrator (D17).
    new AccountHealth(this, "AccountHealth", {
      installation: cfg,
      settingsTable: governance.settings,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      billingBrokerArn: tools.billingBrokerArn,
      billingReaderArn: tools.billingReaderArn,
      readBrokerArn: memberAccess.readBrokerArn,
      memberRoleName: memberAccess.memberRoleName,
      alerts,
      apiTaskRole,
    });
    // A chat turn whose end mango-api never knew keeps its budget reservation held; this
    // function closes it from the AgentCore traces (D73). The daily reconciler above stays
    // read-only (D41).
    new BudgetReconciler(this, "BudgetReconciler", {
      installation: cfg,
      budgetsTable: governance.budgets,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      alerts,
    });
    // D104: the payer's Data Export CUR 2.0, cut down to Bedrock of this account, lands in a
    // bucket of Core (it holds data, D99 (2)); a function in a nested stack compares it once a
    // day with the day counters of each agent and of the organization. It only reads.
    const curExport = new CurExportBucket(this, "CurExport", { installation: cfg, accessLogs });
    new CurReconciliationStack(this, "CurReconciliation", {
      installation: cfg,
      catalogGovernedByLakeFormation: release
        ? release.catalogGovernedByLakeFormation
        : String(cfg.catalogGovernedByLakeFormation ?? false),
      bucket: curExport.bucket,
      budgetsTable: governance.budgets,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      alerts,
    });
    // D108: the Observability view reads the metadata of the AgentCore spans through a function
    // in a nested stack, which only mango-api may invoke.
    const observability = new ObservabilityStack(this, "Traces", {
      installation: cfg,
      configKey: tools.configKey,
      apiTaskRole,
    });
    // D110: the evaluator of the evals and the evals harness, in a stack nested in Core (D99).
    const evalJudge = new EvalsStack(this, "EvalJudge", {
      installation: cfg,
      settingsTable: governance.settings,
      budgetsTable: governance.budgets,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      logsKeyArn: evalsCapture.key.keyArn,
      guardrailId: agentPlatform.guardrail.attrGuardrailId,
      guardrailVersion: agentPlatform.guardrailVersion.attrVersion,
      alerts,
    });
    // Every release asks the provisioner for the evals harness, once its evaluator exists: the
    // canary of a new harness version is asked of it (D110 (8)).
    const evalsHarness = new PlaygroundHarness(this, "EvalsHarness", {
      stateMachine: provisioner.stateMachine,
      provisioner: provisioner.function,
      release: props.release?.label ?? "v0.0.0-unpublished",
      kind: "evals",
    });
    evalsHarness.start.node.addDependency(evalJudge);
    // Cost anomalies of the organization, forwarded by the payer account, start the runs of the
    // automations subscribed to them (D79).
    const costAnomalies = new CostAnomalyEvents(this, "CostAnomalyEvents", {
      installation: cfg,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      alerts,
      runQueue: tasks.runQueue,
    });
    tasks.grantEnqueueEvents(costAnomalies.function);
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
    // D58: what the provisioners created by API goes away with the stack, before anything
    // else of it: the guard depends on every other resource (D58 (16)).
    const uninstallGuard = new UninstallGuard(this, "UninstallGuard", {
      installation: cfg,
      platform: agentPlatform,
      packs: packPlatform,
      gateway: tools.gateway,
      policyEngine: tools.policyEngine,
      connectorTargets: tools.connectorTargets,
      configKey: tools.configKey,
      alerts,
      sourceRoles: { boundary: knowledge.sourceBoundary, roleArns: knowledge.sourceRoleArns },
    });
    new Observability(this, "Observability", {
      installation: cfg,
      ...(release ? { when: release.ownsTransactionSearch } : {}),
    });
    // D77: what CloudFormation cannot tag gets the stack's tags, on install and every version.
    // A release keeps the pack network in its own stack, which exports its VPC.
    const packVpcId = ownPackNetwork
      ? ownPackNetwork.vpc.vpcId
      : release
        ? Fn.importValue(packNetworkExports.vpc(cfg.namespace))
        : undefined;
    new StackTagger(this, "StackTagger", {
      installation: cfg,
      vpcIds: [network.vpc.vpcId, sandboxVpc.vpc.vpcId, ...(packVpcId ? [packVpcId] : [])],
      release: props.release?.label ?? "v0.0.0-unpublished",
      configKey: tools.configKey,
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
    // D93, D98: remote MCP servers of third parties. mango-api lists the signed profiles of the
    // release, creates the Identity provider of each request and starts the remote provisioner,
    // with a managed policy of its own (`Mango-<ns>-ApiRemoteMcp`).
    const remoteRelease = new RemoteRelease(this, "RemoteRelease", {
      bucket: packPlatform.bucket,
      signingPublicKey: packRelease.signingPublicKey,
    });
    // What the remote MCP build adds lives in its own stack nested in Core (D99).
    const remoteMcp = new RemoteMcpStack(this, "RemoteMcp", {
      installation: cfg,
      apiTaskRole,
      settingsTable: governance.settings,
      release: remoteRelease,
    });
    // Its provisioner makes the `remote-<reg>` targets and is the only one that signs the
    // approved catalog (TM-012); mango-api starts it by name, from `Mango-<ns>-ApiRemoteMcp`.
    new RemoteMcpProvisioner(remoteMcp, "RemoteMcpProvisioner", {
      installation: remoteMcp.installation,
      settingsTable: governance.settings,
      auditIndex: governance.auditIndex,
      auditStream: governance.auditStream,
      dataKey: governance.dataKey,
      configKey: tools.configKey,
      gateway: tools.gateway,
      policyEngine: tools.policyEngine,
      connectorTargets: tools.connectorTargets,
      remotes: remoteRelease,
      signingPublicKey: packRelease.signingPublicKey,
      appOrigin: edge.origin,
      signingKey: tools.remoteMcpKey,
      enabled: release ? release.remoteMcpEnabled : String(cfg.remoteMcp.enabled),
    });
    // The REQUEST interceptor that reads the catalog's new format goes first (D101): the sweep
    // after the install signs only what it can verify.
    remoteMcp.node.addDependency(tools.interceptor);
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
    // enablements (dual approval), never what the provisioner believes it deployed. The same
    // for the harness the Playground invokes (D91): the agent provisioner's to say.
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InstalledPacksAreProvisionerOnly",
        effect: iam.Effect.DENY,
        // Every write action the grant above gives: `BatchWriteItem` is its own IAM action,
        // not `PutItem`/`DeleteItem` (transactions are authorized as the single-item ones).
        actions: ["dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [governance.settings.tableArn],
        conditions: {
          "ForAnyValue:StringLike": {
            "dynamodb:LeadingKeys": [
              `${PACK_INSTALLED_PARTITION}*`,
              PLAYGROUND_PARTITION,
              // D110 (8): the evals harness and its capture: the provisioner's and the canary's.
              "EVALS",
              // D98 (13): the signed approved catalogs of remote MCP servers.
              `${APPROVED_REMOTE_PARTITION}*`,
            ],
          },
        },
      }),
    );

    // Marketplace v1 (D18): agent definitions as data.
    governance.grantAgents(apiTaskRole);
    governance.grantWebSessions(apiTaskRole);
    // D70: the rate limits the tasks of mango-api share.
    governance.grantRateLimits(apiTaskRole);
    // D72: web sessions are created and renewed with the signed operation of this pool only.
    identity.grantSessionRenewal(apiTaskRole);
    // D20: MFA reset (dual approval in mango-api) on this installation's user pool only.
    identity.grantMfaReset(apiTaskRole);
    // D26: approved changes of the group registry create or delete the Cognito group.
    identity.grantGroupManagement(apiTaskRole);
    // D33: emails of the people an agent is shared with, for agent creators and admins.
    identity.grantDirectoryLookup(apiTaskRole);
    // D60: Settings > People (the directory, group membership, invitations) for administrators.
    identity.grantPeopleManagement(apiTaskRole);
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

    // D121: the queue every chat turn starts from (TM-TW1). It holds data: it stays in Core (D99).
    const chatTurns = new ChatTurnQueue(this, "ChatTurns", { installation: cfg, apiTaskRole });

    // The release agent: the default of a chat that names no agent. Its definition is data
    // (Agents table); mango-api only needs to know which one it is.
    const releaseAgent = shipped[0]!;
    const target = props.release;
    const apiEnvironment: Record<string, string> = {
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
      // What a turn of a version that runs code reserves and is charged (D115 (2), rule 7).
      CODE_INTERPRETER_PRICES: JSON.stringify(codeInterpreterPrices(cfg)),
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
      ...tasks.apiEnvironment,
      ...taskReports.apiEnvironment,
      ...knowledge.apiEnvironment,
      // D116: attachments and generated files of the chat.
      CHAT_FILES_BUCKET: chatFiles.bucket.bucketName,
      ...skills.apiEnvironment,
      ...evals.apiEnvironment,
      // D110: the evaluator mango-api asks for the verdict of a judge case, and its judges.
      EVAL_JUDGE_FUNCTION: evalsCapture.judgeFunctionName,
      EVAL_JUDGE_MODELS: judgeModels(cfg).join(","),
      EVALUATION_FEE_USD: EVALUATION_FEE_USD,
      ...tickets.apiEnvironment,
      ...presign.apiEnvironment,
      ...observability.reader.apiEnvironment,
      // D98: the remote MCP catalog, its provisioner and key, and whether it is on (D98 (4)).
      ...remoteMcp.api.environment,
      REMOTE_MCP_ENABLED: release ? release.remoteMcpEnabled : String(cfg.remoteMcp.enabled),
      ADMIN_PROBE_FUNCTION: tools.adminProbe.functionName,
      // D60: who may be invited, and what Settings > General > Installation shows to
      // administrators (served by mango-api, not by the public config.json of the SPA).
      SIGN_UP_DOMAINS: cfg.auth.signUpDomains.join(","),
      // D63: the web session cookie. The only `Origin` its endpoints accept, where the
      // session records live and how long a session may last (the refresh token validity).
      APP_ORIGIN: edge.origin,
      WEB_SESSIONS_TABLE: governance.webSessions.tableName,
      SESSION_HOURS: String(SESSION_HOURS),
      // D70: mango-api does not start without it.
      RATE_LIMITS_TABLE: governance.rateLimits.tableName,
      MANGO_VERSION: releaseVersion(),
      // The label tells two builds of one version apart (`v0.1.0-g1a2b3c4`).
      ...(target ? { MANGO_RELEASE: target.label } : {}),
      ORGANIZATION_ID: cfg.organizationId,
      MANAGEMENT_ACCOUNT_ID: cfg.managementAccountId,
      ALERTS_EMAIL: cfg.alerts.emails.join(","),
      FIRST_ADMIN_EMAILS: [
        ...cfg.users.filter((u) => !u.e2e && u.groups.includes("mango-admin")).map((u) => u.email),
        ...(release ? [release.secondAdminEmail] : []),
      ].join(","),
      // D121: where mango-api sends the chat turns.
      [CHAT_TURNS_QUEUE_ENV]: chatTurns.queue.queueUrl,
      // D122: the agents' memory, off until M0.
      ...agentPlatform.memory.environment,
    };
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
      environment: apiEnvironment,
    });
    // New tasks only start once the release agents are in the table.
    api.node.addDependency(...releaseAgentSeeds.seeds);
    // D121 (3): the turn worker, with the image and in the cluster of mango-api, in a stack
    // nested in Core with the permissions of the turn only (D99).
    const turnWorker = new TurnWorkerStack(this, "TurnWorker", {
      installation: cfg,
      network,
      cluster: api.cluster,
      image: api.image,
      queue: chatTurns,
      apiEnvironment,
      turn: {
        auxiliaryModel: cfg.models.auxiliary,
        guardrailArn: agentPlatform.guardrail.attrGuardrailArn,
        policyStoreArn: governance.policyStore.attrArn,
        dataAccessRole: governance.dataAccessRole,
        dataKey: governance.dataKey,
        budgets: governance.budgets,
        auditIndex: governance.auditIndex,
        auditStream: governance.auditStream,
        settings: governance.settings,
        agents: governance.agents,
        approvals: writeTools.approvals,
        tickets: tickets.table,
        rateLimits: governance.rateLimits,
        skills: skills.table,
        invocationKey: tools.invocationKey,
        configKey: tools.configKey,
        grantCatalog: (grantee) => {
          packPlatform.grantReadStatements(grantee);
          remoteRelease.grantRead(grantee);
        },
        // D122 (8): the worker, never the harness, reads and writes the memory.
        grantMemory: (role) => agentPlatform.memory.grantWorker(role),
      },
      // D121 (5): the turns of task runs too.
      taskRuns: { tasks: tasks.table, tickets: tickets.table, reportFunction: taskReports.function },
    });
    turnWorker.node.addDependency(...releaseAgentSeeds.seeds);

    // D71: what would otherwise fail in silence. Last, so that it sees every table of the stack.
    // In a stack nested in Core, with names of their own (D99).
    new OperationsStack(this, "Operations", {
      installation: cfg,
      alerts,
      alb: network.alb,
      service: api.service,
      apiLogGroup: api.logGroup,
      distribution: edge.distribution,
      edgeRateLimits: edge.rateLimitMetrics,
      userPoolRateLimits: identity.rateLimitMetrics,
      criticalFunctions: {
        PreTokenGeneration: identity.preToken,
        GatewayInterceptor: tools.interceptor,
        // D98 (16): every answer of the Gateway goes through it.
        GatewayResponseInterceptor: tools.responseInterceptor,
      },
      refusingFunctions: { PreSignUp: identity.preSignUp },
      deadLetterQueues: { UninstallGuard: uninstallGuard.deadLetters },
      // D121: the turn worker, its queue and the turns that were cut.
      turnWorker: {
        clusterName: api.cluster.clusterName,
        serviceName: turnWorkerServiceName(cfg.namespace),
        queue: chatTurns.queue,
        deadLetters: chatTurns.deadLetters,
      },
      // Alarms of the other nested stacks, by name: each nested stack is a leaf (D99 (4)).
      nestedAlarms: [
        ...Object.values(CUR_RECONCILER_ALARMS),
        ...Object.values(EVAL_JUDGE_ALARMS),
        ...Object.values(UI_SANDBOX_ALARMS),
        ...(props.release ? Object.values(RENDER_DOCUMENT_ALARMS) : []),
        ...Object.values(CHAT_FILES_ALARMS),
      ],
    });
    // «Probar búsqueda» throttled by Bedrock counts in the alarm of the tool (D88 (12)).
    knowledge.countApiThrottles(api.logGroup);

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
    // D110 (8): every role of Core and of its nested stacks, but the evaluator's.
    Aspects.of(this).add(new DenyEvalsContent(evalsCapture, evalJudge.judge.role));
    evalsCapture.denyInBoundary(knowledge.sourceBoundary);
    evalsCapture.denyInBoundary(packPlatform.boundary);
    Aspects.of(this).add(new GuardSuppressions());
    Aspects.of(this).add(new CheckovSuppressions());

    new CfnOutput(this, "AppUrl", { value: edge.origin });
    new CfnOutput(this, "UserPoolId", { value: identity.userPool.userPoolId });
    new CfnOutput(this, "WebClientId", { value: identity.webClient.userPoolClientId });
    new CfnOutput(this, "GatewayUrl", { value: tools.gatewayUrl });
    new CfnOutput(this, "AgentProvisionerArn", { value: provisioner.stateMachine.stateMachineArn });
    new CfnOutput(this, "AgentDeprovisionerArn", { value: deprovisioner.stateMachine.stateMachineArn });
    new CfnOutput(this, "PackProvisionerArn", { value: packProvisioner.stateMachine.stateMachineArn });
    // Named, not read from the nested stack: Core reads none of its outputs (D99).
    new CfnOutput(this, "RemoteMcpProvisionerArn", {
      value: `arn:${this.partition}:states:${this.region}:${this.account}:stateMachine:${remoteProvisionerName(cfg.namespace)}`,
    });
    new CfnOutput(this, "PacksBucket", { value: packPlatform.bucket.bucketName });
    // Where the payer's Data Export CUR 2.0 delivers (runbook, D104 (4)).
    new CfnOutput(this, "CurExportBucket", { value: curExport.bucket.bucketName });
    if (ownPackNetwork) {
      // The construct is `PackNetwork`; the output keeps that name for the operator.
      new CfnOutput(this, "PackNetworkOutput", { value: ownPackNetwork.provisionerSetting }).overrideLogicalId(
        "PackNetwork",
      );
    }
  }
}

/** The price of the embedding model of the indexing profile (rule 7): of the installation, or of
 * the release. A profile without its price would let synchronizations cost nothing. */
function embeddingPrice(cfg: Installation): number {
  const prices = cfg.embeddingPrices ?? loadReleaseDefaults().embeddingPrices;
  const price = prices[INDEXING_PROFILE.embeddingModel];
  if (price === undefined) throw new Error(`no price for ${INDEXING_PROFILE.embeddingModel}`);
  return price;
}
