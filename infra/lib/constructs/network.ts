import { Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { logsKeyOf } from "../logs.js";
import { Installation } from "../config/schema.js";
import { acknowledge } from "../nag.js";
import { mangoName } from "../names.js";

export interface NetworkProps {
  readonly installation: Installation;
  readonly accessLogs: s3.IBucket;
}

/**
 * Pins subnets to Availability Zone **ids** (D58): a zone name is a different zone in every
 * account, an id is the same one. Each group holds one subnet per zone, in the same order.
 */
export function placeByZoneId(groups: ec2.ISubnet[][], zoneIds: readonly string[]): void {
  for (const group of groups) {
    if (group.length !== zoneIds.length) throw new Error("one subnet per Availability Zone id is expected");
    group.forEach((subnet, index) => {
      const resource = subnet.node.defaultChild as ec2.CfnSubnet;
      resource.addPropertyDeletionOverride("AvailabilityZone");
      resource.addPropertyOverride("AvailabilityZoneId", zoneIds[index]);
    });
  }
}

/**
 * VPC without NAT (D15): Fargate tasks in public subnets with a public IP but no inbound
 * except from the ALB; the ALB is internal and reachable only through CloudFront VPC origins.
 */
export class Network extends Construct {
  readonly vpc: ec2.Vpc;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);
    const cfg = props.installation;

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: mangoName(cfg.namespace, "Vpc"),
      // Two zones, placed by zone id below: the template names no zone of any account.
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        // Fargate tasks request their public IP explicitly (D15); nothing needs auto-assignment.
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: false,
        },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: {
        all: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, "FlowLogs", {
              retention: logs.RetentionDays.ONE_MONTH,
              encryptionKey: logsKeyOf(this),
            }),
          ),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });

    placeByZoneId([this.vpc.publicSubnets, this.vpc.isolatedSubnets], cfg.availabilityZoneIds);

    // CloudFront origin-facing managed prefix list, resolved at deploy time.
    const prefixList = new cr.AwsCustomResource(this, "CloudFrontPrefixList", {
      onUpdate: {
        service: "EC2",
        action: "describeManagedPrefixLists",
        parameters: {
          Filters: [
            { Name: "prefix-list-name", Values: ["com.amazonaws.global.cloudfront.origin-facing"] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of("cloudfront-origin-facing"),
        outputPaths: ["PrefixLists.0.PrefixListId"],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });

    acknowledge(prefixList, {
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "ec2:DescribeManagedPrefixLists does not support resource-level permissions.",
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      description: "Internal ALB: HTTP only from CloudFront VPC origins",
      allowAllOutbound: false,
    });
    albSg.addIngressRule(
      ec2.Peer.prefixList(prefixList.getResponseField("PrefixLists.0.PrefixListId")),
      ec2.Port.tcp(80),
      "CloudFront origin-facing",
    );

    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: mangoName(cfg.namespace, "api"),
      vpc: this.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSg,
      idleTimeout: Duration.seconds(120),
      dropInvalidHeaderFields: true,
    });
    this.alb.logAccessLogs(props.accessLogs, "alb");

    this.listener = this.alb.addListener("Http", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "application/json",
        messageBody: '{"error":{"code":"not_found","message":"not found"}}',
      }),
    });
  }
}
