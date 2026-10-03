import { IAspect, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct, IConstruct } from "constructs";

const LOGS_KEY_ID = "LogsKey";

export interface LogsKeyProps {
  readonly namespace: string;
  readonly retainData: boolean;
  /** Alias suffix (`alias/Mango-<ns>-<name>`); a second stack of the installation names its own. */
  readonly name?: string;
}

/**
 * Customer-managed key for the installation's CloudWatch log groups (Well-Architected
 * SEC-8, cfn-guard CLOUDWATCH_LOG_GROUP_ENCRYPTED). Created once per stack; constructs get
 * it with {@link logsKeyOf}.
 */
export class LogsKey extends Construct {
  readonly key: kms.Key;

  constructor(scope: Stack, props: LogsKeyProps) {
    super(scope, LOGS_KEY_ID);
    const stack = Stack.of(this);
    this.key = new kms.Key(this, "Key", {
      alias: `alias/Mango-${props.namespace}-${props.name ?? "logs"}`,
      description: "Encrypts the Mango installation's CloudWatch log groups",
      enableKeyRotation: true,
      removalPolicy: props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsInThisAccount",
        principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
        actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
        resources: ["*"],
        conditions: {
          ArnLike: {
            "kms:EncryptionContext:aws:logs:arn": `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*`,
          },
        },
      }),
    );
  }
}

/**
 * Keys of a deleted stack stay pending for the shortest window KMS allows, 7 days, instead of
 * the 30 CloudFormation defaults to: a retained key is the customer's to delete anyway.
 */
export class ShortKeyDeletionWindow implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof kms.CfnKey && node.pendingWindowInDays === undefined) node.pendingWindowInDays = 7;
  }
}

/** The stack's {@link LogsKey}; the stack must create it before any log group. */
export function logsKeyOf(scope: IConstruct): kms.IKey {
  const holder = Stack.of(scope).node.tryFindChild(LOGS_KEY_ID);
  if (!(holder instanceof LogsKey)) {
    throw new Error("LogsKey must be created in the stack before log groups");
  }
  return holder.key;
}
