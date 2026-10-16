import { Duration, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, roleArn, roleNames, SESSION_TAG_KEYS } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

/**
 * `SourceIdentity` of the daily account health (D84): the fixed system identity the CloudTrail
 * of every account it enters shows. Keep in sync with `SYSTEM_IDENTITY` in
 * `functions/admin-probe/src/mango_admin_probe/handler.py`.
 */
export const SYSTEM_SOURCE_IDENTITY = "mango-health";

/** Partition of the Settings table only the account health function writes (D84). */
export const ACCOUNT_HEALTH_PARTITION = "ACCOUNT_HEALTH";

/** Namespace and dimension of the metrics the function emits (embedded metric format). */
export const ACCOUNT_HEALTH_METRICS = { namespace: "Mango/AccountHealth", dimension: "Installation" };

/** Role of the daily account health: named here so the brokers' trust needs no construct. */
export function accountHealthRoleArn(account: string, ns: string): string {
  return roleArn(account, roleNames.accountHealth(ns));
}

/**
 * Condition every other caller of a broker gets (D84): it may not use the system identity.
 * Merged into the conditions of the broker's existing `AssumeRole` and `SetSourceIdentity`
 * statements, next to the closed list of their callers.
 */
export const NOT_THE_SYSTEM_IDENTITY = {
  // Ignoring case: `Mango-Health` would read as the system in CloudTrail too.
  StringNotEqualsIgnoreCase: { "sts:SourceIdentity": SYSTEM_SOURCE_IDENTITY },
};

/**
 * Lets the account health role use `broker`, and only as the system identity (D84): it cannot
 * name a person, and nobody else can name the system (see {@link NOT_THE_SYSTEM_IDENTITY}).
 * `extra` holds the conditions every caller of that broker must meet (the organization).
 */
export function trustAccountHealth(
  broker: iam.Role,
  principal: iam.IPrincipal,
  healthRoleArn: string,
  extra: { StringEquals?: Record<string, string> } = {},
): void {
  const fromHealth = { ArnEquals: { "aws:PrincipalArn": healthRoleArn } };
  const asTheSystem = { StringEquals: { ...extra.StringEquals, "sts:SourceIdentity": SYSTEM_SOURCE_IDENTITY } };
  broker.assumeRolePolicy?.addStatements(
    new iam.PolicyStatement({
      sid: "AccountHealthAsTheSystemIdentity",
      actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      principals: [principal],
      conditions: { ...fromHealth, ...asTheSystem },
    }),
    new iam.PolicyStatement({
      sid: "AccountHealthSessionTags",
      actions: ["sts:TagSession"],
      principals: [principal],
      conditions: {
        ...fromHealth,
        ...(extra.StringEquals ? { StringEquals: extra.StringEquals } : {}),
        "ForAllValues:StringEquals": { "aws:TagKeys": SESSION_TAG_KEYS },
      },
    }),
  );
}

export interface AccountHealthProps {
  readonly installation: Installation;
  /** Settings table: the function writes its one item there (D84). */
  readonly settingsTable: dynamodb.ITableV2;
  /** Key of the table above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** Billing broker and the payer role behind it: where the member accounts are listed. */
  readonly billingBrokerArn: string;
  readonly billingReaderArn: string;
  /** Read broker and the name of the role behind it in every member account (D51). */
  readonly readBrokerArn: string;
  readonly memberRoleName: string;
  /** Where alarms notify, and the key of the dead-letter queue. */
  readonly alerts: Alerts;
  /** mango-api reads the item (its Settings grant) and is denied any write to it. */
  readonly apiTaskRole: iam.IRole;
}

/**
 * Daily health of the connected member accounts (D84, precises D17): a function of its own
 * checks every day that Mango can enter each member account through the chain of the on-demand
 * check (`probe -> ReadBroker -> ReadOnly`), as the system identity `mango-health`, with a
 * session that only allows `sts:GetCallerIdentity`. It records `valid`, `invalid` or `pending`
 * per account in one item of the Settings table (Settings > Connectivity > Member accounts) and
 * alarms on the alerts topic. It is not the reconciler (D41), which stays a read-only function of
 * the Mango account; nor the AdminProbe, which only acts for an administrator.
 */
export class AccountHealth extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: AccountHealthProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.accountHealth(ns),
      description: "Daily account health: enters each member account as mango-health, reads no data",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "UseTheBrokersAsTheSystemIdentity",
        // The brokers' trust only lets this role in as `mango-health` (`trustAccountHealth`).
        actions: ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
        resources: [props.billingBrokerArn, props.readBrokerArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteTheAccountHealthItem",
        actions: ["dynamodb:PutItem"],
        resources: [props.settingsTable.tableArn],
        conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [ACCOUNT_HEALTH_PARTITION] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DataKeyViaDynamoDB",
        // DynamoDB decrypts the table key with this key on every write too: without Decrypt
        // the PutItem is refused (seen in an installation, D84 (11)).
        actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [props.dataKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
      }),
    );

    // EventBridge invokes the function asynchronously: an event that fails every retry lands
    // here instead of disappearing (AGENTS.md). It only holds the scheduled event.
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "AccountHealth-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.alerts.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeadLetterQueueKey",
        // Lambda sends the failed event to the encrypted queue with the function's role.
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [props.alerts.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sqs.${stack.region}.amazonaws.com` } },
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-admin-probe",
      packagePath: "functions/admin-probe",
      retainLogs: cfg.retainData,
      handler: "mango_admin_probe.health.lambda_handler",
      functionName: roleNames.accountHealth(ns),
      description: "Daily check that Mango can enter each member account (mango-health, no data read)",
      role,
      timeout: Duration.minutes(5),
      memorySize: 256,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        SETTINGS_TABLE: props.settingsTable.tableName,
        BILLING_BROKER_ROLE_ARN: props.billingBrokerArn,
        BILLING_READER_ROLE_ARN: props.billingReaderArn,
        READ_BROKER_ROLE_ARN: props.readBrokerArn,
        MEMBER_READ_ROLE_NAME: props.memberRoleName,
        ORG_ACCESS_TARGETS: (cfg.orgAccess?.targets ?? []).join(","),
        ORG_ACCESS_EXCLUDED_ACCOUNT_IDS: (cfg.orgAccess?.excludedAccountIds ?? []).join(","),
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });

    new events.Rule(this, "Daily", {
      ruleName: mangoName(ns, "AccountHealth-daily"),
      description: "Checks once a day that Mango can enter each member account",
      // Before the reconciliation (07:00 UTC): both report before the working day in the Americas.
      schedule: events.Schedule.cron({ minute: "30", hour: "6" }),
      targets: [new targets.LambdaFunction(this.function, { retryAttempts: 2 })],
    });

    // The item is written by this function only: mango-api reads it and IAM denies it any
    // write there (TM-AH4). A managed policy of its own, so the role's inline policies do not
    // overflow (finding of 2026-10-15).
    new iam.ManagedPolicy(this, "ApiCannotWriteHealth", {
      managedPolicyName: mangoName(ns, "ApiAccountHealth"),
      description: "mango-api never writes the account health item (D84)",
      roles: [props.apiTaskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "AccountHealthIsItsFunctionOnly",
          effect: iam.Effect.DENY,
          actions: ["dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [props.settingsTable.tableArn],
          conditions: { "ForAnyValue:StringEquals": { "dynamodb:LeadingKeys": [ACCOUNT_HEALTH_PARTITION] } },
        }),
      ],
    });

    this.alarms(props, deadLetters);
  }

  private alarms(props: AccountHealthProps, deadLetters: sqs.IQueue): void {
    const ns = props.installation.namespace;
    const notify = new cloudwatchActions.SnsAction(props.alerts.topic);
    const metric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: ACCOUNT_HEALTH_METRICS.namespace,
        metricName,
        dimensionsMap: { [ACCOUNT_HEALTH_METRICS.dimension]: ns },
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
      });
    // The function reports once a day; with missing data ignored the alarm keeps its state
    // until the next run reports again (a run with every account valid clears it).
    new cloudwatch.Alarm(this, "InvalidAlarm", {
      alarmName: mangoName(ns, "AccountHealth-invalid"),
      alarmDescription:
        "The daily account health could not enter at least one member account (its role is missing or refuses " +
        "the Read broker, or the broker refuses Mango), or the Read broker accepts a session without " +
        "SourceIdentity. See the account_health.invalid log lines and Settings > Connectivity.",
      metric: new cloudwatch.MathExpression({
        expression: "invalid + identity",
        usingMetrics: { invalid: metric("InvalidAccounts"), identity: metric("IdentityNotRequired") },
        label: "Member accounts Mango cannot enter",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    }).addAlarmAction(notify);
    new cloudwatch.Alarm(this, "FailedAlarm", {
      alarmName: mangoName(ns, "AccountHealth-failed"),
      alarmDescription:
        "The daily account health failed after its retries (event in the dead-letter queue): the member " +
        "accounts could not be listed or the Read broker did not answer. Nothing was recorded.",
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);
  }
}
