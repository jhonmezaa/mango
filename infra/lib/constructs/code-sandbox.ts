import { CfnResource, Stack, Tags } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { loadReleaseDefaults } from "../config/release.js";
import { Installation } from "../config/schema.js";
import { acknowledge, arnWildcardFinding } from "../nag.js";
import { codeInterpreterName, mangoName, roleNames } from "../names.js";
import { SCAN_VALIDATION_OBJECT } from "./chat-files.js";

/**
 * Network of the code sandbox (D114 (3)): a VPC of its own, never peered nor routed. Its address
 * range is fixed by the release: nothing reaches it, so it may overlap any other.
 */
export const SANDBOX_VPC_CIDR = "10.212.0.0/24";
/** Where the rejected traffic of the sandbox VPC lands, in the access logs bucket (90 days). */
export const SANDBOX_FLOW_LOGS_PREFIX = "sandbox-flow-logs/";

/** `/26` subnets of the sandbox VPC, one per Availability Zone. */
export function sandboxSubnetCidrs(count: number): string[] {
  const [a, b, c] = SANDBOX_VPC_CIDR.split("/")[0]!.split(".").map(Number);
  return Array.from({ length: count }, (_, index) => `${a}.${b}.${c}.${index * 64}/26`);
}

/**
 * Prices of the sandbox (D115 (2), rule 7): of the installation, or of the release. What a turn
 * of an agent with `code_interpreter` reserves per second of a cell.
 */
export function codeInterpreterPrices(cfg: Installation): { vcpuHour: number; gbHour: number } {
  return cfg.codeInterpreterPrices ?? loadReleaseDefaults().codeInterpreterPrices;
}

export interface SandboxVpcProps {
  readonly installation: Installation;
  /** Rejected traffic of the sandbox: the trace of what the code tried to reach. */
  readonly accessLogs: s3.IBucket;
}

/**
 * The VPC of the code sandbox, in Core: it holds no data, but the stack tagger of Core (D77)
 * tags its defaults, and Core may not read a nested stack. Everything else of the sandbox
 * (subnets, security group, the Code Interpreter) is in the sandbox stack nested in Core.
 *
 * - No internet gateway, no NAT, no endpoint, no peering: no route leaves it (T5, TM-CI3).
 * - DNS off: the Amazon DNS server answers any ENI whatever its security group, and a name
 *   is a way out (a DNS tunnel). The sandbox resolves nothing.
 * - Rejected traffic goes to the access logs bucket (90 days).
 */
export class SandboxVpc extends Construct {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: SandboxVpcProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: mangoName(ns, "SandboxVpc"),
      ipAddresses: ec2.IpAddresses.cidr(SANDBOX_VPC_CIDR),
      // The subnets are in the sandbox stack, placed by zone id.
      maxAzs: 2,
      subnetConfiguration: [],
      natGateways: 0,
      enableDnsSupport: false,
      enableDnsHostnames: false,
      flowLogs: {
        rejected: {
          destination: ec2.FlowLogDestination.toS3(props.accessLogs, SANDBOX_FLOW_LOGS_PREFIX),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });
    // The delivery's own permission, in the bucket policy CloudFormation owns: if AWS added it
    // when the flow log is created, the next update of the policy would drop it in silence.
    // Only this account's log deliveries, only under the prefix.
    const stack = Stack.of(this);
    const fromThisAccount = {
      StringEquals: { "aws:SourceAccount": stack.account },
      ArnLike: { "aws:SourceArn": stack.formatArn({ service: "logs", resource: "*" }) },
    };
    const delivery = new iam.ServicePrincipal("delivery.logs.amazonaws.com");
    props.accessLogs.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "SandboxFlowLogsWrite",
        principals: [delivery],
        actions: ["s3:PutObject"],
        resources: [props.accessLogs.arnForObjects(`${SANDBOX_FLOW_LOGS_PREFIX}AWSLogs/${stack.account}/*`)],
        conditions: {
          ...fromThisAccount,
          StringEquals: { ...fromThisAccount.StringEquals, "s3:x-amz-acl": "bucket-owner-full-control" },
        },
      }),
    );
    props.accessLogs.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "SandboxFlowLogsAclCheck",
        principals: [delivery],
        actions: ["s3:GetBucketAcl"],
        resources: [props.accessLogs.bucketArn],
        conditions: fromThisAccount,
      }),
    );
  }
}

export interface CodeSandboxProps {
  readonly installation: Installation;
  /** The VPC of Core's `SandboxVpc`. */
  readonly vpcId: string;
  /** The chat files bucket of Core and its key (D116): what the scan plan protects. */
  readonly chatFiles: { readonly bucket: s3.IBucket; readonly key: kms.IKey };
}

/**
 * The code sandbox of the installation (D114) and the malware scan of the chat files (D116 (2)).
 * Nothing here holds data (D99 (2)); nothing uses it yet (the connector is C2 of the plan).
 *
 * - Code Interpreter `Mango_<ns>_sandbox`: VPC mode, in two isolated subnets of the sandbox VPC
 *   (a route table each, with the local route only) and a security group without a single
 *   egress rule. **No execution role**: the code has no AWS credentials; the connector moves
 *   every file with `writeFiles` and `readFiles` (D114 (3)). AgentCore puts its network
 *   interfaces there with the service-linked role `AWSServiceRoleForBedrockAgentCoreNetwork`,
 *   which whoever installs Core creates the first time if the account has none (the pack
 *   provisioner may have made it already, R6).
 * - GuardDuty Malware Protection for S3 over the whole chat files bucket, with tagging, and its
 *   role `Mango-<ns>-ChatFilesScan`: the only principal the bucket lets read an object before
 *   its scan (`chat-files.ts`).
 */
export class CodeSandbox extends Construct {
  readonly codeInterpreter: agentcore.CfnCodeInterpreterCustom;
  readonly securityGroup: ec2.SecurityGroup;
  readonly subnets: ec2.PrivateSubnet[];
  readonly scanner: iam.Role;
  readonly scanPlan: guardduty.CfnMalwareProtectionPlan;
  /**
   * What the connector of the sandbox will need (C2 of the plan): the name of the Code
   * Interpreter and its prices. Nothing reads it yet.
   */
  readonly connectorEnvironment: Record<string, string>;

  constructor(scope: Construct, id: string, props: CodeSandboxProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const zones = cfg.availabilityZoneIds;

    // --- Network: isolated subnets and a security group that lets nothing out -----------------
    const cidrs = sandboxSubnetCidrs(zones.length);
    this.subnets = zones.map((zoneId, index) => {
      const subnet = new ec2.PrivateSubnet(this, `Subnet${index + 1}`, {
        vpcId: props.vpcId,
        // Replaced by the zone id below: AgentCore only places interfaces in some zones, and a
        // zone name maps to a different zone in every account.
        availabilityZone: `zone${index + 1}`,
        cidrBlock: cidrs[index]!,
        mapPublicIpOnLaunch: false,
      });
      const resource = subnet.node.defaultChild as ec2.CfnSubnet;
      resource.addPropertyDeletionOverride("AvailabilityZone");
      resource.addPropertyOverride("AvailabilityZoneId", zoneId);
      Tags.of(subnet).add("Name", mangoName(ns, `sandbox-${index + 1}`));
      return subnet;
    });
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: props.vpcId,
      availabilityZones: this.subnets.map((subnet) => subnet.availabilityZone),
    });
    this.securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc,
      securityGroupName: mangoName(ns, "sandbox"),
      description: "Code sandbox: no ingress, no egress (D114)",
      allowAllOutbound: false,
    });

    // --- The Code Interpreter -------------------------------------------------------------------
    // L1 on purpose: the L2 `CodeInterpreterCustom` creates an execution role when given none.
    this.codeInterpreter = new agentcore.CfnCodeInterpreterCustom(this, "CodeInterpreter", {
      name: codeInterpreterName(ns),
      description: "Mango code sandbox: runs the code the model writes, without network or credentials (D114)",
      networkConfiguration: {
        networkMode: "VPC",
        vpcConfig: {
          subnets: this.subnets.map((subnet) => subnet.subnetId),
          securityGroups: [this.securityGroup.securityGroupId],
        },
      },
    });
    for (const subnet of this.subnets) this.codeInterpreter.node.addDependency(subnet);

    this.connectorEnvironment = {
      CODE_INTERPRETER_NAME: codeInterpreterName(ns),
      CODE_INTERPRETER_PRICES: JSON.stringify(codeInterpreterPrices(cfg)),
    };

    // --- Malware scan of the chat files ------------------------------------------------------
    const bucket = props.chatFiles.bucket;
    const rules = stack.formatArn({ service: "events", resource: "rule", resourceName: "DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*" });
    this.scanner = new iam.Role(this, "ScannerRole", {
      roleName: roleNames.chatFilesScanner(ns),
      description: "GuardDuty Malware Protection: scans and tags the chat files (D116 (2))",
      // As AWS documents it; a role can only be passed to a plan from this account.
      assumedBy: new iam.ServicePrincipal("malware-protection-plan.guardduty.amazonaws.com"),
    });
    const policy = new iam.Policy(this, "ScannerPolicy", {
      roles: [this.scanner],
      statements: [
        new iam.PolicyStatement({
          sid: "ManagedRuleForS3Events",
          actions: ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"],
          resources: [rules],
          conditions: { StringLike: { "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com" } },
        }),
        new iam.PolicyStatement({
          sid: "WatchManagedRule",
          actions: ["events:DescribeRule", "events:ListTargetsByRule"],
          resources: [rules],
        }),
        new iam.PolicyStatement({
          sid: "TagScannedObjects",
          actions: [
            "s3:PutObjectTagging",
            "s3:GetObjectTagging",
            "s3:PutObjectVersionTagging",
            "s3:GetObjectVersionTagging",
          ],
          resources: [bucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "BucketEventsToEventBridge",
          actions: ["s3:PutBucketNotification", "s3:GetBucketNotification"],
          resources: [bucket.bucketArn],
        }),
        new iam.PolicyStatement({
          sid: "PutValidationObject",
          actions: ["s3:PutObject"],
          resources: [bucket.arnForObjects(SCAN_VALIDATION_OBJECT)],
        }),
        new iam.PolicyStatement({ sid: "CheckBucketOwnership", actions: ["s3:ListBucket"], resources: [bucket.bucketArn] }),
        new iam.PolicyStatement({
          sid: "ReadToScan",
          actions: ["s3:GetObject", "s3:GetObjectVersion"],
          resources: [bucket.arnForObjects("*")],
        }),
        new iam.PolicyStatement({
          sid: "ChatFilesKey",
          actions: ["kms:GenerateDataKey", "kms:Decrypt"],
          resources: [props.chatFiles.key.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `s3.${stack.region}.amazonaws.com` } },
        }),
      ],
    });
    this.scanPlan = new guardduty.CfnMalwareProtectionPlan(this, "ScanPlan", {
      role: this.scanner.roleArn,
      protectedResource: { s3Bucket: { bucketName: bucket.bucketName } },
      // The tag the bucket policy reads (TBAC); on before the first object (D116 (2)).
      actions: { tagging: { status: "ENABLED" } },
    });
    // GuardDuty checks the role's permissions when the plan is created.
    this.scanPlan.node.addDependency(policy);

    acknowledge(
      policy,
      {
        id: `AwsSolutions-IAM5[Resource::${rules}]`,
        reason: "GuardDuty names the managed rule it creates; AWS documents this prefix as the scope.",
      },
      {
        id: arnWildcardFinding(bucket.node.defaultChild as CfnResource, "/*", "Arn", this),
        reason: "The scanner reads and tags every new object of the chat files bucket (D116 (2)).",
      },
    );
  }
}
