import { CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { alertsTopicName, mangoName } from "../names.js";

export interface AlertsProps {
  readonly installation: Installation;
}

/**
 * Where the installation's CloudWatch alarms notify: one encrypted SNS topic. The mailboxes of
 * the installation config (`alerts.emails`) are subscribed here and each must confirm; any
 * other channel (chat, paging) is subscribed by the customer outside the stack.
 *
 * Alarm messages carry alarm names, metric names and thresholds, never agent content.
 */
export class Alerts extends Construct {
  readonly topic: sns.Topic;
  /** Key of the topic and of the queues that feed alarms (dead-letter queues). */
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: AlertsProps) {
    super(scope, id);
    const cfg = props.installation;
    const stack = Stack.of(this);
    const cloudwatch = new iam.ServicePrincipal("cloudwatch.amazonaws.com");

    const key = (this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(cfg.namespace, "alerts")}`,
      description: "Encrypts the Mango alerts topic and dead-letter queues",
      enableKeyRotation: true,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    }));
    // CloudWatch publishes alarm notifications to the encrypted topic with these two actions,
    // and only on behalf of this account (confused deputy; SNS guide, "Enable compatibility
    // between event sources from AWS services and encrypted topics").
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchAlarmsToAlertsTopic",
        principals: [cloudwatch],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": stack.account } },
      }),
    );

    this.topic = new sns.Topic(this, "Topic", {
      topicName: alertsTopicName(cfg.namespace),
      displayName: `Mango ${cfg.namespace} alerts`,
      masterKey: key,
      enforceSSL: true,
    });
    // Only alarms of this account. `enforceSSL` replaces the default topic policy, so the
    // publisher has to be named.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AlarmsOfThisAccount",
        principals: [cloudwatch],
        actions: ["sns:Publish"],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:cloudwatch:${stack.region}:${stack.account}:alarm:*`,
          },
        },
      }),
    );

    for (const email of cfg.alerts.emails) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    new CfnOutput(stack, "AlertsTopicArn", { value: this.topic.topicArn });
  }
}
