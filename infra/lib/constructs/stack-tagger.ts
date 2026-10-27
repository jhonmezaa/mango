import { Aspects, CfnResource, CustomResource, Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct, IConstruct } from "constructs";
import { Installation } from "../config/schema.js";
import { acknowledge } from "../nag.js";
import { mangoName, roleNames } from "../names.js";
import { PythonFunction } from "./python-function.js";

export interface StackTaggerProps {
  readonly installation: Installation;
  /** The VPCs of the installation: Core's, and the pack network's when there is one. */
  readonly vpcIds: string[];
  /** Changes with every version, so that CloudFormation calls the function on every update (D77 (2)). */
  readonly release: string;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
}

/**
 * Resource types the tagger works on, or whose existence it needs first: the policies it tags,
 * the VPCs and security groups whose defaults and rules it tags, and the CDK custom resource
 * that empties the default security group of a VPC.
 */
const BEFORE_THE_TAGGER = new Set([
  "AWS::IAM::ManagedPolicy",
  "AWS::EC2::VPC",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::SecurityGroupIngress",
  "AWS::EC2::SecurityGroupEgress",
  "Custom::VpcRestrictDefaultSG",
]);

/**
 * Stack tagger (D77): gives the stack's tags to what CloudFormation cannot tag. A custom resource
 * of the Core stack that runs on install and on every version update; a failure rolls the stack
 * back. Write permissions are tags only: `iam:TagPolicy` on the installation's policies, and
 * `ec2:CreateTags` on the defaults of its two VPCs and on security group rules, every request
 * carrying the installation's `mango:namespace` (the rules admit no VPC condition key).
 */
export class StackTagger extends Construct {
  readonly function: PythonFunction["function"];

  constructor(scope: Construct, id: string, props: StackTaggerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const arn = (service: string, resource: string, region = stack.region) =>
      `arn:${stack.partition}:${service}:${region}:${stack.account}:${resource}`;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.stackTagger(ns),
      description: "Stack tagger: gives the stack's tags to what CloudFormation cannot tag (D77)",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const allow = (
      sid: string,
      actions: string[],
      resources: string[],
      conditions?: Record<string, Record<string, unknown>>,
    ) => role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, ...(conditions ? { conditions } : {}) }));
    const ownNamespace = { "aws:RequestTag/mango:namespace": ns };

    // Its own stack and the pack network's: their tags, and the policies they declare. Also
    // the stacks nested in Core (D99), named after it: the policies they declare are Core's.
    const nestedStacks = arn("cloudformation", `stack/${stack.stackName}-*/*`);
    allow(
      "ReadInstallationStacks",
      ["cloudformation:DescribeStacks", "cloudformation:ListStackResources"],
      [stack.stackId, arn("cloudformation", `stack/${mangoName(ns, "PackNetwork")}/*`), nestedStacks],
    );
    allow("TagInstallationPolicies", ["iam:TagPolicy"], [arn("iam", `policy/${mangoName(ns, "")}*`, "")], {
      StringEquals: ownNamespace,
    });
    // What AWS makes with a VPC: only in the installation's VPCs.
    allow(
      "TagVpcDefaults",
      ["ec2:CreateTags"],
      ["security-group/*", "network-acl/*", "route-table/*"].map((type) => arn("ec2", type)),
      { StringEquals: { "ec2:Vpc": props.vpcIds.map((vpc) => arn("ec2", `vpc/${vpc}`)), ...ownNamespace } },
    );
    // Security group rules admit no VPC or group condition key: the function picks the rules of
    // the installation's groups, and every request has to carry the installation's namespace.
    allow("TagSecurityGroupRules", ["ec2:CreateTags"], [arn("ec2", "security-group-rule/*")], {
      StringEquals: ownNamespace,
    });
    allow(
      "ReadNetwork",
      [
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSecurityGroupRules",
        "ec2:DescribeNetworkAcls",
        "ec2:DescribeRouteTables",
      ],
      ["*"],
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      retainLogs: cfg.retainData,
      handler: "mango_provisioner.stack_tagger.lambda_handler",
      functionName: mangoName(ns, "StackTagger"),
      description: "Gives the stack's tags to what CloudFormation cannot tag (invoked only by CloudFormation)",
      role,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: { MANGO_NAMESPACE: ns, MANGO_ACCOUNT_ID: stack.account },
      environmentEncryption: props.configKey,
    }).function;

    const resource = new CustomResource(this, "Resource", {
      serviceToken: this.function.functionArn,
      resourceType: "Custom::MangoStackTags",
      properties: { Release: props.release, VpcIds: props.vpcIds },
      serviceTimeout: Duration.minutes(10),
    });
    // Its permissions exist before it runs, and so does everything it tags.
    resource.node.addDependency(role);
    runsAfterWhatItTags(resource.node.defaultChild as CfnResource);

    acknowledge(
      role,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: "The EC2 Describe actions it uses have no resource scope; they only read.",
      },
      ...[
        arn("iam", `policy/${mangoName(ns, "")}*`, ""),
        ...["security-group/*", "network-acl/*", "route-table/*", "security-group-rule/*"].map((type) =>
          arn("ec2", type),
        ),
        arn("cloudformation", `stack/${mangoName(ns, "PackNetwork")}/*`),
        nestedStacks,
      ].map((resourceArn) => ({
        id: `AwsSolutions-IAM5[Resource::${resourceArn}]`,
        reason:
          "Tags only. The policies are the installation's (name prefix); the network resources are limited by " +
          "the ec2:Vpc condition, or, for security group rules that admit none, by the namespace every request " +
          "must carry. The pack network stack id ends in a generated suffix; the stacks nested in Core are " +
          "named after it with generated suffixes, and only read.",
      })),
    );
  }
}

/**
 * Makes the tagger depend on everything of its stack it tags or needs first, whenever it is
 * declared: an aspect, so a security group or a policy added later is included without anyone
 * listing it. None of these may carry a condition: `DependsOn` cannot name a conditional
 * resource (D58 (17)), and a tagged resource that may not exist needs its own design first.
 * One in a stack nested in Core (D99) makes the tagger wait for that whole nested stack.
 */
function runsAfterWhatItTags(tagger: CfnResource): void {
  Aspects.of(tagger.stack).add({
    visit(node: IConstruct): void {
      if (!CfnResource.isCfnResource(node) || node === tagger || !nestedIn(node.stack, tagger.stack)) return;
      if (!BEFORE_THE_TAGGER.has(node.cfnResourceType)) return;
      if (node.cfnOptions.condition !== undefined) {
        throw new Error(`stack tagger: ${node.node.path} has a condition and cannot be waited for`);
      }
      tagger.addResourceDependency(node);
    },
  });
}

/** Whether `stack` is `root` or nested in it, at any depth. */
function nestedIn(stack: Stack, root: Stack): boolean {
  for (let s: Stack | undefined = stack; s; s = s.nestedStackParent) if (s === root) return true;
  return false;
}
