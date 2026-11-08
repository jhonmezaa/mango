import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { acknowledge, KMS_GRANT_ACTIONS } from "../nag.js";
import { agentNames, mangoName } from "../names.js";
import { AGENTS_BY_CREATOR, AGENTS_BY_STATUS } from "./governance.js";
import { Network } from "./network.js";
import { APPROVALS_BY_REQUESTER } from "./write-tools.js";
import { remoteMcpKeyAlias } from "./remote-mcp-api.js";

/**
 * Tasks of `mango-turn-worker` (D121 (3)). Zero until its entry point is in the image: R1 of the
 * plan builds the service before R2 adds `mango_api.turn_worker`, and a task that cannot start
 * makes the circuit breaker fail the deployment and CloudFormation roll the whole stack back.
 * R2 sets it to 2 in the change that adds the module (decided 2026-11-07, by menu). Not a stack
 * parameter: an update keeps the previous value of a parameter, and an installation would be
 * left enqueueing turns nobody reads.
 */
export const TURN_WORKER_TASKS = 2;
/** What the worker runs: the image of mango-api with another entry point (D121 (3)). */
export const TURN_WORKER_COMMAND = ["python", "-m", "mango_api.turn_worker"];
/**
 * What a stopped task still gets after SIGTERM before SIGKILL (the most Fargate allows). The
 * task protection is what keeps a running turn alive through a deployment (D121 (9)).
 */
export const TURN_WORKER_STOP_SECONDS = 120;
/**
 * How long a message of a turn stays invisible once a worker takes it: the longest turn (600 s)
 * and a margin. The worker extends it while a turn goes on (D121 (9)).
 */
export const CHAT_TURN_VISIBILITY = Duration.seconds(960);
/**
 * Receipts before a message goes to the dead-letter queue: one. A turn is never retried on its
 * own; repeating it is never free (D121 (7)).
 */
export const CHAT_TURN_RECEIPTS = 1;
/**
 * How long a message is kept: longer than its visibility, so that the message of a worker that
 * fell does reach the dead-letter queue (decided 2026-11-07, by menu; TM-TW1).
 */
export const CHAT_TURN_RETENTION = Duration.minutes(20);
/**
 * The dead-letter queue keeps a message one hour after it was sent (a standard queue keeps its
 * first timestamp): by then the access token inside has expired (TM-TW1).
 */
export const CHAT_TURN_DEAD_LETTER_RETENTION = Duration.hours(1);

/**
 * The environment of mango-api the turn needs (D121 (3)), by name: `Settings.from_env` and the
 * services of the turn read them. The worker gets these and `MANGO_CHAT_TURNS_QUEUE_URL`,
 * nothing else of mango-api's (no web session, tasks, knowledge or administration values).
 */
export const TURN_WORKER_ENVIRONMENT = [
  // Required by `Settings.from_env`.
  "MANGO_NAMESPACE",
  "COGNITO_ISSUER",
  "COGNITO_CLIENT_ID",
  "COGNITO_USER_POOL_ID",
  "GATEWAY_URL",
  "AGENT_ID",
  "AGENT_MODEL",
  "AUXILIARY_MODEL",
  "MODEL_PRICES",
  "POLICY_STORE_ID",
  "CONVERSATIONS_TABLE",
  "CONVERSATIONS_TABLE_ARN",
  "DATA_KEY_ARN",
  "DATA_ACCESS_ROLE_ARN",
  "BUDGETS_TABLE",
  "AUDIT_STREAM",
  "AUDIT_INDEX_TABLE",
  "USER_MONTHLY_BUDGET_USD",
  "AGENT_MONTHLY_BUDGET_USD",
  "INVOCATION_KEY_SECRET_ARN",
  "SETTINGS_TABLE",
  "AGENTS_TABLE",
  "ADMIN_PROBE_FUNCTION",
  "GUARDRAIL_ID",
  "GUARDRAIL_VERSION",
  "RATE_LIMITS_TABLE",
  "ALLOWED_HOSTS",
  // The turn: its runtime session, approvals, skills, knowledge searches and the catalog of
  // the agent's tools (signed pack statements and remote MCP catalogs).
  "AGENT_SESSION_IDLE_SECONDS",
  "AGENT_SESSION_MAX_SECONDS",
  "APPROVALS_TABLE",
  "TICKETS_TABLE",
  "SKILLS_TABLE",
  "SKILLS_BUCKET",
  "KNOWLEDGE_EMBEDDING_PRICE",
  "CODE_INTERPRETER_PRICES",
  "PACKS_BUCKET",
  "PACKS_BUCKET_OWNER",
  "PACK_CATALOG",
  "PACK_SIGNING_PUBLIC_KEY",
  "REMOTE_CATALOG",
  "REMOTE_MCP_ENABLED",
  "REMOTE_MCP_KEY_ID",
  "MANGO_VERSION",
  // The turns of task runs (D78, D121 (5)): their table, the tasks client their tokens are
  // verified against and the function that draws the PDF of a report (D86). Never the client's
  // secret, the identity key, the queue of runs or Scheduler: those stay mango-api's (TM-T1).
  "TASKS_TABLE",
  "TASKS_CLIENT_ID",
  "TASK_REPORT_FUNCTION",
  // The agents' memory (D122 (8)): the worker recalls before the harness and writes what the
  // person said. Only whether it is on, the memory and the least score; never its key.
  "AGENT_MEMORY_ENABLED",
  "AGENT_MEMORY_ARN",
  "AGENT_MEMORY_MIN_SCORE",
] as const;
/** The environment variable both services read the queue from. */
export const CHAT_TURNS_QUEUE_ENV = "MANGO_CHAT_TURNS_QUEUE_URL";
const READING = ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"];

/** `Mango-<ns>-TurnWorker`: the task role of `mango-turn-worker`, created in its nested stack. */
export const turnWorkerRoleName = (ns: string) => mangoName(ns, "TurnWorker");
/** `Mango-<ns>-turn-worker`: the ECS service (and its task family). */
export const turnWorkerServiceName = (ns: string) => mangoName(ns, "turn-worker");

/**
 * The ARN of the worker's role, by its name: Core names it and never reads the nested stack that
 * creates it (D99 (4)).
 */
export function turnWorkerRoleArn(scope: Construct, ns: string): string {
  const { partition, account } = Stack.of(scope);
  return `arn:${partition}:iam::${account}:role/${turnWorkerRoleName(ns)}`;
}

export interface ChatTurnQueueProps {
  readonly installation: Installation;
  /** The only role that sends turns. */
  readonly apiTaskRole: iam.Role;
}

/**
 * `Mango-<ns>-ChatTurns` (D121 (2), (4); TM-TW1): every chat turn starts from one message,
 * with the person's access token inside. A key of its own and two policies keep it readable by
 * the worker alone:
 *
 * - Queue policy: only the worker receives, deletes or changes the visibility of a message;
 *   only mango-api sends. A deny, so no other policy of the account can open it.
 * - Key policy: only those two roles may decrypt, and only through SQS. mango-api needs
 *   `kms:Decrypt` to send (SQS checks each new data key with it); it cannot receive, so it
 *   never reads a message (precision of D121 (4), 2026-11-07).
 * - The dead-letter queue: same key; nobody receives from it or moves its messages back (the
 *   worker never reprocesses a turn, TM-TW5).
 */
export class ChatTurnQueue extends Construct {
  readonly key: kms.Key;
  readonly queue: sqs.Queue;
  readonly deadLetters: sqs.Queue;
  /** The ARN of the only role that reads, by name (`turnWorkerRoleName`). */
  readonly workerRoleArn: string;

  constructor(scope: Construct, id: string, props: ChatTurnQueueProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    const { region } = Stack.of(this);
    const api = props.apiTaskRole.roleArn;
    const worker = (this.workerRoleArn = turnWorkerRoleArn(this, ns));
    const viaSqs = `sqs.${region}.amazonaws.com`;

    this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(ns, "chat-turns")}`,
      description: "Encrypts the messages of chat turns, with the access token of the person; only the turn worker reads them",
      enableKeyRotation: true,
      // Messages live 20 minutes and their tokens one hour: a new key needs nothing else.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyTheTurnRolesDecrypt",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          ArnNotEquals: { "aws:PrincipalArn": [api, worker] },
          Bool: { "aws:PrincipalIsAWSService": "false" },
        },
      }),
    );
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DecryptOnlyThroughSqs",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringNotEquals: { "kms:ViaService": viaSqs },
          Bool: { "aws:PrincipalIsAWSService": "false" },
        },
      }),
    );

    this.deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "ChatTurns-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      // TLS only: in the one policy of both queues below.
      enforceSSL: false,
      retentionPeriod: CHAT_TURN_DEAD_LETTER_RETENTION,
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: mangoName(ns, "ChatTurns"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.key,
      // TLS only: in the one policy of both queues below.
      enforceSSL: false,
      visibilityTimeout: CHAT_TURN_VISIBILITY,
      retentionPeriod: CHAT_TURN_RETENTION,
      deadLetterQueue: { queue: this.deadLetters, maxReceiveCount: CHAT_TURN_RECEIPTS },
    });

    // One policy for both queues: each statement names its queue.
    new sqs.QueuePolicy(this, "Policy", { queues: [this.queue, this.deadLetters] }).document.addStatements(
      new iam.PolicyStatement({
        sid: "OnlyTheWorkerReads",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: READING,
        resources: [this.queue.queueArn],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": worker } },
      }),
      new iam.PolicyStatement({
        sid: "OnlyMangoApiSends",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["sqs:SendMessage"],
        resources: [this.queue.queueArn],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": api } },
      }),
      new iam.PolicyStatement({
        sid: "NobodyReadsTurns",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: [...READING, "sqs:StartMessageMoveTask"],
        resources: [this.deadLetters.queueArn],
      }),
      ...[this.queue, this.deadLetters].map(
        (queue, i) =>
          new iam.PolicyStatement({
            sid: i === 0 ? "TlsOnly" : "TlsOnlyDeadLetters",
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["sqs:*"],
            resources: [queue.queueArn],
            conditions: { Bool: { "aws:SecureTransport": "false" } },
          }),
      ),
    );

    // mango-api sends, and nothing else (`kms:Decrypt` is what SQS asks of a sender). A managed
    // policy of its own: the inline policy of the role is full (as `Mango-<ns>-ApiTasks`).
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(ns, "ApiChatTurns"),
      description: "mango-api: sends the chat turns to their queue (D121)",
      roles: [props.apiTaskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "SendChatTurns",
          actions: ["sqs:SendMessage"],
          resources: [this.queue.queueArn],
        }),
        new iam.PolicyStatement({
          sid: "SendChatTurnsKey",
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.key.keyArn],
          conditions: {
            StringEquals: { "kms:ViaService": viaSqs, "kms:EncryptionContext:aws:sqs:arn": this.queue.queueArn },
          },
        }),
      ],
    });
  }

  /** The worker: receive, delete and change the visibility of turns, and decrypt them via SQS. */
  grantWorker(role: iam.IRole): void {
    const { region } = Stack.of(this);
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({ sid: "ReadChatTurns", actions: READING, resources: [this.queue.queueArn] }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadChatTurnsKey",
        actions: ["kms:Decrypt"],
        resources: [this.key.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `sqs.${region}.amazonaws.com`,
            "kms:EncryptionContext:aws:sqs:arn": this.queue.queueArn,
          },
        },
      }),
    );
  }
}

/** What the turn reaches: the resources of Core the chat turn of mango-api uses today. */
export interface TurnResources {
  /** The namespace as the stack of the role names it (D99: a parameter of a nested stack). */
  readonly namespace: string;
  readonly auxiliaryModel: string;
  /** The base guardrail: what a cell of the code sandbox shows goes through it first (C4, TM-CI5). */
  readonly guardrailArn: string;
  readonly policyStoreArn: string;
  readonly dataAccessRole: iam.IRole;
  readonly dataKey: kms.IKey;
  readonly budgets: dynamodb.TableV2;
  readonly auditIndex: dynamodb.TableV2;
  readonly auditStream: firehose.DeliveryStream;
  readonly settings: dynamodb.ITable;
  readonly agents: dynamodb.ITable;
  readonly approvals: dynamodb.ITable;
  /** Read by the gate of the tickets tool when a call becomes a request (D112). */
  readonly tickets: dynamodb.ITable;
  /** The shared counters of that gate (D70). */
  readonly rateLimits: dynamodb.ITable;
  readonly skills: dynamodb.ITable;
  /** The secret the invocation is signed with (X-Mango-Invocation), and the key it is encrypted with. */
  readonly invocationKey: secretsmanager.ISecret;
  readonly configKey: kms.IKey;
  /** Signed pack statements and remote MCP profiles of the release: the catalog of the agent. */
  readonly grantCatalog: (grantee: iam.IGrantable) => void;
  /** The agents' memory (D122 (8)): recall and the events of what the person said, only while it is on. */
  readonly grantMemory: (role: iam.IRole) => void;
}

/**
 * The permissions of a chat turn (D121 (3)), copied from those mango-api uses for it and never
 * wider: invoke the harnesses, authorize, take the conversation rows of one person (RLS),
 * reserve and settle the budget, audit, read the published agent and its catalog, ask for
 * approvals, count skills, sign the invocation and name the conversation. Writes of the
 * Settings and Agents tables stay mango-api's.
 */
export function grantChatTurn(role: iam.Role, turn: TurnResources): void {
  const { account, region, partition } = Stack.of(role);
  const add = (statement: iam.PolicyStatement) => role.addToPrincipalPolicy(statement);
  // The harnesses the provisioner creates (D32), named as `AgentPlatform` names them.
  const agentcore = `arn:aws:bedrock-agentcore:${region}:${account}`;
  const harnesses = `${agentcore}:harness/${agentNames.harnessPrefix(turn.namespace)}*`;
  const runtimes = `${agentcore}:runtime/${agentNames.runtimePrefix(turn.namespace)}*`;
  const invoke = [harnesses, `${harnesses}/harness-endpoint/*`, runtimes, `${runtimes}/*`];
  add(
    new iam.PolicyStatement({
      sid: "InvokeAgentHarnesses",
      actions: ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"],
      resources: invoke,
    }),
  );
  const foundation = `arn:aws:bedrock:*::foundation-model/${turn.auxiliaryModel.replace(/^(us|global)\./, "")}`;
  add(
    new iam.PolicyStatement({
      sid: "AuxiliaryModel",
      actions: ["bedrock:InvokeModel"],
      resources: [`arn:aws:bedrock:${region}:${account}:inference-profile/${turn.auxiliaryModel}`, foundation],
    }),
  );
  // The «Analizando» block (C4): code, output and exception of a cell, before they are shown.
  add(
    new iam.PolicyStatement({
      sid: "GuardShownCode",
      actions: ["bedrock:ApplyGuardrail"],
      resources: [turn.guardrailArn],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "PlatformAuthorization",
      actions: ["verifiedpermissions:IsAuthorized"],
      resources: [turn.policyStoreArn],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "ConversationDataRls",
      actions: ["sts:AssumeRole", "sts:TagSession"],
      resources: [turn.dataAccessRole.roleArn],
    }),
  );
  turn.budgets.grantReadWriteData(role);
  turn.auditStream.grantPutRecords(role);
  turn.auditIndex.grantReadWriteData(role);
  add(
    new iam.PolicyStatement({
      sid: "ReadSettings",
      actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"],
      resources: [turn.settings.tableArn],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "ReadAgents",
      actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"],
      resources: [
        turn.agents.tableArn,
        ...[AGENTS_BY_STATUS, AGENTS_BY_CREATOR].map((index) => `${turn.agents.tableArn}/index/${index}`),
      ],
    }),
  );
  // A write call becomes a request (D27): the turn creates it, lists the person's own and marks
  // the outcome it told the agent. It never confirms, signs, runs or closes one: those updates
  // stay mango-api's (TM-W5, TM-W7).
  add(
    new iam.PolicyStatement({
      sid: "ApprovalRequests",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
      resources: [turn.approvals.tableArn, `${turn.approvals.tableArn}/index/${APPROVALS_BY_REQUESTER}`],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "ApprovalOutcomeNoticed",
      actions: ["dynamodb:UpdateItem"],
      resources: [turn.approvals.tableArn],
      conditions: {
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "notified"] },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    }),
  );
  // A call of the tickets tool is decided when its request is created, as in mango-api (D112):
  // the ticket is read and the request is counted against the shared limits of the person.
  add(
    new iam.PolicyStatement({
      sid: "TicketToolGate",
      actions: ["dynamodb:GetItem"],
      resources: [turn.tickets.tableArn],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "RateLimitsTable",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
      resources: [turn.rateLimits.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["LIMIT#*"] } },
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "CountSkills",
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [turn.skills.tableArn],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "TablesKey",
      actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
      resources: [turn.dataKey.keyArn],
      conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
    }),
  );
  // By statements of the role, never a grant: a grant would write the role into the policy of a
  // key of Core, and Core would read the stack nested in it (D99 (4)).
  add(
    new iam.PolicyStatement({
      sid: "InvocationKey",
      actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
      resources: [turn.invocationKey.secretArn],
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "InvocationKeyDecrypt",
      actions: ["kms:Decrypt"],
      resources: [turn.configKey.keyArn],
      conditions: { StringEquals: { "kms:ViaService": `secretsmanager.${region}.amazonaws.com` } },
    }),
  );
  turn.grantCatalog(role);
  turn.grantMemory(role);
  const keys = `arn:${partition}:kms:${region}:${account}:key/*`;
  add(
    new iam.PolicyStatement({
      sid: "RemoteMcpPublicKey",
      actions: ["kms:GetPublicKey"],
      resources: [keys],
      conditions: { StringEquals: { "kms:RequestAlias": remoteMcpKeyAlias(turn.namespace) } },
    }),
  );
  acknowledge(
    role,
    ...KMS_GRANT_ACTIONS,
    {
      id: `AwsSolutions-IAM5[Resource::${foundation}]`,
      reason: "Cross-region inference profiles route to the model in several regions.",
    },
    ...invoke.map((resource) => ({
      id: `AwsSolutions-IAM5[Resource::${resource}]`,
      reason:
        "Agent harnesses are created at runtime by the provisioner, one per agent (D32): the name prefix " +
        "Mango_<ns>_a_ is the scope. The worker builds every invocation from the published version, as mango-api.",
    })),
    {
      id: `AwsSolutions-IAM5[Resource::${keys}]`,
      reason:
        "Only GetPublicKey, and only through the alias alias/Mango-<ns>-remote-mcp (kms:RequestAlias): the " +
        "key is created by another construct and named here.",
    },
  );
}

/** `Mango-<ns>-TurnWorker`: the task role of `mango-turn-worker`. */
export function turnWorkerRole(scope: Construct, id: string, namespace: string): iam.Role {
  return new iam.Role(scope, id, {
    roleName: turnWorkerRoleName(namespace),
    description: "mango-turn-worker: runs the chat turns of the queue as the person who sent them (D121)",
    assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
  });
}

/** What a task run reaches beyond a chat turn (D78, D121 (5)). */
export interface TaskRunResources {
  readonly tasks: dynamodb.ITable;
  /** «Crear ticket» of a run that ended well (D112). */
  readonly tickets: dynamodb.ITable;
  /** `Mango-<ns>-TaskReport`: draws the PDF of a run (D86). */
  readonly reportFunction: lambda.IFunction;
}

/**
 * What the worker writes in the Tasks table: the end of a run and the release of the hold of its
 * task. Never who a task runs as, what it asks, its agent or its schedule: mango-api issues the
 * token of a run for the owner the table names (TM-T1), so a worker that could write `owner_id`
 * could get the token of anybody.
 */
export const TASK_RUN_ATTRIBUTES = [
  "PK",
  "SK",
  "status",
  "started_at",
  "ended_at",
  "reason",
  "result",
  "cost_usd",
  "turn_id",
  "approvals",
  "steps",
  "report_status",
  "report_reason",
  "report_meta",
  "report_data",
  "report_at",
  "running_run",
  "running_since",
] as const;

/**
 * The turn of a task run in the worker (D121 (5)): read a task and its run, record the run's
 * end and release its hold (only the attributes of {@link TASK_RUN_ATTRIBUTES}, only items of a
 * task), leave a ticket of the run (D112) and ask for its PDF (D86). The notice in the Bandeja
 * goes to the Conversations table through the role of conversation data (RLS), as the turn's
 * rows. Nothing of Cognito, KMS signing, Scheduler or the queue of runs.
 */
export function grantTaskRuns(role: iam.Role, runs: TaskRunResources): void {
  const add = (statement: iam.PolicyStatement) => role.addToPrincipalPolicy(statement);
  const tasks = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AUTO#*"] } };
  add(
    new iam.PolicyStatement({
      sid: "ReadTaskRuns",
      actions: ["dynamodb:GetItem"],
      resources: [runs.tasks.tableArn],
      conditions: tasks,
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "EndTaskRuns",
      actions: ["dynamodb:UpdateItem"],
      resources: [runs.tasks.tableArn],
      conditions: {
        ...tasks,
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TASK_RUN_ATTRIBUTES] },
        // A `ForAllValues` condition holds when the key is absent: the request must name them.
        Null: { "dynamodb:Attributes": "false" },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      },
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "TaskRunTicket",
      actions: ["dynamodb:PutItem"],
      resources: [runs.tickets.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TICKET#*"] } },
    }),
  );
  add(
    new iam.PolicyStatement({
      sid: "TaskRunReport",
      actions: ["lambda:InvokeFunction"],
      resources: [runs.reportFunction.functionArn],
    }),
  );
}

export interface TurnWorkerProps {
  readonly installation: Installation;
  readonly network: Network;
  /** The cluster and image of mango-api (D121 (3)). */
  readonly cluster: ecs.ICluster;
  readonly image: ecs.ContainerImage;
  readonly queue: ChatTurnQueue;
  /** What the turn reaches, but the namespace, which is the installation's. */
  readonly turn: Omit<TurnResources, "namespace">;
  /** The environment of mango-api: the worker takes {@link TURN_WORKER_ENVIRONMENT} from it. */
  readonly apiEnvironment: Record<string, string>;
  /** The runs of tasks, which the worker takes from mango-api (D121 (5)). */
  readonly taskRuns: TaskRunResources;
}

/**
 * `mango-turn-worker` (D121 (3)): an ECS service with the image of mango-api and another entry
 * point, in its cluster and network, with no load balancer and no port. While a turn runs the
 * task protects itself, so a deployment waits for it (D121 (9)): its role may change the
 * protection of the tasks of this cluster only.
 */
export class TurnWorker extends Construct {
  readonly service: ecs.FargateService;
  readonly logGroup: logs.LogGroup;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: TurnWorkerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const { account, region, partition } = Stack.of(this);
    this.role = turnWorkerRole(this, "TaskRole", ns);
    grantChatTurn(this.role, { ...props.turn, namespace: ns });
    grantTaskRuns(this.role, props.taskRuns);
    props.queue.grantWorker(this.role);

    // IAM names no task of a service, only of a cluster: the task ARN carries the cluster,
    // never the service. The cluster is mango-api's, whose tasks never protect themselves.
    // By its fixed name (`ApiService`): a reference would reach this nested stack as a parameter.
    const tasks = `arn:${partition}:ecs:${region}:${account}:task/${mangoName(ns, "api")}/*`;
    this.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "OwnTaskProtection",
        actions: ["ecs:GetTaskProtection", "ecs:UpdateTaskProtection"],
        resources: [tasks],
      }),
    );
    acknowledge(this.role, {
      id: `AwsSolutions-IAM5[Resource::${tasks}]`,
      reason:
        "A task protects itself while a turn runs (D121 (9)). Task ids are ECS's and a task ARN names its cluster, " +
        "never its service: the cluster of mango-api is the narrowest scope IAM takes.",
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "Task", {
      family: mangoName(ns, "turn-worker"),
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: this.role,
    });
    this.logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/mango/${ns}/turn-worker`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      // A create that rolls back would leave a retained group behind, and the next install would
      // fail on its name ("already exists"): RetainExceptOnCreate deletes it only then (D58 (27)).
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
    });
    taskDef.addContainer("worker", {
      image: props.image,
      command: TURN_WORKER_COMMAND,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup: this.logGroup }),
      environment: {
        ...turnWorkerEnvironment(props.apiEnvironment),
        [CHAT_TURNS_QUEUE_ENV]: props.queue.queue.queueUrl,
        AWS_DEFAULT_REGION: region,
      },
      readonlyRootFilesystem: true,
      user: "10001",
      stopTimeout: Duration.seconds(TURN_WORKER_STOP_SECONDS),
    });
    acknowledge(
      taskDef,
      {
        id: "AwsSolutions-ECS2",
        reason: "Environment variables carry non-secret configuration only; there are no secrets.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: "ecr:GetAuthorizationToken (task execution role) has no resource scope.",
      },
    );

    const securityGroup = new ec2.SecurityGroup(this, "Sg", {
      vpc: props.network.vpc,
      description: "mango-turn-worker tasks: no inbound, outbound to the AWS APIs",
      allowAllOutbound: true,
    });
    this.service = new ecs.FargateService(this, "Service", {
      serviceName: turnWorkerServiceName(ns),
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: TURN_WORKER_TASKS,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      securityGroups: [securityGroup],
      circuitBreaker: { rollback: true },
      // New tasks first; an old one stops only once it lifts its protection (D121 (9)).
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: false,
    });
  }
}

/** The part of mango-api's environment the turn needs; fails if one of them is missing. */
export function turnWorkerEnvironment(api: Record<string, string>): Record<string, string> {
  const missing = TURN_WORKER_ENVIRONMENT.filter((name) => !(name in api));
  if (missing.length > 0) throw new Error(`mango-api has no ${missing.join(", ")} for the turn worker`);
  // Never the label of the release (`MANGO_RELEASE`): two releases of the same code differ only
  // in it, and in the templates that name it (D69).
  return Object.fromEntries(TURN_WORKER_ENVIRONMENT.map((name) => [name, api[name]!]));
}
