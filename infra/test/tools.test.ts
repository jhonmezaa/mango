import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { installationSchema, loadInstallation } from "../lib/config/schema.js";
import { GATEWAY_SESSION_SECONDS, orgWideTools } from "../lib/constructs/tools.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);

const TOOLS = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../connectors/cost-explorer/tool-schema.json"), "utf8"),
  ) as { name: string }[]
).map((t) => t.name);
const ORG_WIDE = ["get_savings_plans_utilization", "get_savings_plans_recommendation"];

/** Cedar statement of each L2 policy by name, with the gateway ARN token replaced. */
const policies = Object.fromEntries(
  Object.values(template.findResources("AWS::BedrockAgentCore::Policy")).map((r) => {
    const statement = r.Properties.Definition.Cedar.Statement as unknown;
    const text =
      typeof statement === "string"
        ? statement
        : (statement as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1]
            .map((part) => (typeof part === "string" ? part : "<gateway>"))
            .join("");
    return [r.Properties.Name as string, text];
  }),
);
const actionsOf = (statement: string) =>
  [...statement.matchAll(/AgentCore::Action::"finops___([a-z_]+)"/g)].map((m) => m[1]!).sort();
const condition = (statement: string) => /\) (?:when|unless) \{ (.*) \};$/s.exec(statement)![1]!;
const central = 'principal.getTag("mango_role") == "finops-central"';
const lead = 'principal.getTag("mango_role") == "bu-lead"';

describe("Gateway Cedar policies (L2)", () => {
  it("takes the organization-wide tools from the connector manifest", () => {
    expect(orgWideTools().sort()).toEqual([...ORG_WIDE].sort());
  });

  it("creates two permits and the matching forbids, and nothing else", () => {
    // Plus the pair of the write tools (D27, write-tools.test.ts).
    expect(Object.keys(policies).sort()).toEqual(
      [
        "FinopsOrgWide",
        "FinopsOrgWideForbidOthers",
        "FinopsRead",
        "FinopsReadForbidOthers",
        "WriteCentral",
        "WriteCentralForbidOthers",
      ].map((name) => `Mango_${ns}_${name}`),
    );
    for (const statement of Object.values(policies)) {
      expect(statement).toContain("principal is AgentCore::OAuthUser");
      expect(statement).toContain('resource == AgentCore::Gateway::"<gateway>"');
    }
  });

  it("covers every tool of the connector exactly once per effect", () => {
    const general = TOOLS.filter((t) => !ORG_WIDE.includes(t)).sort();
    expect(actionsOf(policies[`Mango_${ns}_FinopsRead`]!)).toEqual(general);
    expect(actionsOf(policies[`Mango_${ns}_FinopsReadForbidOthers`]!)).toEqual(general);
    expect(actionsOf(policies[`Mango_${ns}_FinopsOrgWide`]!)).toEqual([...ORG_WIDE].sort());
    expect(actionsOf(policies[`Mango_${ns}_FinopsOrgWideForbidOthers`]!)).toEqual([...ORG_WIDE].sort());
  });

  it("permits by role and forbids everyone else, so an added permit cannot widen access", () => {
    const read = policies[`Mango_${ns}_FinopsRead`]!;
    const orgWide = policies[`Mango_${ns}_FinopsOrgWide`]!;
    expect(read.startsWith("permit (")).toBe(true);
    expect(condition(read)).toBe(`principal.hasTag("mango_role") && (${central} || ${lead})`);
    expect(orgWide.startsWith("permit (")).toBe(true);
    expect(condition(orgWide)).toBe(`principal.hasTag("mango_role") && (${central})`);

    // Each forbid applies unless the exact condition of its permit holds: a user without
    // the role is denied whatever other policy exists (Cedar: forbid overrides permit).
    const forbidRead = policies[`Mango_${ns}_FinopsReadForbidOthers`]!;
    const forbidOrgWide = policies[`Mango_${ns}_FinopsOrgWideForbidOthers`]!;
    expect(forbidRead.startsWith("forbid (")).toBe(true);
    expect(forbidRead).toContain(") unless {");
    expect(condition(forbidRead)).toBe(condition(read));
    expect(forbidOrgWide.startsWith("forbid (")).toBe(true);
    expect(forbidOrgWide).toContain(") unless {");
    expect(condition(forbidOrgWide)).toBe(condition(orgWide));
    expect(read).toContain(") when {");
    expect(orgWide).toContain(") when {");
    // An area lead never reaches the organization-wide tools.
    expect(condition(forbidOrgWide)).not.toContain("bu-lead");
  });

  it("keeps the engine enforcing", () => {
    const [gateway] = Object.values(template.findResources("AWS::BedrockAgentCore::Gateway"));
    expect(gateway!.Properties.PolicyEngineConfiguration.Mode).toBe("ENFORCE");
  });
});

describe("Gateway MCP sessions (D47)", () => {
  const gatewayOf = (t: Template) =>
    Object.values(t.findResources("AWS::BedrockAgentCore::Gateway"))[0]!.Properties;

  it("keeps a session per target, for the shortest time AgentCore allows", () => {
    expect(cfg.gateway.mcpSessions).toBe(true);
    expect(gatewayOf(template).ProtocolConfiguration).toEqual({
      Mcp: { SessionConfiguration: { SessionTimeoutInSeconds: 900 } },
    });
    // Longer than any invocation: 600 s at most, plus the 60 s of its signature.
    expect(GATEWAY_SESSION_SECONDS).toBeGreaterThanOrEqual(660);
  });

  it("does not change who may call the Gateway or what it enforces", () => {
    const gateway = gatewayOf(template);
    expect(gateway.AuthorizerType).toBe("CUSTOM_JWT");
    expect(gateway.InterceptorConfigurations).toHaveLength(1);
    expect(gateway.InterceptorConfigurations[0].InterceptionPoints).toEqual(["REQUEST"]);
    // A target that propagated `Mcp-Session-Id` itself would be refused with sessions on.
    for (const target of Object.values(template.findResources("AWS::BedrockAgentCore::GatewayTarget"))) {
      expect(target.Properties.MetadataConfiguration).toBeUndefined();
    }
  });

  it("can be turned off by configuration, which leaves the Gateway without sessions", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../config/example.json"), "utf8"),
    ) as Record<string, unknown>;
    const off = installationSchema.parse({ ...raw, gateway: { mcpSessions: false } });
    const stateless = Template.fromStack(
      new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
        installation: off,
        env: { account: off.mangoAccountId, region: off.region },
      }),
    );
    expect(gatewayOf(stateless).ProtocolConfiguration).toBeUndefined();
    expect(installationSchema.safeParse({ ...raw, gateway: { sessions: true } }).success).toBe(false);
  });
});
