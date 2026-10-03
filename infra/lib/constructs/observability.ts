import { CfnCondition, Stack } from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import * as xray from "aws-cdk-lib/aws-xray";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";

export interface ObservabilityProps {
  readonly installation: Installation;
  /** Release templates decide at deployment whether the stack owns the setting (D58). */
  readonly when?: CfnCondition;
}

/**
 * CloudWatch Transaction Search: X-Ray spans go to the `aws/spans` log group, which AgentCore
 * Observability requires to show traces. It is an account-wide setting, so installations in
 * accounts that already manage it set `observability.transactionSearch` to `external`.
 */
export class Observability extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    if (props.installation.observability.transactionSearch !== "stack") return;
    const stack = Stack.of(this);
    const logGroupArn = (name: string) =>
      `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:${name}:*`;

    const spansPolicy = new logs.CfnResourcePolicy(this, "XRaySpansPolicy", {
      policyName: `Mango-${props.installation.namespace}-TransactionSearchXRayAccess`,
      policyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "TransactionSearchXRayAccess",
            Effect: "Allow",
            Principal: { Service: "xray.amazonaws.com" },
            Action: "logs:PutLogEvents",
            Resource: [logGroupArn("aws/spans"), logGroupArn("/aws/application-signals/data")],
            Condition: {
              ArnLike: { "aws:SourceArn": `arn:${stack.partition}:xray:${stack.region}:${stack.account}:*` },
              StringEquals: { "aws:SourceAccount": stack.account },
            },
          },
        ],
      }),
    });

    // 1 % of spans indexed as trace summaries: the free tier.
    const config = new xray.CfnTransactionSearchConfig(this, "TransactionSearch", {
      indexingPercentage: 1,
    });
    config.addResourceDependency(spansPolicy);
    if (props.when) {
      spansPolicy.cfnOptions.condition = props.when;
      config.cfnOptions.condition = props.when;
    }
  }
}
