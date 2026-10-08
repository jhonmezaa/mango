import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Fn, Stack, Token } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadReleaseDefaults } from "../lib/config/release.js";
import { releaseConfigJson, spaAuthConfigSchema } from "../lib/constructs/edge.js";
import { importPackNetwork, packNetworkExports } from "../lib/constructs/pack-network.js";
import { releaseSynthesizer, UNPUBLISHED_TARGET } from "../lib/release-target.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { PackNetworkStack } from "../lib/stacks/pack-network-stack.js";
import { instantiate, Values } from "./parameters.js";

/* The Core template of a release (D58; customer-distribution-threat-model.md): one template
 * for every customer, with the installation's values as stack parameters. */

interface Parameter {
  Type: string;
  Default?: string | number;
  AllowedPattern?: string;
  AllowedValues?: string[];
}
interface Resource {
  Type: string;
  Condition?: string;
  Properties: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
interface TemplateJson {
  Parameters: Record<string, Parameter>;
  Rules: Record<string, { Assertions: { Assert: unknown }[] }>;
  Conditions: Record<string, unknown>;
  Resources: Record<string, Resource>;
}

// No signed packs, whatever `dist/packs` holds on this machine.
const context = { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) };
const source = Template.fromStack(
  new CoreStack(new App({ context }), "Core", { env: { region: "us-east-1" } }),
).toJSON() as TemplateJson;
const text = JSON.stringify(source);
const ofType = (type: string) => Object.values(source.Resources).filter((r) => r.Type === type);

const REQUIRED = ["AlertsEmail", "FirstAdminEmail", "ManagementAccountId", "Namespace", "OrganizationId", "SignUpDomains"];
const WITH_DEFAULT = [
  "AiPolicyUrl",
  "AuditLockMode",
  "AuditRetentionDays",
  "AvailabilityZoneIds",
  "HighRiskSignInAction",
  "MemberAccessExcludedAccountIds",
  "MemberAccessTargets",
  "SecondAdminEmail",
  "TransactionSearch",
];

describe("Core template of a release", () => {
  it("asks for six values and offers a default for the rest", () => {
    // `BootstrapVersion` only appears with the CDK default synthesizer (this test); a release has none.
    const own = Object.keys(source.Parameters).filter((name) => name !== "BootstrapVersion");
    expect(own.sort()).toEqual([...REQUIRED, ...WITH_DEFAULT].sort());
    for (const name of REQUIRED) expect(source.Parameters[name]!.Default).toBeUndefined();
    for (const name of WITH_DEFAULT) expect(source.Parameters[name]!.Default).toBeDefined();
  });

  it("validates every free-text parameter with an anchored pattern", () => {
    for (const [name, parameter] of Object.entries(source.Parameters)) {
      if (name === "BootstrapVersion" || parameter.Type === "Number" || parameter.AllowedValues) continue;
      expect(parameter.AllowedPattern, name).toMatch(/^\^.*\$$/);
    }
  });

  it("writes no customer, account, organization, zone name or person into the template", () => {
    // The only account ids are AWS's own: Elastic Load Balancing log delivery in us-east-1.
    // Twelve digits inside a longer token are not an account id: asset hashes are hex and now
    // and then contain such a run, which made this assertion fail by chance.
    expect([...new Set(text.match(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g))]).toEqual(["127311923021"]);
    expect(text).not.toMatch(/o-[a-z0-9]{10,32}"/);
    expect(text).not.toMatch(/"(ou|r)-[0-9a-z]{4,}/);
    expect(text).not.toMatch(/us-east-1[a-f]\b/);
    expect(text).not.toContain("Fn::GetAZs");
    expect(text).not.toMatch(/Mango-[a-z0-9]{3,8}-Core/);
    expect(text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/g) ?? []).toEqual([]);
  });

  it("only installs as a customer installation: MFA required, Cognito Plus, data retained", () => {
    const pool = ofType("AWS::Cognito::UserPool")[0]!;
    expect(pool.Properties.MfaConfiguration).toBe("ON");
    expect(pool.Properties.UserPoolTier).toBe("PLUS");
    expect(pool.Properties.DeletionProtection).toBe("ACTIVE");
    for (const table of ofType("AWS::DynamoDB::GlobalTable")) {
      expect(JSON.stringify(table.Properties.Replicas)).toContain('"DeletionProtectionEnabled":true');
    }
  });

  it("lets the stack delete the policy store: it holds nothing but this template's schema and policies (D58 (14))", () => {
    const stores = Object.values(source.Resources).filter((r) => r.Type === "AWS::VerifiedPermissions::PolicyStore") as (Resource & {
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
    })[];
    expect(stores).toHaveLength(1);
    // Explicit, so that updating an installation that has it enabled turns it off.
    expect(stores[0]!.Properties.DeletionProtection).toEqual({ Mode: "DISABLED" });
    expect(stores[0]!.DeletionPolicy).toBeUndefined();
    expect(stores[0]!.UpdateReplacePolicy).toBeUndefined();
    // Why it needs no protection: no role of the stack can write to it, only ask it.
    const onStore = text.match(/verifiedpermissions:\w+/g) ?? [];
    expect([...new Set(onStore)]).toEqual(["verifiedpermissions:IsAuthorized"]);
    expect(ofType("AWS::VerifiedPermissions::Policy").length).toBeGreaterThan(0);
  });

  it("refuses the management account and another Region before creating anything", () => {
    expect(source.Rules.ManagementAccountIsAnother!.Assertions[0]!.Assert).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "ManagementAccountId" }, { Ref: "AWS::AccountId" }] }],
    });
    expect(source.Rules.SupportedRegion!.Assertions[0]!.Assert).toEqual({
      "Fn::Equals": [{ Ref: "AWS::Region" }, "us-east-1"],
    });
  });

  it("places every subnet by Availability Zone id, from the parameter", () => {
    const zones = ofType("AWS::EC2::Subnet").map((subnet) => {
      expect(subnet.Properties.AvailabilityZone).toBeUndefined();
      return JSON.stringify(subnet.Properties.AvailabilityZoneId);
    });
    const select = (index: number) => JSON.stringify({ "Fn::Select": [index, { Ref: "AvailabilityZoneIds" }] });
    expect(zones.sort()).toEqual([select(0), select(0), select(1), select(1)]);
    expect(new RegExp(source.Parameters.AvailabilityZoneIds!.AllowedPattern!).test("use1-az3")).toBe(false);
  });

  it("creates the first administrator, and a second one only when it is named", () => {
    const users = Object.values(source.Resources).filter((r) => r.Type === "AWS::Cognito::UserPoolUser");
    expect(users.map((u) => [u.Properties.Username, u.Condition])).toEqual([
      [{ Ref: "FirstAdminEmail" }, undefined],
      [{ Ref: "SecondAdminEmail" }, "HasSecondAdmin"],
    ]);
    const memberships = ofType("AWS::Cognito::UserPoolUserToGroupAttachment").map((a) => [
      a.Properties.Username.Ref,
      a.Properties.GroupName,
      a.Condition,
    ]);
    expect(memberships.sort()).toEqual([
      ["FirstAdminEmail", "finops-central", undefined],
      ["FirstAdminEmail", "mango-admin", undefined],
      ["SecondAdminEmail", "finops-central", "HasSecondAdmin"],
      ["SecondAdminEmail", "mango-admin", "HasSecondAdmin"],
    ]);
    // Only the groups Mango itself needs: areas and access groups are created in the app.
    expect(ofType("AWS::Cognito::UserPoolGroup").map((g) => g.Properties.GroupName).sort()).toEqual([
      "bu-lead",
      "finops-central",
      "mango-admin",
      "mango-agent-creator",
    ]);
  });

  it("locks the audit trail for the days and in the mode given at deployment", () => {
    const locked = ofType("AWS::S3::Bucket").filter((b) => b.Properties.ObjectLockEnabled === true);
    expect(locked).toHaveLength(1);
    expect(locked[0]!.Properties.ObjectLockConfiguration.Rule.DefaultRetention).toEqual({
      Days: { Ref: "AuditRetentionDays" },
      Mode: { Ref: "AuditLockMode" },
    });
    expect(source.Parameters.AuditLockMode!.Default).toBe("GOVERNANCE");
  });

  it("turns Transaction Search on only when the stack owns that account setting", () => {
    expect(ofType("AWS::XRay::TransactionSearchConfig").map((r) => r.Condition)).toEqual(["OwnsTransactionSearch"]);
  });

  it("seeds the defaults of the release, never values of a customer", () => {
    const defaults = loadReleaseDefaults();
    expect(defaults.budgets).toEqual({ userMonthlyUsd: 5, agentMonthlyUsd: 30 });
    expect(text).toContain(`\\"user_monthly_usd\\":{\\"N\\":\\"${defaults.budgets.userMonthlyUsd}\\"}`);
    // No area is mapped to an OU until an administrator does it in the app.
    expect(text).toContain('\\"units\\":{\\"S\\":\\"{}\\"}');
  });

  it("tells mango-api the label of the release, which is what Settings > Installation shows", () => {
    const label = "v0.1.0-g1a2b3c4";
    const published = Template.fromStack(
      new CoreStack(new App({ context }), "Core", {
        env: { region: "us-east-1" },
        release: { ...UNPUBLISHED_TARGET, label },
      }),
    ).toJSON() as TemplateJson;
    const variables = (template: TemplateJson) =>
      Object.values(template.Resources)
        .filter((r) => r.Type === "AWS::ECS::TaskDefinition")
        .flatMap((r) => r.Properties.ContainerDefinitions as { Environment?: { Name: string; Value: unknown }[] }[])
        .flatMap((c) => c.Environment ?? []);
    expect(variables(published).filter((v) => v.Name === "MANGO_RELEASE")).toEqual([{ Name: "MANGO_RELEASE", Value: label }]);
    // Without a published target there is no label to show.
    expect(variables(source).filter((v) => v.Name === "MANGO_RELEASE")).toEqual([]);
  });

  it("changes nothing but that label between two releases of the same code (D69)", () => {
    const release = (label: string) => {
      const target = { ...UNPUBLISHED_TARGET, label };
      const stack = new CoreStack(new App({ context }), "Core", {
        env: { region: "us-east-1" },
        synthesizer: releaseSynthesizer(target),
        release: target,
      });
      return JSON.stringify(Template.fromStack(stack).toJSON());
    };
    const [first, second] = [release("v0.1.0-g1a2b3c4"), release("v0.1.1")];
    // Assets are named after their content under one prefix: no key carries the label, so a
    // Lambda, a layer or a file deployment whose content did not change is not touched.
    const keys = [...first!.matchAll(/"(?:S3Key|SourceObjectKeys)":(\[[^\]]*\]|"[^"]*")/g)].flatMap((m) => m[1]!.match(/[^"[\],]+/g)!);
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) expect(key).toMatch(/^mango\/assets\/[0-9a-f]{64}\.zip$/);
    expect(first!.split("v0.1.0-g1a2b3c4")).toHaveLength(2);
    expect(first!.replace("v0.1.0-g1a2b3c4", "v0.1.1")).toBe(second);
  });
});

describe("config.json of the SPA in a release", () => {
  const deployment = Object.values(source.Resources).find(
    (r) => r.Type === "Custom::CDKBucketDeployment" && JSON.stringify(r.Properties.SourceMarkers ?? []).includes("SignUpDomains"),
  )!;
  const markers = (deployment.Properties.SourceMarkers as Record<string, unknown>[]).find((m) => Object.keys(m).length)!;

  const policyMember = Object.values(markers).find((value) => JSON.stringify(value).includes("HasAiPolicyUrl"))!;

  /** The file CloudFormation would write for these parameter values. */
  function configJson(values: Values): Record<string, unknown> {
    const body = new Stack().resolve(
      releaseConfigJson({
        region: "us-east-1",
        cognitoDomain: "https://mango-acme-111111111111.auth.us-east-1.amazoncognito.com",
        userPoolId: "us-east-1_Example1",
        clientId: "exampleclientid",
        apiBasePath: "/api",
        auth: { installationType: "customer", mfa: "required", sessionHours: 12 },
        // The two deploy-time values, exactly as the template carries them.
        deployTime: { signUpDomains: Fn.ref("SignUpDomains"), aiPolicyUrlMember: Token.asString(policyMember) },
      }),
    ) as unknown;
    return JSON.parse(instantiate(body, values) as string) as Record<string, unknown>;
  }

  it("lists every sign-up domain and carries the policy URL only when one was given", () => {
    const withPolicy = configJson({
      SignUpDomains: "empresa.com,ventas.empresa.com",
      AiPolicyUrl: "https://intranet.empresa.com/politica-ia",
      "Condition:HasAiPolicyUrl": "true",
    });
    expect(withPolicy.signUpDomains).toEqual(["empresa.com", "ventas.empresa.com"]);
    expect(withPolicy.aiPolicyUrl).toBe("https://intranet.empresa.com/politica-ia");
    expect(spaAuthConfigSchema.safeParse(withPolicy.auth).success).toBe(true);

    const without = configJson({ SignUpDomains: "empresa.com", AiPolicyUrl: "", "Condition:HasAiPolicyUrl": "false" });
    expect(without.signUpDomains).toEqual(["empresa.com"]);
    expect(without).not.toHaveProperty("aiPolicyUrl");
  });

  it("only takes values that cannot break out of the JSON text", () => {
    const domains = new RegExp(source.Parameters.SignUpDomains!.AllowedPattern!);
    const url = new RegExp(source.Parameters.AiPolicyUrl!.AllowedPattern!);
    expect("empresa.com,ventas.empresa.com").toMatch(domains);
    expect("https://intranet.empresa.com/politica-ia?v=2#uso").toMatch(url);
    expect("").toMatch(url);
    for (const bad of ['empresa.com","x":"y', "empresa.com, otra.com", "EMPRESA.com", "empresa.com\\", "*"]) {
      expect(bad).not.toMatch(domains);
    }
    for (const bad of ['https://a.com/"x', "https://a.com/\\", "http://a.com", "https://user:pw@a.com", "javascript:alert(1)", "https://a.com/ x"]) {
      expect(bad).not.toMatch(url);
    }
  });
});

describe("pack network of a release, in its own stack", () => {
  const network = Template.fromStack(
    new PackNetworkStack(new App({ context }), "PackNetwork", { env: { region: "us-east-1" } }),
  ).toJSON() as TemplateJson & { Outputs: Record<string, { Export: { Name: unknown } }> };

  it("asks for the namespace, the organization and the zones, and writes no customer value", () => {
    expect(Object.keys(network.Parameters).sort()).toEqual(["AvailabilityZoneIds", "Namespace", "OrganizationId"]);
    const whole = JSON.stringify(network);
    expect(whole).not.toMatch(/o-[a-z0-9]{10,32}"/);
    expect(whole).not.toContain("BootstrapVersion");
  });

  it("has no way out: no internet gateway, no NAT, and subnets placed by zone id", () => {
    const types = Object.values(network.Resources).map((r) => r.Type);
    expect(types).not.toContain("AWS::EC2::InternetGateway");
    expect(types).not.toContain("AWS::EC2::NatGateway");
    const subnets = Object.values(network.Resources).filter((r) => r.Type === "AWS::EC2::Subnet");
    expect(subnets.map((s) => s.Properties.AvailabilityZoneId)).toEqual([
      { "Fn::Select": [0, { Ref: "AvailabilityZoneIds" }] },
      { "Fn::Select": [1, { Ref: "AvailabilityZoneIds" }] },
    ]);
  });

  it("exports what Core imports, under names of the installation", () => {
    const names = Object.values(network.Outputs).map((o) => instantiate(o.Export.Name, { Namespace: "acme" }));
    expect(names).toEqual(["Mango-acme-PackNetwork-Subnet1", "Mango-acme-PackNetwork-Subnet2"]);
    const stack = new Stack();
    const imported = stack.resolve(importPackNetwork("acme", [{ id: "aws-pricing" }])) as unknown;
    expect(imported).toEqual({
      subnetIds: names.map((name) => ({ "Fn::ImportValue": name })),
      securityGroupIds: { "aws-pricing": { "Fn::ImportValue": "Mango-acme-PackNetwork-SecurityGroup-aws-pricing" } },
    });
    expect(packNetworkExports.securityGroup("acme", "aws-pricing")).toBe("Mango-acme-PackNetwork-SecurityGroup-aws-pricing");
  });

  it("is not part of Core in a release: Core holds one VPC, the one of mango-api", () => {
    expect(ofType("AWS::EC2::VPC")).toHaveLength(1);
    expect(ofType("AWS::Route53Resolver::FirewallRuleGroup")).toHaveLength(0);
  });
});

describe("uninstall guard (TM-D13, TM-D14)", () => {
  const [guardId, guard] = Object.entries(source.Resources).find(([, r]) => r.Type === "Custom::MangoUninstallGuard")! as [
    string,
    Resource & { DependsOn: string[] },
  ];
  const role = Object.entries(source.Resources).find(
    ([, r]) => r.Type === "AWS::IAM::Role" && JSON.stringify(r.Properties.RoleName ?? "").includes("-UninstallGuard"),
  )!;
  const statements = Object.values(source.Resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(role[0]))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as { Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown }[]);
  const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

  it("has nothing an update could change: only CloudFormation's own properties", () => {
    expect(guardId).toMatch(/^UninstallGuard/);
    expect(Object.keys(guard.Properties).sort()).toEqual(["ServiceTimeout", "ServiceToken"]);
  });

  // D58 (16): CloudFormation does not delete what a resource that failed to delete depends on.
  // With every other resource as a dependency, a guard that fails leaves the installation
  // standing; on 2026-10-07 it depended on 58 resources and the other 194 were deleted.
  const others = Object.entries(source.Resources).filter(([id, r]) => id !== guardId && r.Type !== "AWS::CDK::Metadata");
  const conditional = others.filter(([, r]) => r.Condition !== undefined);

  it("depends on every other resource of the stack: a new one cannot be left out", () => {
    const expected = others.filter(([, r]) => r.Condition === undefined).map(([id]) => id);
    expect(expected.length).toBeGreaterThan(250);
    expect([...guard.DependsOn].sort()).toEqual(expected.sort());
    // What agents and packs hold on to, the application, its provisioners, the directory,
    // the edge and the alarms: all of it outlives a guard that fails.
    const types = new Set(guard.DependsOn.map((id) => source.Resources[id]!.Type));
    for (const type of [
      "AWS::IAM::ManagedPolicy",
      "AWS::BedrockAgentCore::Gateway",
      "AWS::BedrockAgentCore::PolicyEngine",
      "AWS::ECS::Service",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "AWS::StepFunctions::StateMachine",
      "AWS::Cognito::UserPoolDomain",
      "AWS::Cognito::UserPoolUser",
      "AWS::CloudFront::Distribution",
      "AWS::CloudWatch::Alarm",
      "AWS::VerifiedPermissions::Policy",
    ]) {
      expect(types, type).toContain(type);
    }
    expect(guard.DependsOn).toContain(role[0]);
  });

  it("leaves out only the resources with a condition, and these are all of them", () => {
    // CloudFormation rejects a template whose `DependsOn` names a resource its condition
    // leaves out ("Unresolved resource dependencies", seen on 2026-10-08): with one of these
    // in the list, the stack could not be created with that condition false. A new
    // conditional resource has to be added here on purpose.
    expect(conditional.map(([, r]) => `${r.Condition} ${r.Type}`).sort()).toEqual([
      "HasSecondAdmin AWS::Cognito::UserPoolUser",
      "HasSecondAdmin AWS::Cognito::UserPoolUserToGroupAttachment",
      "HasSecondAdmin AWS::Cognito::UserPoolUserToGroupAttachment",
      "OwnsTransactionSearch AWS::Logs::ResourcePolicy",
      "OwnsTransactionSearch AWS::XRay::TransactionSearchConfig",
    ]);
    for (const [id] of conditional) expect(guard.DependsOn).not.toContain(id);
    expect(guard.Condition).toBeUndefined();
  });

  it("is a dependency of nothing: no cycle, and nothing waits for it to be created", () => {
    const { [guardId]: _guard, ...rest } = source.Resources;
    expect(JSON.stringify(rest)).not.toContain(`"${guardId}"`);
    expect(JSON.stringify((source as unknown as { Outputs: unknown }).Outputs)).not.toContain(guardId);
  });

  it("only deletes, lists names and checks its own stack: it reads no data of the installation", () => {
    for (const action of actions) {
      expect(action).toMatch(
        /^(bedrock-agentcore:(Delete|List|GetAgentRuntime|ManageResourceScopedPolicy$)|iam:(Delete|GetRole|ListRole)|logs:(Delete|Describe|CreateLogStream|PutLogEvents)|cloudformation:DescribeStacks|lambda:InvokeFunction|kms:(Decrypt|GenerateDataKey)|xray:|sqs:SendMessage)/,
      );
    }
    for (const forbidden of ["dynamodb", "s3:", "secretsmanager", "bedrock-agentcore:GetHarness", "bedrock-agentcore:Invoke", "iam:Create", "iam:Put", "iam:Attach", "iam:PassRole"]) {
      expect(actions.some((a) => a.startsWith(forbidden))).toBe(false);
    }
  });

  it("may delete a pack's policy scoped to the Gateway, and gains nothing else on the Gateway (D58 (13))", () => {
    const gatewayArn = { "Fn::GetAtt": [expect.stringMatching(/Gateway/), "GatewayArn"] };
    expect(statements.find((s) => s.Sid === "DeletePackPoliciesScopedToGateway")).toEqual({
      Sid: "DeletePackPoliciesScopedToGateway",
      Effect: "Allow",
      Action: "bedrock-agentcore:ManageResourceScopedPolicy",
      Resource: gatewayArn,
    });
    // Everything the role may do on the Gateway: its pack targets, and that one authorization.
    const onGateway = statements.filter((s) => JSON.stringify(s.Resource).includes('"GatewayArn"'));
    expect(onGateway.map((s) => s.Sid).sort()).toEqual(["DeletePackPoliciesScopedToGateway", "DeletePackTargets"]);
    expect(onGateway.flatMap((s) => s.Action).sort()).toEqual([
      "bedrock-agentcore:DeleteGatewayTarget",
      "bedrock-agentcore:ListGatewayTargets",
      "bedrock-agentcore:ManageResourceScopedPolicy",
    ]);
    for (const statement of onGateway) expect(statement.Resource).toEqual(gatewayArn);
    // No policy can be written with it: the only policy operations are listing and deleting,
    // and deleting only policies named after a pack of this installation.
    expect(actions.filter((a) => /Polic/.test(a) && a.startsWith("bedrock-agentcore:")).sort()).toEqual([
      "bedrock-agentcore:DeletePolicy",
      "bedrock-agentcore:ListPolicies",
      "bedrock-agentcore:ManageResourceScopedPolicy",
    ]);
    for (const forbidden of ["bedrock-agentcore:GetGateway", "bedrock-agentcore:ManageAdminPolicy", "bedrock-agentcore:CreatePolicy", "bedrock-agentcore:UpdatePolicy"]) {
      expect(actions).not.toContain(forbidden);
    }
    const deletes = statements.find((s) => s.Sid === "DeletePackPolicies")!;
    expect(JSON.stringify(deletes.Resource)).toContain("/policy/Mango_");
    expect(JSON.stringify(deletes.Resource)).toContain("_mcp_*");
  });

  it("deletes roles only when they carry a Mango permissions boundary", () => {
    const deletes = statements.filter((s) => JSON.stringify(s.Action).includes("iam:DeleteRole"));
    expect(deletes).toHaveLength(1);
    expect(JSON.stringify(deletes[0]!.Condition)).toContain("iam:PermissionsBoundary");
    expect(JSON.stringify(deletes[0]!.Resource)).toMatch(/-agent-\*/);
    expect(JSON.stringify(deletes[0]!.Resource)).toMatch(/-mcp-\*/);
  });

  it("can only be invoked by CloudFormation and by itself", () => {
    const invoke = statements.find((s) => s.Sid === "KeepWaiting")!;
    expect(JSON.stringify(invoke.Resource)).toContain("-UninstallGuard");
    const permissions = Object.values(source.Resources).filter(
      (r) => r.Type === "AWS::Lambda::Permission" && JSON.stringify(r.Properties).includes("UninstallGuard"),
    );
    expect(permissions).toHaveLength(0);
  });
});
