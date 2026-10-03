import { Aspects, CfnOutput, CfnParameter, Fn, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AGENTCORE_VPC_ZONE_IDS } from "../config/schema.js";
import { PACK_NETWORK_ZONES, PackNetwork, packNetworkExports } from "../constructs/pack-network.js";
import { loadPackRelease } from "../constructs/pack-platform.js";
import { CheckovSuppressions } from "../checkov.js";
import { GuardSuppressions } from "../guard.js";
import { LogsKey, ShortKeyDeletionWindow } from "../logs.js";
import { namespaceParameter, organizationIdParameter, tagNamespace } from "../params.js";
import { noBootstrapSynthesizer } from "./member-stack.js";

/** Private range of the pack network. It is peered with nothing, so one range fits everyone. */
const PACK_VPC_CIDR = "10.210.0.0/22";

/**
 * `Mango-<ns>-PackNetwork`, in the Mango account: the network of the MCP pack runtimes (R6,
 * D54), in a stack of its own (D58).
 *
 * AgentCore keeps network interfaces in these subnets for hours after a runtime is deleted.
 * In `Core` that blocked the whole uninstallation; here only this stack waits. `Core` imports
 * the subnets and each pack's security group, so CloudFormation refuses to delete this stack
 * while `Core` exists: install it before `Core`, delete it after.
 *
 * Built from the signed manifests of the release, like before. Its only asset is the CDK
 * function that empties the default security group of the VPC, read from the release store.
 */
export class PackNetworkStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, { synthesizer: noBootstrapSynthesizer(), ...props });
    const namespace = namespaceParameter(this);
    const organizationId = organizationIdParameter(this);
    const zoneIds = new CfnParameter(this, "AvailabilityZoneIds", {
      type: "CommaDelimitedList",
      default: "use1-az1,use1-az2",
      description: "Two Availability Zone ids (not names) where AgentCore Runtime supports VPC mode.",
      // CloudFormation checks the pattern against each element of the list.
      allowedPattern: `^(${AGENTCORE_VPC_ZONE_IDS.join("|")})$`,
      constraintDescription: `must be two of ${AGENTCORE_VPC_ZONE_IDS.join(", ")}, separated by a comma`,
    });
    tagNamespace(this, namespace);
    // The flow logs of the pack network are evidence: retained like every log of the installation.
    new LogsKey(this, { namespace, retainData: true, name: "pack-network-logs" });

    type ZoneId = (typeof AGENTCORE_VPC_ZONE_IDS)[number];
    const availabilityZoneIds = Array.from(
      { length: PACK_NETWORK_ZONES },
      (_, index) => Fn.select(index, zoneIds.valueAsList) as ZoneId,
    );
    const packs = { network: { cidr: PACK_VPC_CIDR, availabilityZoneIds } };
    const release = loadPackRelease(this, { packs });
    const network = new PackNetwork(this, "PackNetwork", {
      installation: { namespace, organizationId, packs },
      packs: release.packs,
    });

    network.subnetIds.forEach((subnetId, index) => {
      new CfnOutput(this, `Subnet${index + 1}`, {
        value: subnetId,
        exportName: packNetworkExports.subnet(namespace, index),
      });
    });
    for (const [pack, groupId] of Object.entries(network.securityGroupIds)) {
      new CfnOutput(this, `SecurityGroup${pack.replace(/[^A-Za-z0-9]/g, "")}`, {
        value: groupId,
        exportName: packNetworkExports.securityGroup(namespace, pack),
      });
    }

    Aspects.of(this).add(new ShortKeyDeletionWindow());
    Aspects.of(this).add(new GuardSuppressions());
    Aspects.of(this).add(new CheckovSuppressions());
  }
}
