import { Aws, CfnCondition, CfnParameter, CfnResource, Duration, Fn, Stack, Tags } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53resolver from "aws-cdk-lib/aws-route53resolver";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { ReleasePack } from "../config/pack-release.js";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { alertsTopicName, mangoName } from "../names.js";

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
  // Read by the SRE and database packs over member accounts. Each interface endpoint and its
  // private DNS name were checked in the AWS documentation on 2026-11-13; the names are the
  // ones botocore uses in a Region of the `aws` partition.
  cloudtrail: { endpoint: "cloudtrail", names: (region) => [`cloudtrail.${region}.amazonaws.com`] },
  "application-signals": {
    endpoint: "application-signals",
    names: (region) => [`application-signals.${region}.amazonaws.com`],
  },
  xray: { endpoint: "xray", names: (region) => [`xray.${region}.amazonaws.com`] },
  synthetics: { endpoint: "synthetics", names: (region) => [`synthetics.${region}.amazonaws.com`] },
  elasticache: { endpoint: "elasticache", names: (region) => [`elasticache.${region}.amazonaws.com`] },
  rds: { endpoint: "rds", names: (region) => [`rds.${region}.amazonaws.com`] },
  // Performance Insights.
  pi: { endpoint: "pi", names: (region) => [`pi.${region}.amazonaws.com`] },
  ec2: { endpoint: "ec2", names: (region) => [`ec2.${region}.amazonaws.com`] },
  autoscaling: { endpoint: "autoscaling", names: (region) => [`autoscaling.${region}.amazonaws.com`] },
  elasticloadbalancing: {
    endpoint: "elasticloadbalancing",
    names: (region) => [`elasticloadbalancing.${region}.amazonaws.com`],
  },
  ecs: { endpoint: "ecs", names: (region) => [`ecs.${region}.amazonaws.com`] },
  cloudformation: { endpoint: "cloudformation", names: (region) => [`cloudformation.${region}.amazonaws.com`] },
  config: { endpoint: "config", names: (region) => [`config.${region}.amazonaws.com`] },
};

/**
 * Packs whose network exists whenever the release ships them: the packs of the releases before
 * the network was switched per pack (D54). Updating an installation leaves their endpoints,
 * groups and rules as they are. Every other pack has a stack parameter of its own,
 * {@link packNetworkParameter}, off by default: its endpoints are paid for only where an
 * installation turns it on (precision of D54, proposed on 2026-11-13).
 */
export const ALWAYS_ON_PACK_NETWORKS: ReadonlySet<string> = new Set(["aws-billing", "aws-cloudwatch", "aws-pricing"]);

/** Values of a pack network parameter. */
export const PACK_NETWORK_ENABLED = "Enabled";
export const PACK_NETWORK_DISABLED = "Disabled";

const pascal = (id: string) =>
  id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

/** Stack parameter that turns on the network of a pack (`aws-rds` -> `PackAwsRdsNetwork`). */
export function packNetworkParameter(packId: string): string {
  return `Pack${pascal(packId)}Network`;
}

/**
 * SSM parameter where the pack network says whether a switched pack's network is on: the pack
 * provisioner reads it before it installs the pack, and refuses one whose network is off
 * (`pack_network_disabled`). A parameter, not an export: Core imports exports, and an export
 * that another stack imports can never change value.
 */
export function packNetworkSwitchName(ns: string, packId: string): string {
  return `/${mangoName(ns, "pack-network")}/${packId}`;
}

/**
 * What the pack provisioner needs to read the switches of `network`: `ssm:GetParameter` on the
 * exact parameter of each switched pack, nothing else of SSM. None without switched packs.
 */
export function readSwitchesStatement(stack: Stack, ns: string, network: PackNetworkRef): iam.PolicyStatement | undefined {
  if (network.switchedPacks.length === 0) return undefined;
  return new iam.PolicyStatement({
    sid: "ReadPackNetworkSwitches",
    actions: ["ssm:GetParameter"],
    resources: network.switchedPacks.map(
      (packId) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${packNetworkSwitchName(ns, packId)}`,
    ),
  });
}

/** Packs of the release whose network has a parameter of its own, sorted. */
export function switchedPacks(packs: Pick<ReleasePack, "id">[]): string[] {
  return packs.map((pack) => pack.id).filter((id) => !ALWAYS_ON_PACK_NETWORKS.has(id)).sort();
}

/**
 * What every pack runtime reaches besides its manifest: CloudWatch Logs for its own log
 * groups. AgentCore requires the endpoint in a VPC without internet access.
 */
const PLATFORM_SERVICE = "logs";

/** AWS-managed prefix list of Amazon S3, per region (stable ids published by AWS). */
const S3_PREFIX_LISTS: Record<string, string> = { "us-east-1": "pl-63a5400a" };

const HTTPS = ec2.Port.tcp(443);

/**
 * CloudFormation resources `change` defines under `scopes`. A rule between two security groups
 * is a resource of its own (`AWS::EC2::SecurityGroupEgress`/`Ingress`) that `connections` does
 * not return: this finds it, to give it a condition, without changing its logical id.
 */
function added(scopes: Construct[], change: () => void): CfnResource[] {
  const before = new Set(scopes.flatMap((scope) => scope.node.findAll()));
  change();
  return scopes
    .flatMap((scope) => scope.node.findAll())
    .filter((node): node is CfnResource => !before.has(node) && node instanceof CfnResource);
}

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
  /** Packs whose network is switched by a stack parameter ({@link switchedPacks}). */
  readonly switchedPacks: string[];
}

/**
 * `PACK_NETWORK` of the pack provisioner: ids of the template, nothing a request can set. The
 * switched packs only appear when there are some, so a release of the packs that are always on
 * gives the provisioner the same setting as before.
 */
export function provisionerSetting(stack: Stack, network: PackNetworkRef): string {
  return stack.toJsonString({
    subnets: network.subnetIds,
    security_groups: network.securityGroupIds,
    ...(network.switchedPacks.length > 0 ? { switched: network.switchedPacks } : {}),
  });
}

/** Names `Mango-<ns>-PackNetwork` exports and `Mango-<ns>-Core` imports. */
export const packNetworkExports = {
  /** The pack VPC, for the stack tagger of Core (D77). */
  vpc: (ns: string) => `${mangoName(ns, "PackNetwork")}-VpcId`,
  subnet: (ns: string, index: number) => `${mangoName(ns, "PackNetwork")}-Subnet${index + 1}`,
  securityGroup: (ns: string, pack: string) => `${mangoName(ns, "PackNetwork")}-SecurityGroup-${pack}`,
};
/** Zones of the pack network: one subnet in each (D54: two at least, in every installation). */
export const PACK_NETWORK_ZONES = 2;

/** Queries the DNS Firewall of the pack network refuses in 5 minutes before it alarms (TM-E2). */
export const PACK_DNS_BLOCKED_QUERIES = 1;

/**
 * Names the AgentCore machine asks for by itself when a runtime session starts, before the code
 * of the pack runs: the public time service of AWS. They are refused like any other name, by a
 * rule of their own, so that they do not count for the alarm. Exact names only, never a
 * wildcard: a name with a variable label would be a tunnel nobody watches.
 */
export const PACK_DNS_PLATFORM_NAMES = ["time.aws.com"];

/** Days the pack network keeps the DNS queries of its runtimes. */
export const PACK_DNS_QUERY_LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

/** The pack network of another stack of the same account, by its exports. */
export function importPackNetwork(ns: string, packs: Pick<ReleasePack, "id">[]): PackNetworkRef {
  return {
    subnetIds: Array.from({ length: PACK_NETWORK_ZONES }, (_, index) =>
      Fn.importValue(packNetworkExports.subnet(ns, index)),
    ),
    securityGroupIds: Object.fromEntries(
      packs.map((pack) => [pack.id, Fn.importValue(packNetworkExports.securityGroup(ns, pack.id))]),
    ),
    switchedPacks: switchedPacks(packs),
  };
}

export interface PackNetworkProps {
  readonly installation: Pick<Installation, "namespace" | "organizationId" | "packs">;
  /** Signed packs of the release: each one gets a security group built from its `egress`. */
  readonly packs: ReleasePack[];
  /**
   * Whether the packs that are not always on get a stack parameter that switches their network
   * (D54, 2026-11-13). Only `Mango-<ns>-PackNetwork` of a release has them. A Core that keeps
   * the network itself (a synthesis without release, D58) has every pack always on: Core's
   * stack tagger waits for every security group and rule of its stack, and `DependsOn` cannot
   * name a resource with a condition (D77, D58 (17)).
   */
  readonly switchable?: boolean;
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
 *   (no DNS tunnel). A VPC fails closed when the firewall cannot answer (the default). Every
 *   query of the VPC is logged with its name and what the firewall did with it.
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
  readonly switchedPacks: string[];
  /** Switched pack id -> the condition that its network is on. */
  readonly enabled: Record<string, CfnCondition> = {};

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

    // --- Switches: one stack parameter per pack whose network is not always on ------------
    const stack = Stack.of(this);
    this.switchedPacks = props.switchable === false ? [] : switchedPacks(props.packs);
    for (const packId of this.switchedPacks) {
      const name = packNetworkParameter(packId);
      // In the stack's scope, so that the logical id is the name the installer passes.
      const parameter = new CfnParameter(stack, name, {
        type: "String",
        default: PACK_NETWORK_DISABLED,
        allowedValues: [PACK_NETWORK_ENABLED, PACK_NETWORK_DISABLED],
        // Plain ASCII, like every parameter description (params.ts).
        description:
          `Network of the MCP pack ${packId}: Enabled creates its VPC endpoints (they are billed per hour) ` +
          "so that the pack can be enabled in the app. Disabled by default.",
      });
      this.enabled[packId] = new CfnCondition(stack, `${name}Enabled`, {
        expression: Fn.conditionEquals(parameter.valueAsString, PACK_NETWORK_ENABLED),
      });
      // What the pack provisioner reads before it installs the pack (fails closed without it).
      new ssm.StringParameter(this, `Switch-${packId}`, {
        parameterName: packNetworkSwitchName(ns, packId),
        // A path (it starts with `/`): the namespace may be a parameter of the release.
        simpleName: false,
        description: `Whether the network of the MCP pack ${packId} is on (stack parameter ${name})`,
        stringValue: parameter.valueAsString,
      });
    }

    // --- Interface endpoints: the declared AWS APIs and CloudWatch Logs -------------------
    const declared = [...new Set(props.packs.flatMap((pack) => pack.egress.aws))].sort();
    const services = new Map<string, (typeof PACK_EGRESS_SERVICES)[string]>();
    for (const service of [PLATFORM_SERVICE, ...declared]) {
      const known = PACK_EGRESS_SERVICES[service];
      if (known === undefined) throw new Error(`unknown pack egress service ${service}`);
      services.set(service, known);
    }
    // An endpoint exists while a pack that declares it has its network on. The platform
    // endpoint and those of an always-on pack have no condition, as before.
    const serviceConditions: Record<string, CfnCondition | undefined> = {};
    for (const service of services.keys()) {
      const users = props.packs.filter((pack) => pack.egress.aws.includes(service));
      // `this.enabled` only holds switched packs: without switches every endpoint is always on.
      if (service === PLATFORM_SERVICE || users.some((pack) => !(pack.id in this.enabled))) continue;
      const conditions = users.map((pack) => this.enabled[pack.id]!);
      if (conditions.length > 10) throw new Error(`more than 10 packs switch the endpoint of ${service}`);
      serviceConditions[service] =
        conditions.length === 1
          ? conditions[0]!
          : new CfnCondition(stack, `PackEndpoint${pascal(service)}Enabled`, {
              expression: Fn.conditionOr(...conditions),
            });
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
      const condition = serviceConditions[service];
      if (condition) {
        for (const resource of [group.node.defaultChild, vpcEndpoint.node.defaultChild] as CfnResource[]) {
          resource.cfnOptions.condition = condition;
        }
      }
      this.endpoints[service] = vpcEndpoint;
    }

    // --- One security group per pack: HTTPS to its endpoints, nothing else ----------------
    // A switched pack keeps its group (free, and Core imports it) with no way to its endpoints
    // while its network is off: only its own logs and S3, where AgentCore reads the code.
    const s3PrefixList = S3_PREFIX_LISTS[region];
    if (s3PrefixList === undefined) throw new Error(`no S3 prefix list is known for ${region}`);
    for (const pack of props.packs) {
      const group = new ec2.SecurityGroup(this, `PackSg-${pack.id}`, {
        vpc: this.vpc,
        description: `MCP pack ${pack.id}: HTTPS only to the VPC endpoints its signed manifest declares`,
        allowAllOutbound: false,
      });
      const switched = this.enabled[pack.id];
      for (const service of new Set([PLATFORM_SERVICE, ...pack.egress.aws])) {
        const peer = endpointGroups[service]!;
        const rules = added([group, peer], () => group.connections.allowTo(peer, HTTPS, `VPC endpoint of ${service}`));
        if (switched && service !== PLATFORM_SERVICE) {
          for (const rule of rules) rule.cfnOptions.condition = switched;
        }
      }
      group.addEgressRule(ec2.Peer.prefixList(s3PrefixList), HTTPS, "S3 gateway endpoint (runtime code)");
      Tags.of(group).add("mango:pack", pack.id);
      this.securityGroups[pack.id] = group;
    }

    // --- DNS Firewall: the names of the endpoints, nothing else ---------------------------
    const allowed = new route53resolver.CfnFirewallDomainList(this, "DnsAllowed", {
      name: mangoName(ns, "PackDnsAllowed"),
      domains: [
        ...[...services].flatMap(([service, { names }]) =>
          names(region).map((name) => ({ name: `${name}.`, when: serviceConditions[service] })),
        ),
        // AgentCore asks for its code bucket by the global S3 name and writes platform logs
        // by the regional one. Queries for these names only ever reach AWS.
        ...["*.s3.amazonaws.com.", `s3.${region}.amazonaws.com.`, `*.s3.${region}.amazonaws.com.`].map((name) => ({
          name,
          when: undefined,
        })),
      ]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        // The name of an endpoint that is off is not resolved either.
        .map(({ name, when }) => (when ? Fn.conditionIf(when.logicalId, name, Aws.NO_VALUE).toString() : name)),
    });
    if (PACK_DNS_PLATFORM_NAMES.some((name) => name.includes("*"))) {
      throw new Error("the platform names of the pack DNS Firewall are exact names, never wildcards");
    }
    const platform = new route53resolver.CfnFirewallDomainList(this, "DnsPlatform", {
      name: mangoName(ns, "PackDnsPlatform"),
      domains: PACK_DNS_PLATFORM_NAMES.map((name) => `${name}.`).sort(),
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
        // Same answer as the rule below. Apart, because the metric the alarm reads is per list:
        // what the platform always asks for is not what a pack has no reason to ask for.
        { priority: 150, action: "BLOCK", blockResponse: "NXDOMAIN", firewallDomainListId: platform.attrId },
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

    // --- DNS query log: which name was asked, and what the firewall answered --------------
    // The metric of the alarm below says that a name was refused, not which one. The names a
    // compromised pack asks for are the data it tries to take out: the log group is encrypted
    // and kept as long as the flow logs.
    const queryLogName = mangoName(ns, "PackNetwork-dns-queries");
    const queryLogArn = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:${queryLogName}`;
    const queryLog = new logs.LogGroup(this, "DnsQueries", {
      logGroupName: queryLogName,
      retention: PACK_DNS_QUERY_LOG_RETENTION,
      encryptionKey: logsKeyOf(this),
    });
    // The Resolver delivers through CloudWatch vended logs, which need a resource policy on
    // the log group. Declared here, scoped to this log group and this account: the template
    // does not rely on a policy the account happens to have, nor on the deploying principal
    // being allowed `logs:PutResourcePolicy`.
    const queryLogDelivery = new logs.CfnResourcePolicy(this, "DnsQueriesDeliveryPolicy", {
      policyName: mangoName(ns, "PackDnsQueriesDelivery"),
      policyDocument: stack.toJsonString({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PackDnsQueriesDelivery",
            Effect: "Allow",
            Principal: { Service: "delivery.logs.amazonaws.com" },
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `${queryLogArn}:log-stream:*`,
            Condition: {
              StringEquals: { "aws:SourceAccount": stack.account },
              ArnLike: {
                "aws:SourceArn": `arn:${stack.partition}:logs:${stack.region}:${stack.account}:*`,
              },
            },
          },
        ],
      }),
    });
    const queryLogging = new route53resolver.CfnResolverQueryLoggingConfig(this, "DnsQueryLogging", {
      name: queryLogName,
      destinationArn: `${queryLogArn}:*`,
    });
    queryLogging.addDependency(queryLog.node.defaultChild as logs.CfnLogGroup);
    queryLogging.addDependency(queryLogDelivery);
    new route53resolver.CfnResolverQueryLoggingConfigAssociation(this, "DnsQueryLoggingAssociation", {
      resolverQueryLogConfigId: queryLogging.attrId,
      resourceId: this.vpc.vpcId,
    });

    // TM-E2: a pack asked for a name that is not one of its endpoints. Nothing left the
    // network (the answer was NXDOMAIN); the alarm says that something tried. The topic is
    // named, not referenced: in a release it belongs to the Core stack, installed afterwards.
    const blocked = new cloudwatch.Alarm(this, "DnsBlockedAlarm", {
      alarmName: mangoName(ns, "PackDns-blocked"),
      alarmDescription:
        "The DNS Firewall of the pack network refused queries for names that are neither a VPC endpoint " +
        "nor what the AgentCore machine asks for by itself: code in a pack runtime asked for a name it has " +
        "no reason to reach (TM-E2, DNS tunnel). Nothing was resolved. Look first at the DNS query log of " +
        `the pack network (log group ${queryLogName}): the names with firewall_rule_action BLOCK outside ` +
        "the PackDnsPlatform list; then at which packs were in use at that time.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Route53Resolver",
        metricName: "FirewallRuleQueryVolume",
        dimensionsMap: { FirewallRuleGroupId: rules.attrId, FirewallDomainListId: everything.attrId },
        statistic: cloudwatch.Stats.SUM,
        period: Duration.minutes(5),
      }),
      threshold: PACK_DNS_BLOCKED_QUERIES,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    blocked.addAlarmAction(
      new cloudwatchActions.SnsAction(
        sns.Topic.fromTopicArn(
          this,
          "AlertsTopic",
          `arn:${stack.partition}:sns:${stack.region}:${stack.account}:${alertsTopicName(ns)}`,
        ),
      ),
    );
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
