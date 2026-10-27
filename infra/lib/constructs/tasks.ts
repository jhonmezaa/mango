import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

/** Index names of the Tasks table; keep in sync with `mango_api.tasks_store`. */
export const TASKS_BY_OWNER = "ByOwner";
export const TASKS_ALL = "All";
export const TASKS_BY_EVENT = "ByEvent";
/**
 * How long a message of a run stays invisible once a task of mango-api takes it: the longest
 * turn (600 s), the read margin and the time to get a token and record the end.
 */
export const TASK_RUN_VISIBILITY = Duration.minutes(15);
/** Receipts before a message that keeps failing goes to the dead-letter queue. */
export const TASK_RUN_RECEIPTS = 3;

export interface TaskPlatformProps {
  readonly installation: Installation;
  readonly userPool: cognito.UserPool;
  /** Key that encrypts the tables with customer data. */
  readonly dataKey: kms.IKey;
  /** Key of the environment of the installation's functions. */
  readonly configKey: kms.IKey;
}

/**
 * Tasks: a published agent that works without chat (D78; design `docs/specs/tasks.md`, threat
 * model `tasks-threat-model.md`).
 *
 * - `Tasks` table: automations and their runs, with the result of each run (90-day TTL).
 * - Queue `TaskRuns`: every run starts from one message. EventBridge Scheduler, mango-api
 *   («Ejecutar ahora») and the consumer of an event (D79, `grantEnqueueEvents`) send to it;
 *   only mango-api reads it.
 * - Schedule group `Mango-<ns>-tasks`: mango-api creates one schedule per task in it by SDK
 *   (D25). Schedules take no tags; the group carries the stack's (D76), and deleting the stack
 *   deletes the group with its schedules (D58).
 * - The identity of a run (TM-T1): a client of the user pool that only allows `CUSTOM_AUTH`,
 *   the challenge function, and an asymmetric key whose signature answers that challenge.
 *   Only mango-api signs with it; the challenge function only verifies.
 */
export class TaskPlatform extends Construct {
  readonly table: dynamodb.TableV2;
  readonly runQueue: sqs.Queue;
  readonly runQueueKey: kms.Key;
  /** Messages of runs that failed every receipt: those runs never ran. */
  readonly runDeadLetters: sqs.Queue;
  readonly scheduleGroup: scheduler.CfnScheduleGroup;
  readonly schedulerRole: iam.Role;
  readonly identityKey: kms.Key;
  readonly client: cognito.UserPoolClient;
  /** Secret of the tasks client, in Secrets Manager only. */
  readonly clientSecret: secretsmanager.Secret;
  readonly challenge: PythonFunction;
  /** Environment mango-api needs for tasks. */
  readonly apiEnvironment: Record<string, string>;
  private readonly dataKey: kms.IKey;
  private readonly namespace: string;
  private readonly configKey: kms.IKey;

  constructor(scope: Construct, id: string, props: TaskPlatformProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const { account, region, partition } = Stack.of(this);
    this.dataKey = props.dataKey;
    this.namespace = ns;
    this.configKey = props.configKey;

    // --- Automations and runs ---------------------------------------------------------------
    // Its id names its throttling alarm, as for every table: `ops-Table-Tasks-throttled` (D71, D99).
    this.table = new dynamodb.TableV2(this, "Tasks", {
      tableName: mangoName(ns, "Tasks"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // Runs and their results expire after 90 days (decided 2026-10-15); tasks stay.
      timeToLiveAttribute: "expires_at",
      globalSecondaryIndexes: [TASKS_BY_OWNER, TASKS_ALL, TASKS_BY_EVENT].map((indexName) => ({
        indexName,
        partitionKey: {
          name: { [TASKS_BY_OWNER]: "owner_id", [TASKS_ALL]: "all_pk", [TASKS_BY_EVENT]: "event_key" }[indexName]!,
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
      })),
    });

    // --- The queue every run starts from ----------------------------------------------------
    // A key of its own: Scheduler and the consumer of events encrypt with it, and nothing else.
    this.runQueueKey = new kms.Key(this, "RunQueueKey", {
      alias: `alias/${mangoName(ns, "task-runs")}`,
      description: "Encrypts the messages that start task runs",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const deadLetters = (this.runDeadLetters = new sqs.Queue(this, "RunDeadLetters", {
      queueName: mangoName(ns, "TaskRuns-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.runQueueKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    }));
    this.runQueue = new sqs.Queue(this, "RunQueue", {
      queueName: mangoName(ns, "TaskRuns"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.runQueueKey,
      enforceSSL: true,
      visibilityTimeout: TASK_RUN_VISIBILITY,
      // A due time older than a day is not run late.
      retentionPeriod: Duration.days(1),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: TASK_RUN_RECEIPTS },
    });

    // --- The schedules ---------------------------------------------------------------------
    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, "ScheduleGroup", {
      name: mangoName(ns, "tasks"),
    });
    const groupArn = `arn:${partition}:scheduler:${region}:${account}:schedule-group/${mangoName(ns, "tasks")}`;
    this.schedulerRole = new iam.Role(this, "SchedulerRole", {
      roleName: mangoName(ns, "TaskScheduler"),
      description: "EventBridge Scheduler: sends the due times of tasks to their queue, nothing else",
      // Only schedules of this installation's group, in this account (confused deputy).
      // Scheduler sends the ARN of the group itself, never a schedule's (H1 of the review).
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": account, "aws:SourceArn": groupArn },
      }),
    });
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SendDueTimes",
        actions: ["sqs:SendMessage"],
        resources: [this.runQueue.queueArn],
      }),
    );
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunQueueKey",
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: [this.runQueueKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } },
      }),
    );

    // --- The identity of a run (D78, TM-T1) --------------------------------------------------
    // Asymmetric, so that the challenge function, which verifies, cannot sign.
    this.identityKey = new kms.Key(this, "IdentityKey", {
      alias: `alias/${mangoName(ns, "task-identity")}`,
      description: "Answers the challenge of the tasks client; only mango-api can sign",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      // Nothing is encrypted with it and an answer lives a minute: a new key needs nothing else.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Only `CUSTOM_AUTH` (no password, no SRP, no hosted UI, no OAuth). Tokens live 15 minutes,
    // enough for the longest turn (600 s); the refresh token is revoked as soon as it is
    // issued and lives the shortest Cognito allows.
    // With a secret (D78, after the review of 2026-10-15): nobody but mango-api can even start
    // its flow, so no answer of it tells whether an email is in the directory.
    this.client = props.userPool.addClient("TasksClient", {
      userPoolClientName: mangoName(ns, "tasks"),
      generateSecret: true,
      authFlows: { custom: true },
      disableOAuth: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.minutes(60),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      readAttributes: new cognito.ClientAttributes(),
      writeAttributes: new cognito.ClientAttributes(),
    });
    // The secret only in Secrets Manager (AGENTS.md): never in an environment variable, the
    // template or a log. CDK reads it once with a custom resource whose logging hides data.
    this.clientSecret = new secretsmanager.Secret(this, "ClientSecret", {
      secretName: mangoName(ns, "tasks-client"),
      description: "Secret of the tasks client of the user pool; only mango-api reads it (SECRET_HASH)",
      secretStringValue: this.client.userPoolClientSecret,
      encryptionKey: props.configKey,
    });
    acknowledge(this.clientSecret, {
      id: "AwsSolutions-SMG4",
      reason:
        "It is the secret Cognito generated for the tasks client: a new one means a new client. It only " +
        "lets mango-api start the challenge, which still needs a signature only mango-api can make (D78).",
    });

    // The user pool depends on the challenge function: the client id reaches it through SSM,
    // or the function, the client and the pool would depend on each other.
    const parameterName = `/${mangoName(ns, "tasks")}/client-id`;
    new ssm.StringParameter(this, "ClientParameter", {
      parameterName,
      // A path (it starts with `/`): the namespace may be a parameter of the release.
      simpleName: false,
      description: "Client of the user pool whose challenge issues the token of a task run",
      stringValue: this.client.userPoolClientId,
    });
    // By name, never by reference: a reference is the dependency this parameter is here to avoid.
    const parameterArn = `arn:${partition}:ssm:${region}:${account}:parameter${parameterName}`;

    const challengeRole = new iam.Role(this, "ChallengeRole", {
      roleName: mangoName(ns, "TaskAuth"),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    challengeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "VerifyOnly",
        actions: ["kms:GetPublicKey"],
        resources: [this.identityKey.keyArn],
      }),
    );
    challengeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "TasksClientId",
        actions: ["ssm:GetParameter"],
        resources: [parameterArn],
      }),
    );
    this.challenge = new PythonFunction(this, "Challenge", {
      packageName: "mango-task-auth",
      packagePath: "functions/task-auth",
      retainLogs: cfg.retainData,
      handler: "mango_task_auth.handler.lambda_handler",
      functionName: mangoName(ns, "TaskAuth"),
      description: "Custom auth challenge of the tasks client: issues an owner's token only to mango-api",
      role: challengeRole,
      environment: {
        TASK_IDENTITY_KEY_ARN: this.identityKey.keyArn,
        TASKS_CLIENT_PARAMETER: parameterName,
      },
      environmentEncryption: props.configKey,
      // Cognito waits 5 s for a trigger.
      timeout: Duration.seconds(5),
      memorySize: 256,
    });
    acknowledge(challengeRole, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    for (const operation of [
      cognito.UserPoolOperation.DEFINE_AUTH_CHALLENGE,
      cognito.UserPoolOperation.CREATE_AUTH_CHALLENGE,
      cognito.UserPoolOperation.VERIFY_AUTH_CHALLENGE_RESPONSE,
    ]) {
      props.userPool.addTrigger(operation, this.challenge.function);
    }

    this.apiEnvironment = {
      TASKS_TABLE: this.table.tableName,
      TASK_RUNS_QUEUE_URL: this.runQueue.queueUrl,
      TASK_RUNS_QUEUE_ARN: this.runQueue.queueArn,
      TASK_SCHEDULE_GROUP: mangoName(ns, "tasks"),
      TASK_SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
      TASKS_CLIENT_ID: this.client.userPoolClientId,
      TASK_IDENTITY_KEY_ARN: this.identityKey.keyArn,
      // The ARN, never the value: mango-api reads it from Secrets Manager.
      TASKS_CLIENT_SECRET_ARN: this.clientSecret.secretArn,
    };
  }

  /**
   * mango-api: the table, the queue (send «Ejecutar ahora», read every run), the schedules of
   * the group, the role they send with, and the only signature of the identity key.
   */
  grantApi(role: iam.Role, userPool: cognito.IUserPool): void {
    const { account, region, partition } = Stack.of(this);
    // A managed policy of its own: the inline policies of a role share one size limit, and the
    // task role of mango-api is close to it.
    const policy = new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiTasks"),
      description: "mango-api: tasks without chat (D78)",
      roles: [role],
    });
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TasksTable",
        // No `Scan`. `DeleteItem` only undoes a task whose schedule could not be created.
        actions: [
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
        ],
        resources: [
          this.table.tableArn,
          ...[TASKS_BY_OWNER, TASKS_ALL, TASKS_BY_EVENT].map((index) => `${this.table.tableArn}/index/${index}`),
        ],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TasksTableKey",
        actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [this.dataKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TaskRunQueue",
        actions: ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage", "sqs:SendMessage"],
        resources: [this.runQueue.queueArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TaskRunQueueKey",
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [this.runQueueKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } },
      }),
    );
    const group = this.scheduleGroup.name!;
    const schedules = `arn:${partition}:scheduler:${region}:${account}:schedule/${group}/*`;
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TaskSchedules",
        actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule"],
        resources: [schedules],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "PassTaskSchedulerRole",
        actions: ["iam:PassRole"],
        resources: [this.schedulerRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TasksClientSecret",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [this.clientSecret.secretArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TasksClientSecretKey",
        actions: ["kms:Decrypt"],
        resources: [this.configKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `secretsmanager.${region}.amazonaws.com` } },
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TaskIdentitySign",
        actions: ["kms:Sign"],
        resources: [this.identityKey.keyArn],
      }),
    );
    // Starting `CUSTOM_AUTH` for a run and answering its challenge, on this pool only.
    // `AdminInitiateAuth` is also granted for the web session (D72); the tasks client allows
    // no other flow, and the web client does not allow this one.
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "TaskIdentityChallenge",
        actions: ["cognito-idp:AdminInitiateAuth", "cognito-idp:AdminRespondToAuthChallenge"],
        resources: [userPool.userPoolArn],
      }),
    );
    // Nobody else signs with the identity key, whatever another policy says (TM-T1).
    this.identityKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyMangoApiSigns",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": role.roleArn } },
      }),
    );
    acknowledge(policy, {
      id: `AwsSolutions-IAM5[Resource::${schedules}]`,
      reason:
        "Schedules are created at runtime by mango-api, one per task (D78, D25): the schedule group of the " +
        "installation is the scope.",
    });
  }

  /**
   * A run whose message failed every receipt never ran, and nobody would know (D71): the alarm
   * tells the alerts topic. Created before `OperationalAlarms`, so the dashboard shows it.
   */
  alarmOnFailedRuns(alerts: Alerts): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, "RunsFailedAlarm", {
      alarmName: mangoName(this.namespace, "TaskRuns-failed"),
      alarmDescription:
        "A message that starts a task run failed three times and is in the dead-letter queue " +
        `${mangoName(this.namespace, "TaskRuns-dlq")}: that run (scheduled, «Ejecutar ahora» or an event) never ran. ` +
        "Look first at the log of mango-api («a task message is delivered again»), then at the message in the queue.",
      metric: this.runDeadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(alerts.topic));
    return alarm;
  }

  /**
   * The consumer of an event (D79): it may leave a message in the queue of runs, and nothing
   * else. What the message may say is `mango_core.task_runs`; mango-api checks it again.
   */
  grantEnqueueEvents(grantee: iam.IGrantable): void {
    const { region } = Stack.of(this);
    iam.Grant.addToPrincipal({ grantee, actions: ["sqs:SendMessage"], resourceArns: [this.runQueue.queueArn] });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ["kms:GenerateDataKey", "kms:Decrypt"],
      resourceArns: [this.runQueueKey.keyArn],
      conditions: { StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } },
    });
  }
}
