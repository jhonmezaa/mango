import { Fn, Stack, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53resolver from "aws-cdk-lib/aws-route53resolver";
import { Construct } from "constructs";
import { ReleasePack } from "../config/pack-release.js";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { mangoName } from "../names.js";

const AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com";

/**
 * AWS APIs a pack may declare in the `egress.aws` of its signed manifest (R6), with the VPC
 * interface endpoint that serves each one and the names it answers to. A closed list: keep in
 * sync with `AwsEndpoint` in `packages/py/mango-packs/src/mango_packs/manifest.py` (a test
 * compares them). The endpoints only exist for the services the packs of the release declare,
 * and only in the Region of the installation: a pack reads no other Region.
 */
export const PACK_EGRESS_SERVICES: Record<string, { endpoint: string; names: (region: string) => string[] }> = {
  sts: { endpoint: "sts", names: (region) => [`sts.${region}.amazonaws.com`] },
  pricing: { endpoint: "pricing.api", names: (region) => [`api.pricing.${region}.amazonaws.com`] },
  ce: { endpoint: "ce", names: (region) => [`ce.${region}.amazonaws.com`] },
  // A global API: its only endpoint is in us-east-1, under the name without region.
  budgets: { endpoint: "budgets", names: () => ["budgets.amazonaws.com"] },
  "compute-optimizer": {
    endpoint: "compute-optimizer",
    names: (region) => [`compute-optimizer.${region}.amazonaws.com`],
  },
  "cost-optimization-hub": {
    endpoint: "cost-optimization-hub",
    names: (region) => [`cost-optimization-hub.${region}.amazonaws.com`],
  },
  cloudwatch: { endpoint: "monitoring", names: (region) => [`monitoring.${region}.amazonaws.com`] },
  // The endpoint every pack has for its own log groups; a pack lists it to read Logs as data.
  logs: { endpoint: "logs", names: (region) => [`logs.${region}.amazonaws.com`] },
};

/**
 * What every pack runtime reaches besides its manifest: CloudWatch Logs for its own log
 * groups. AgentCore requires the endpoint in a VPC without internet access.
 */
const PLATFORM_SERVICE = "logs";

/** AWS-managed prefix list of Amazon S3, per region (stable ids published by AWS). */
const S3_PREFIX_LISTS: Record<string, string> = { "us-east-1": "pl-63a5400a" };

const HTTPS = ec2.Port.tcp(443);

/** `/24` subnets of the pack VPC, one per Availability Zone, out of its `/22`. */
export function packSubnetCidrs(vpcCidr: string, count: number): string[] {
  const [address] = vpcCidr.split("/");
  const [a, b, c] = address!.split(".").map(Number);
  return Array.from({ length: count }, (_, index) => `${a}.${b}.${c! + index}.0/24`);
}

/**
 * What the pack provisioner needs of the pack network: ids, whether the network is part of
 * the same stack or of `Mango-<ns>-PackNetwork` (D58).
 */
export interface PackNetworkRef {
  readonly subnetIds: string[];
  /** Pack id -> security group of its runtime. */
  readonly securityGroupIds: Record<string, string>;
}

/** `PACK_NETWORK` of the pack provisioner: ids of the template, nothing a request can set. */
export function provisionerSetting(stack: Stack, network: PackNetworkRef): string {
  return stack.toJsonString({ subnets: network.subnetIds, security_groups: network.securityGroupIds });
}

/** Names `Mango-<ns>-PackNetwork` exports and `Mango-<ns>-Core` imports. */
export const packNetworkExports = {
  subnet: (ns: string, index: number) => `${mangoName(ns, "PackNetwork")}-Subnet${index + 1}`,
  securityGroup: (ns: string, pack: string) => `${mangoName(ns, "PackNetwork")}-SecurityGroup-${pack}`,
};
/** Zones of the pack network: one subnet in each (D54: two at least, in every installation). */
export const PACK_NETWORK_ZONES = 2;

/** The pack network of another stack of the same account, by its exports. */
export function importPackNetwork(ns: string, packs: Pick<ReleasePack, "id">[]): PackNetworkRef {
  return {
    subnetIds: Array.from({ length: PACK_NETWORK_ZONES }, (_, index) =>
      Fn.importValue(packNetworkExports.subnet(ns, index)),
    ),
    securityGroupIds: Object.fromEntries(
      packs.map((pack) => [pack.id, Fn.importValue(packNetworkExports.securityGroup(ns, pack.id))]),
    ),
  };
}

export interface PackNetworkProps {
  readonly installation: Pick<Installation, "namespace" | "organizationId" | "packs">;
  /** Signed packs of the release: each one gets a security group built from its `egress`. */
  readonly packs: ReleasePack[];
}

/**
 * Network of the MCP pack runtimes (R6): a VPC of its own with **no internet gateway and no
 * NAT**, so nothing is routable from a pack but VPC endpoints. Packs are third-party code that
 * reads account data; this is what keeps what they read inside AWS and inside the organization.
 *
 * - One security group per pack of the release, with HTTPS egress only to the interface
 *   endpoints of the AWS APIs its signed manifest declares, to CloudWatch Logs and to S3
 *   (from where AgentCore loads the runtime's code). Each endpoint only admits the packs that
 *   declare it.
 * - Endpoint policies only admit principals of the organization: credentials a pack brings
 *   from anywhere else are refused at the endpoint. The S3 gateway endpoint only lets
 *   AgentCore read its code buckets, so a pack cannot use S3 at all.
 * - A Route 53 Resolver DNS Firewall resolves the names of those endpoints and nothing else
 *   (no DNS tunnel). A VPC fails closed when the firewall cannot answer (the default).
 *
 * Everything is static in the template (D25): the pack provisioner only names these subnets
 * and the pack's security group when it creates a runtime. Not peered with the VPC of
 * mango-api (D15). Threat model: `docs/security/threat-models/pack-egress-threat-model.md`.
 */
export class PackNetwork extends Construct implements PackNetworkRef {
  readonly vpc: ec2.Vpc;
  readonly subnets: ec2.ISubnet[];
  /** Pack id -> security group of its runtime. */
  readonly securityGroups: Record<string, ec2.SecurityGroup> = {};
  /** Egress service id -> its interface endpoint (`logs` included). */
  readonly endpoints: Record<string, ec2.InterfaceVpcEndpoint> = {};

  constructor(scope: Construct, id: string, props: PackNetworkProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const region = Stack.of(this).region;
    const network = cfg.packs.network;

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: mangoName(ns, "PackVpc"),
      ipAddresses: ec2.IpAddresses.cidr(network.cidr),
      // The subnets below are placed by zone id.
      maxAzs: network.availabilityZoneIds.length,
      // No subnet groups: no internet gateway, no NAT, no default route of any kind.
      subnetConfiguration: [],
      natGateways: 0,
      flowLogs: {
        rejected: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, "FlowLogs", {
              retention: logs.RetentionDays.ONE_MONTH,
              encryptionKey: logsKeyOf(this),
            }),
          ),
          // What a pack tried to reach and could not: the trace of an exfiltration attempt.
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });

    // AgentCore only places runtimes in some Availability Zones, and zone names map to
    // different zones in every account: subnets are pinned by zone id.
    const cidrs = packSubnetCidrs(network.cidr, network.availabilityZoneIds.length);
    this.subnets = network.availabilityZoneIds.map((zoneId, index) => {
      const subnet = new ec2.PrivateSubnet(this, `Subnet${index + 1}`, {
        vpcId: this.vpc.vpcId,
        availabilityZone: zoneId,
        cidrBlock: cidrs[index]!,
        mapPublicIpOnLaunch: false,
      });
      const resource = subnet.node.defaultChild as ec2.CfnSubnet;
      resource.addPropertyDeletionOverride("AvailabilityZone");
      resource.addPropertyOverride("AvailabilityZoneId", zoneId);
      Tags.of(subnet).add("Name", mangoName(ns, `pack-${zoneId}`));
      return subnet;
    });

    // --- S3 gateway endpoint: only AgentCore, only its code buckets -----------------------
    const s3 = new ec2.GatewayVpcEndpoint(this, "S3", {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnets: this.subnets }],
    });
    s3.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreReadsRuntimeCode",
        // `"Principal": "*"`, as AgentCore documents it and as verified in the lab: the reader
        // is the service itself, which `{"AWS": "*"}` (IAM principals) may not match.
        principals: [new iam.StarPrincipal()],
        actions: ["s3:GetObject"],
        // Service-owned buckets (account regional namespace): only AWS can own these names.
        resources: [`arn:aws:s3:::acr-code-*-${region}-an`, `arn:aws:s3:::acr-code-*-${region}-an/*`],
        conditions: { StringEquals: { "aws:PrincipalServiceName": AGENTCORE_SERVICE } },
      }),
    );

    // --- Interface endpoints: the declared AWS APIs and CloudWatch Logs -------------------
    const declared = [...new Set(props.packs.flatMap((pack) => pack.egress.aws))].sort();
    const services = new Map<string, (typeof PACK_EGRESS_SERVICES)[string]>();
    for (const service of [PLATFORM_SERVICE, ...declared]) {
      const known = PACK_EGRESS_SERVICES[service];
      if (known === undefined) throw new Error(`unknown pack egress service ${service}`);
      services.set(service, known);
    }
    const endpointGroups: Record<string, ec2.SecurityGroup> = {};
    for (const [service, { endpoint }] of services) {
      const group = new ec2.SecurityGroup(this, `EndpointSg-${service}`, {
        vpc: this.vpc,
        description: `VPC endpoint of ${service}: HTTPS only from the packs that declare it`,
        allowAllOutbound: false,
      });
      endpointGroups[service] = group;
      const vpcEndpoint = new ec2.InterfaceVpcEndpoint(this, `Endpoint-${service}`, {
        vpc: this.vpc,
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${region}.${endpoint}`, 443),
        subnets: { subnets: this.subnets },
        securityGroups: [group],
        privateDnsEnabled: true,
        // No rule for the whole VPC: only the packs below.
        open: false,
      });
      vpcEndpoint.addToPolicy(
        new iam.PolicyStatement({
          sid: "OrganizationOnly",
          principals: [new iam.StarPrincipal()],
          actions: ["*"],
          resources: ["*"],
          // IAM still decides what each role may do. This refuses anyone who is not a
          // principal of the organization: keys a pack brings with it cannot be used here.
          conditions: { StringEquals: { "aws:PrincipalOrgID": cfg.organizationId } },
        }),
      );
      this.endpoints[service] = vpcEndpoint;
    }

    // --- One security group per pack: HTTPS to its endpoints, nothing else ----------------
    const s3PrefixList = S3_PREFIX_LISTS[region];
    if (s3PrefixList === undefined) throw new Error(`no S3 prefix list is known for ${region}`);
    for (const pack of props.packs) {
      const group = new ec2.SecurityGroup(this, `PackSg-${pack.id}`, {
        vpc: this.vpc,
        description: `MCP pack ${pack.id}: HTTPS only to the VPC endpoints its signed manifest declares`,
        allowAllOutbound: false,
      });
      for (const service of new Set([PLATFORM_SERVICE, ...pack.egress.aws])) {
        group.connections.allowTo(endpointGroups[service]!, HTTPS, `VPC endpoint of ${service}`);
      }
      group.addEgressRule(ec2.Peer.prefixList(s3PrefixList), HTTPS, "S3 gateway endpoint (runtime code)");
      Tags.of(group).add("mango:pack", pack.id);
      this.securityGroups[pack.id] = group;
    }

    // --- DNS Firewall: the names of the endpoints, nothing else ---------------------------
    const allowed = new route53resolver.CfnFirewallDomainList(this, "DnsAllowed", {
      name: mangoName(ns, "PackDnsAllowed"),
      domains: [
        ...[...services.values()].flatMap((service) => service.names(region)).map((name) => `${name}.`),
        // AgentCore asks for its code bucket by the global S3 name and writes platform logs
        // by the regional one. Queries for these names only ever reach AWS.
        "*.s3.amazonaws.com.",
        `s3.${region}.amazonaws.com.`,
        `*.s3.${region}.amazonaws.com.`,
      ].sort(),
    });
    const everything = new route53resolver.CfnFirewallDomainList(this, "DnsEverything", {
      name: mangoName(ns, "PackDnsEverything"),
      domains: ["*."],
    });
    const rules = new route53resolver.CfnFirewallRuleGroup(this, "DnsRules", {
      name: mangoName(ns, "PackDns"),
      firewallRules: [
        {
          priority: 100,
          action: "ALLOW",
          firewallDomainListId: allowed.attrId,
          // S3 answers with CNAME chains: the decision is made on the name that was asked.
          firewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN",
        },
        { priority: 200, action: "BLOCK", blockResponse: "NXDOMAIN", firewallDomainListId: everything.attrId },
      ],
    });
    new route53resolver.CfnFirewallRuleGroupAssociation(this, "DnsFirewall", {
      name: mangoName(ns, "PackDns"),
      firewallRuleGroupId: rules.attrId,
      vpcId: this.vpc.vpcId,
      priority: 101,
      // Only CloudFormation changes it. With protection on, the stack could not update or
      // delete its own association without a manual step in between.
      mutationProtection: "DISABLED",
    });
  }

  get subnetIds(): string[] {
    return this.subnets.map((subnet) => subnet.subnetId);
  }

  get securityGroupIds(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.securityGroups).map(([pack, group]) => [pack, group.securityGroupId]),
    );
  }

  get provisionerSetting(): string {
    return provisionerSetting(Stack.of(this), this);
  }
}

/** `PACK_NETWORK` of a release without packs: there is no network, and nothing to install. */
export const NO_PACK_NETWORK = JSON.stringify({ subnets: [], security_groups: {} });
