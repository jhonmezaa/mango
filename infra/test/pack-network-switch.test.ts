import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ReleasePack } from "../lib/config/pack-release.js";
import {
  ALWAYS_ON_PACK_NETWORKS,
  importPackNetwork,
  PACK_EGRESS_SERVICES,
  PackNetwork,
  packNetworkParameter,
  packNetworkSwitchName,
  provisionerSetting,
  readSwitchesStatement,
  switchedPacks,
} from "../lib/constructs/pack-network.js";
import { LogsKey } from "../lib/logs.js";

/**
 * Endpoints switched per pack (precision of D54, proposed on 2026-11-13): the endpoints that
 * only new packs use exist only where an installation turns that pack's network on. The packs
 * of the earlier releases keep their network as it was.
 */

const NS = "test";
const ORG = "o-exampleorg1";
const REGION = "us-east-1";

type Resource = { Type: string; Properties?: any; Condition?: string; [k: string]: any };
interface TemplateJson {
  Parameters?: Record<string, { Type: string; Default?: string; AllowedValues?: string[]; Description?: string }>;
  Conditions?: Record<string, unknown>;
  Resources: Record<string, Resource>;
}

const pack = (id: string, aws: string[]) => ({ id, egress: { aws, hosts: [] } }) as unknown as ReleasePack;

/** The packs of the earlier releases, with their signed egress. */
const ALWAYS_ON = [
  pack("aws-pricing", ["pricing"]),
  pack("aws-billing", ["sts", "ce", "budgets", "compute-optimizer", "cost-optimization-hub"]),
  pack("aws-cloudwatch", ["sts", "cloudwatch", "logs"]),
];
/** New packs: `xray` is shared by two of them, `cloudwatch` with a pack that is always on. */
const SWITCHED = [
  pack("aws-rds", ["sts", "rds", "pi"]),
  pack("aws-application-signals", ["sts", "application-signals", "cloudwatch", "xray", "synthetics"]),
  pack("aws-ops", ["sts", "ec2", "xray"]),
];

function synth(packs: ReleasePack[]): TemplateJson {
  const app = new App({ analyticsReporting: false });
  const stack = new Stack(app, "PackNetwork", { env: { account: "111122223333", region: REGION } });
  new LogsKey(stack, { namespace: NS, retainData: true, name: "pack-network-logs" });
  new PackNetwork(stack, "PackNetwork", {
    installation: {
      namespace: NS,
      organizationId: ORG,
      packs: { network: { cidr: "10.210.0.0/22", availabilityZoneIds: ["use1-az1", "use1-az2"] } },
    } as never,
    packs,
  });
  return Template.fromStack(stack).toJSON() as TemplateJson;
}

const NO_VALUE = Symbol("AWS::NoValue");

/** The template as CloudFormation deploys it with `on` set to `Enabled` and the rest at their defaults. */
function deployed(template: TemplateJson, on: string[] = []): Record<string, Resource> {
  const parameter = (name: string) => {
    const declared = template.Parameters?.[name];
    expect(declared, name).toBeDefined();
    return on.includes(name) ? "Enabled" : declared!.Default;
  };
  const known: Record<string, boolean> = {};
  const condition = (name: string): boolean => (known[name] ??= evaluate(template.Conditions![name]));
  const evaluate = (expression: any): boolean => {
    if ("Fn::Equals" in expression) {
      const [a, b] = (expression["Fn::Equals"] as unknown[]).map((side: any) =>
        typeof side === "object" && side.Ref ? parameter(side.Ref) : side,
      );
      return a === b;
    }
    if ("Fn::Or" in expression) return (expression["Fn::Or"] as unknown[]).some((item) => evaluate(item));
    if ("Condition" in expression) return condition(expression.Condition);
    throw new Error(`condition not understood: ${JSON.stringify(expression)}`);
  };
  const walk = (value: any): any => {
    if (Array.isArray(value)) return value.map(walk).filter((item) => item !== NO_VALUE);
    if (value === null || typeof value !== "object") return value;
    if (value.Ref === "AWS::NoValue") return NO_VALUE;
    if ("Fn::If" in value) {
      const [name, yes, no] = value["Fn::If"];
      return walk(condition(name) ? yes : no);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
  };
  return Object.fromEntries(
    Object.entries(template.Resources)
      .filter(([, resource]) => resource.Condition === undefined || condition(resource.Condition))
      .map(([id, { Condition: _, ...resource }]) => [id, walk(resource) as Resource]),
  );
}

const ofType = (resources: Record<string, Resource>, type: string) =>
  Object.entries(resources).filter(([, resource]) => resource.Type === type);
const endpoints = (resources: Record<string, Resource>) =>
  ofType(resources, "AWS::EC2::VPCEndpoint")
    .map(([, resource]) => resource.Properties.ServiceName)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(`com.amazonaws.${REGION}.`, ""))
    .sort();
const domains = (resources: Record<string, Resource>) =>
  ofType(resources, "AWS::Route53Resolver::FirewallDomainList").find(
    ([, resource]) => resource.Properties.Name === `Mango-${NS}-PackDnsAllowed`,
  )![1].Properties.Domains as string[];
/** Ids of the endpoint groups a pack group may reach. */
const reaches = (resources: Record<string, Resource>, packId: string): string[] => {
  const [groupId] = ofType(resources, "AWS::EC2::SecurityGroup").find(
    ([id]) => id.startsWith(`PackNetworkPackSg${packId.replace(/-/g, "")}`),
  )!;
  return ofType(resources, "AWS::EC2::SecurityGroupEgress")
    .filter(([, rule]) => rule.Properties.GroupId["Fn::GetAtt"]?.[0] === groupId)
    // The other rule goes to the S3 prefix list (runtime code), switched or not.
    .filter(([, rule]) => rule.Properties.DestinationSecurityGroupId !== undefined)
    .map(([, rule]) => rule.Properties.DestinationSecurityGroupId["Fn::GetAtt"][0] as string)
    .map((id) => /^PackNetworkEndpointSg(.+)[0-9A-F]{8}$/.exec(id)![1]!)
    .sort();
};

const before = synth(ALWAYS_ON);
const after = synth([...ALWAYS_ON, ...SWITCHED]);

describe("pack network switched per pack (D54, proposed 2026-11-13)", () => {
  it("switches only the packs of this release onwards", () => {
    expect([...ALWAYS_ON_PACK_NETWORKS].sort()).toEqual(["aws-billing", "aws-cloudwatch", "aws-pricing"]);
    expect(switchedPacks([...ALWAYS_ON, ...SWITCHED])).toEqual(["aws-application-signals", "aws-ops", "aws-rds"]);
    expect(before.Parameters ?? {}).not.toHaveProperty("PackAwsPricingNetwork");
    expect(Object.keys(before.Conditions ?? {})).toEqual([]);
  });

  it("asks for one parameter per switched pack, off by default, in plain ASCII", () => {
    const names = Object.keys(after.Parameters ?? {}).filter((name) => name.startsWith("Pack"));
    expect(names.sort()).toEqual(["PackAwsApplicationSignalsNetwork", "PackAwsOpsNetwork", "PackAwsRdsNetwork"]);
    expect(packNetworkParameter("aws-rds")).toBe("PackAwsRdsNetwork");
    for (const name of names) {
      const parameter = after.Parameters![name]!;
      expect(parameter).toMatchObject({ Type: "String", Default: "Disabled", AllowedValues: ["Enabled", "Disabled"] });
      expect(parameter.Description).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("left at their defaults, an update changes nothing that was there and adds no endpoint", () => {
    const old = deployed(before);
    const now = deployed(after);
    // Every resource of the earlier release is still there, exactly as it was.
    for (const [id, resource] of Object.entries(old)) expect(now[id], id).toEqual(resource);
    // What is added costs nothing and reaches nothing: the security groups of the new packs,
    // the rules to their own logs, and the switches the provisioner reads.
    const added = Object.entries(now).filter(([id]) => !(id in old));
    expect([...new Set(added.map(([, resource]) => resource.Type))].sort()).toEqual([
      "AWS::EC2::SecurityGroup",
      "AWS::EC2::SecurityGroupEgress",
      "AWS::EC2::SecurityGroupIngress",
      "AWS::SSM::Parameter",
    ]);
    expect(endpoints(now)).toEqual(endpoints(old));
    expect(domains(now)).toEqual(domains(old));
    for (const packId of ["aws-rds", "aws-application-signals", "aws-ops"]) {
      expect(reaches(now, packId), packId).toEqual(["logs"]);
    }
  });

  it("turning one pack on creates its endpoints, its rules and its names, and nothing of the others", () => {
    const now = deployed(after, ["PackAwsRdsNetwork"]);
    const old = deployed(before);
    expect(endpoints(now)).toEqual([...endpoints(old), "pi", "rds"].sort());
    expect(reaches(now, "aws-rds")).toEqual(["logs", "pi", "rds", "sts"]);
    expect(reaches(now, "aws-ops")).toEqual(["logs"]);
    expect(domains(now)).toEqual(
      [...domains(old), `pi.${REGION}.amazonaws.com.`, `rds.${REGION}.amazonaws.com.`].sort(),
    );
    expect(domains(now).join()).not.toContain("ec2.");
  });

  it("keeps an endpoint two switched packs share while either is on", () => {
    const xray = (on: string[]) => endpoints(deployed(after, on)).includes("xray");
    expect(xray([])).toBe(false);
    expect(xray(["PackAwsOpsNetwork"])).toBe(true);
    expect(xray(["PackAwsApplicationSignalsNetwork"])).toBe(true);
    expect(xray(["PackAwsOpsNetwork", "PackAwsApplicationSignalsNetwork"])).toBe(true);
    // An endpoint a pack that is always on declares never depends on a switch.
    const cloudwatch = Object.values(after.Resources).find(
      (resource) => resource.Properties?.ServiceName === `com.amazonaws.${REGION}.monitoring`,
    )!;
    expect(cloudwatch.Condition).toBeUndefined();
    const all = deployed(after, ["PackAwsOpsNetwork", "PackAwsApplicationSignalsNetwork", "PackAwsRdsNetwork"]);
    expect(endpoints(all)).toEqual(
      [...endpoints(deployed(before)), "application-signals", "ec2", "pi", "rds", "synthetics", "xray"].sort(),
    );
    // A switched pack never reaches the endpoints of another, even with both on.
    expect(reaches(all, "aws-ops")).toEqual(["ec2", "logs", "sts", "xray"]);
  });

  it("tells the provisioner which packs are switched, and where their switch is", () => {
    const resources = deployed(after, ["PackAwsOpsNetwork"]);
    const switches = ofType(resources, "AWS::SSM::Parameter").map(([, resource]) => resource.Properties);
    expect(switches.map((p) => p.Name).sort()).toEqual(
      ["aws-application-signals", "aws-ops", "aws-rds"].map((id) => packNetworkSwitchName(NS, id)),
    );
    expect(packNetworkSwitchName(NS, "aws-ops")).toBe(`/Mango-${NS}-pack-network/aws-ops`);
    // The value is the parameter itself: what the installation chose, nothing else.
    for (const properties of switches) expect(properties.Value).toEqual({ Ref: expect.stringMatching(/^Pack.*Network$/) });
  });

  it("names every service of the catalog in the endpoints of a release that ships them all", () => {
    const every = synth([pack("aws-everything", Object.keys(PACK_EGRESS_SERVICES))]);
    const on = deployed(every, ["PackAwsEverythingNetwork"]);
    expect(endpoints(on)).toEqual(Object.values(PACK_EGRESS_SERVICES).map((service) => service.endpoint).sort());
  });
});

describe("what Core gets from a release's pack network (D58)", () => {
  const stack = new Stack(new App(), "Core", { env: { account: "111122223333", region: REGION } });
  const packs = [...ALWAYS_ON, ...SWITCHED];
  const imported = importPackNetwork(NS, packs);

  it("knows which packs are switched, from the release and not from the other stack", () => {
    expect(imported.switchedPacks).toEqual(["aws-application-signals", "aws-ops", "aws-rds"]);
    expect(importPackNetwork(NS, ALWAYS_ON).switchedPacks).toEqual([]);
  });

  it("tells the provisioner which packs are switched, and only when there are some", () => {
    const setting = JSON.stringify(stack.resolve(provisionerSetting(stack, imported)));
    expect(setting).toContain('\\"switched\\":[\\"aws-application-signals\\",\\"aws-ops\\",\\"aws-rds\\"]');
    expect(JSON.stringify(stack.resolve(provisionerSetting(stack, importPackNetwork(NS, ALWAYS_ON))))).not.toContain(
      "switched",
    );
  });

  it("lets the provisioner read the switch of each switched pack, and nothing else of SSM", () => {
    expect(readSwitchesStatement(stack, NS, importPackNetwork(NS, ALWAYS_ON))).toBeUndefined();
    const statement = stack.resolve(readSwitchesStatement(stack, NS, imported)!.toStatementJson());
    expect(statement).toEqual({
      Sid: "ReadPackNetworkSwitches",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: ["aws-application-signals", "aws-ops", "aws-rds"].map(
        (id) => `arn:aws:ssm:${REGION}:111122223333:parameter/Mango-${NS}-pack-network/${id}`,
      ),
    });
  });
});
