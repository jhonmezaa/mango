import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { accessGroupRegistry } from "../lib/config/groups.js";
import { loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { payerTemplate } from "./parameters.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
// A release without signed packs, whatever `dist/packs` holds on this machine: a pack over
// account data adds its role to the broker trust (covered in packs.test.ts).
const noPacks = { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) };
const template = Template.fromStack(
  new CoreStack(new App({ context: noPacks }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: any }>;

function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

const settingsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: "Mango-poc-Settings" });
const probeFnId = logicalId("AWS::Lambda::Function", { FunctionName: "Mango-poc-AdminProbe" });
const probeRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-AdminProbe" });
const connectorRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-CostExplorerConnector" });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-ApiTask" });
const brokerId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-BillingBroker" });

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
interface Grant {
  roles: string[];
  statement: Statement;
}

/** Every identity-policy statement with the roles it is attached to. */
function grants(): Grant[] {
  const out: Grant[] = [];
  for (const r of Object.values(resources)) {
    if (r.Type !== "AWS::IAM::Policy") continue;
    const roles = (r.Properties.Roles ?? []).map((ref: { Ref: string }) => ref.Ref);
    for (const statement of r.Properties.PolicyDocument.Statement as Statement[]) {
      out.push({ roles, statement });
    }
  }
  return out;
}

const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const mentions = (s: Statement, id: string) => JSON.stringify(s.Resource ?? "").includes(`"${id}"`);
const WRITE_ACTIONS = /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/;

describe("Admin v0 infrastructure (D17)", () => {
  it("creates the Settings table encrypted, with PITR", () => {
    const table = resources[settingsId]!.Properties;
    expect(table.SSESpecification.SSEType).toBe("KMS");
    expect(table.Replicas[0].PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(table.Replicas[0].DeletionProtectionEnabled).toBe(true);
  });

  it("lets only mango-api write the Settings table (the seed may only put its own partition)", () => {
    const writers = grants().filter(
      (g) => mentions(g.statement, settingsId) && actions(g.statement).some((a) => WRITE_ACTIONS.test(a)),
    );
    expect(writers.length).toBeGreaterThan(0);
    const packProvisionerRoleId = Object.keys(
      template.findResources("AWS::IAM::Role", { Properties: { RoleName: "Mango-poc-PackProvisioner" } }),
    )[0]!;
    for (const { roles, statement } of writers) {
      if (roles.includes(apiRoleId)) continue;
      if (roles.includes(packProvisionerRoleId)) {
        // Pack provisioner (Marketplace v1): installation state of MCP packs only. It can
        // never reach the partitions that decide isolation or budgets (TM-A6).
        const keys = statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] as string[];
        expect(keys.length).toBe(1);
        expect(["MCP#*", "MCP_INSTALLED#*"]).toContain(keys[0]);
        continue;
      }
      // CDK custom resource provider (seed): PutItem only, one partition each.
      expect(actions(statement)).toEqual(["dynamodb:PutItem"]);
      const keys = statement.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:LeadingKeys"];
      expect(keys).toHaveLength(1);
      expect(["BUDGETS", "BU_MAPPING", "GROUPS", "MODELS"]).toContainEqual((keys as string[])[0]);
    }
    expect(writers.some((g) => g.roles.includes(connectorRoleId))).toBe(false);
    expect(writers.some((g) => g.roles.includes(probeRoleId))).toBe(false);
  });

  it("gives the connector GetItem on the mapping partition only", () => {
    const connector = grants().filter(
      (g) => g.roles.includes(connectorRoleId) && mentions(g.statement, settingsId),
    );
    expect(connector).toHaveLength(1);
    expect(actions(connector[0]!.statement)).toEqual(["dynamodb:GetItem"]);
    expect(connector[0]!.statement.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["BU_MAPPING"] },
    });
    const env = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === "Mango-poc-CostExplorerConnector",
    )!.Properties.Environment.Variables;
    expect(env.BUSINESS_UNITS).toBeUndefined();
    expect(env.SETTINGS_TABLE).toBeDefined();
  });

  it("lets only mango-api invoke the AdminProbe, on its ARN only", () => {
    const invokers = grants().filter(
      (g) => actions(g.statement).includes("lambda:InvokeFunction") && mentions(g.statement, probeFnId),
    );
    expect(invokers).toHaveLength(1);
    expect(invokers[0]!.roles).toEqual([apiRoleId]);
    expect(invokers[0]!.statement.Resource).toEqual({ "Fn::GetAtt": [probeFnId, "Arn"] });
    expect(Object.keys(template.findResources("AWS::Lambda::Permission"))
      .filter((id) => JSON.stringify(resources[id]).includes(probeFnId))).toEqual([]);
  });

  it("limits the AdminProbe role to assuming the brokers", () => {
    const probe = grants().filter((g) => g.roles.includes(probeRoleId));
    const sts = probe.filter((g) => actions(g.statement).some((a) => a.startsWith("sts:")));
    // The Billing broker (payer) and the Read broker (member accounts, §4.10): nothing else.
    expect(sts.map((g) => g.statement.Resource)).toEqual([
      { "Fn::GetAtt": [brokerId, "Arn"] },
      `arn:aws:iam::${cfg.mangoAccountId}:role/Mango-poc-ReadBroker`,
    ]);
    for (const { statement } of probe) {
      for (const action of actions(statement)) {
        expect(action).toMatch(/^(sts:(AssumeRole|SetSourceIdentity|TagSession)|logs:|xray:)/);
      }
    }
  });

  it("restricts the broker trust to the connector and the AdminProbe roles", () => {
    const trust = resources[brokerId]!.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust).toHaveLength(3);
    for (const statement of trust) {
      expect(statement.Condition?.ArnEquals?.["aws:PrincipalArn"]).toEqual([
        { "Fn::GetAtt": [connectorRoleId, "Arn"] },
        { "Fn::GetAtt": [probeRoleId, "Arn"] },
      ]);
    }
  });

  it("requires a SourceIdentity to assume the broker and the payer BillingReader (ADM-04)", () => {
    const payer = payerTemplate(cfg);
    const [readerId] = Object.keys(
      payer.findResources("AWS::IAM::Role", { Properties: { RoleName: "Mango-poc-BillingReader" } }),
    );
    const readerTrust = payer.toJSON().Resources[readerId!].Properties.AssumeRolePolicyDocument
      .Statement as Statement[];
    const brokerTrust = resources[brokerId]!.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    for (const trust of [brokerTrust, readerTrust]) {
      const assume = trust.filter((s) => actions(s).includes("sts:AssumeRole"));
      expect(assume).toHaveLength(1);
      expect(assume[0]!.Condition?.Null).toEqual({ "sts:SourceIdentity": "false" });
      const setIdentity = trust.find((s) => actions(s).includes("sts:SetSourceIdentity"));
      expect(setIdentity?.Condition?.StringLike).toEqual({ "sts:SourceIdentity": "*" });
      expect(trust.some((s) => actions(s).includes("sts:TagSession"))).toBe(true);
    }
    expect(readerTrust.every((s) => s.Condition?.StringEquals?.["aws:PrincipalOrgID"] === cfg.organizationId)).toBe(true);
  });

  it("scopes the seed's KMS use to DynamoDB (ADM-07)", () => {
    const seedKms = grants().filter(
      (g) =>
        actions(g.statement).includes("kms:GenerateDataKey") &&
        grants().some((o) => o.roles.join() === g.roles.join() && actions(o.statement).includes("dynamodb:PutItem")),
    );
    expect(seedKms.length).toBeGreaterThan(0);
    for (const { statement } of seedKms) {
      expect(statement.Condition?.StringEquals?.["kms:ViaService"]).toBe("dynamodb.us-east-1.amazonaws.com");
    }
  });

  it("lets admins and agent creators read the group registry, from token groups (D26)", () => {
    const [store] = Object.values(template.findResources("AWS::VerifiedPermissions::PolicyStore"));
    const schema = JSON.parse(store!.Properties.Schema.CedarJson);
    const user = schema.Mango.entityTypes.User.shape.attributes;
    // Optional only for tasks of the previous release during a rolling update.
    expect(user.groups).toEqual({ type: "Set", element: { type: "String" }, required: false });
    // A user may have groups without a FinOps role.
    expect(user.role.required).toBe(false);
    expect(schema.Mango.actions.ViewGroups.appliesTo).toEqual({
      principalTypes: ["User"],
      resourceTypes: ["Platform"],
    });
    const statements = Object.values(template.findResources("AWS::VerifiedPermissions::Policy")).map(
      (p) => p.Properties.Definition.Static.Statement as string,
    );
    const viewGroups = statements.filter((s) => s.includes('"ViewGroups"'));
    expect(viewGroups).toHaveLength(1);
    expect(viewGroups[0]).toContain(
      '(principal has groups && principal.groups.contains("mango-agent-creator"))',
    );
    expect(viewGroups[0]).toContain("principal.isAdmin ||");
  });

  it("lets only admins change the group registry (D26)", () => {
    const [store] = Object.values(template.findResources("AWS::VerifiedPermissions::PolicyStore"));
    const schema = JSON.parse(store!.Properties.Schema.CedarJson);
    for (const action of ["ProposeGroups", "ApproveGroups"]) {
      expect(schema.Mango.actions[action].appliesTo).toEqual({
        principalTypes: ["User"],
        resourceTypes: ["Platform"],
      });
    }
    const statements = Object.values(template.findResources("AWS::VerifiedPermissions::Policy")).map(
      (p) => p.Properties.Definition.Static.Statement as string,
    );
    const changeGroups = statements.filter((s) => s.includes('"ProposeGroups"') || s.includes('"ApproveGroups"'));
    expect(changeGroups).toHaveLength(1);
    expect(changeGroups[0]).toContain("when { principal.isAdmin };");
    expect(changeGroups[0]).not.toContain("mango-agent-creator");
  });

  it("registers the admin Cedar actions and policy", () => {
    const [store] = Object.values(template.findResources("AWS::VerifiedPermissions::PolicyStore"));
    const schema = JSON.parse(store!.Properties.Schema.CedarJson);
    for (const action of ["ViewAdmin", "ManageBudgets", "ProposeBusinessUnits", "ApproveBusinessUnits"]) {
      expect(schema.Mango.actions[action].appliesTo.resourceTypes).toEqual(["Platform"]);
    }
    const statements = Object.values(template.findResources("AWS::VerifiedPermissions::Policy")).map(
      (p) => p.Properties.Definition.Static.Statement as string,
    );
    const policyFiles = readdirSync(resolve(import.meta.dirname, "../../policies/cedar/platform")).filter(
      (f) => f.endsWith(".cedar"),
    );
    expect(statements).toHaveLength(policyFiles.length);
    const admin = statements.find((s) => s.includes('"ApproveBusinessUnits"'))!;
    expect(admin).toContain("when { principal.isAdmin }");
    expect(readFileSync(resolve(import.meta.dirname, "../../policies/cedar/platform/admin.cedar"), "utf8")).toBe(
      admin,
    );
  });

  it("seeds settings put-if-absent on create and update", () => {
    const seeds = Object.values(template.findResources("Custom::AWS")).filter((r) =>
      JSON.stringify(r.Properties.Create ?? "").includes("putItem"),
    );
    expect(seeds).toHaveLength(3);
    for (const seed of seeds) {
      for (const phase of ["Create", "Update"]) {
        const call = JSON.stringify(seed.Properties[phase]);
        expect(call).toContain("attribute_not_exists(PK)");
        expect(call).toContain("ConditionalCheckFailedException");
      }
      expect(seed.Properties.Delete).toBeUndefined();
    }
    const mapping = JSON.stringify(seeds.map((s) => s.Properties.Create));
    for (const ou of Object.values(cfg.businessUnits).flat()) expect(mapping).toContain(ou);
  });

  it("seeds the access group registry once, in one transaction (D26)", () => {
    const seeds = Object.values(template.findResources("Custom::AWS")).filter((r) => {
      const call = JSON.stringify(r.Properties.Create ?? "");
      return call.includes("transactWriteItems") && call.includes("GROUPS");
    });
    expect(seeds).toHaveLength(1);
    const seed = seeds[0]!;
    expect(seed.Properties.Delete).toBeUndefined();
    expect(JSON.stringify(seed.Properties.Update)).toBe(JSON.stringify(seed.Properties.Create));
    // The table name is a token, so `Create` is an Fn::Join of JSON fragments.
    const call = JSON.stringify(seed.Properties.Create);
    expect(call).toContain("TransactionCanceledException");
    const groups = accessGroupRegistry(cfg);
    expect(groups.map((g) => [g.id, g.type, g.area])).toEqual([
      ["bu-lead", "general", undefined],
      ["bu-sandbox", "area", "sandbox"],
      ["bu-security", "area", "security"],
      ["finops-central", "central", undefined],
      ["people", "general", undefined],
    ]);
    expect(call.match(/attribute_not_exists\(PK\)/g)).toHaveLength(groups.length);
    for (const group of groups) {
      expect(call).toContain(`\\"SK\\":{\\"S\\":\\"${group.id}\\"}`);
      expect(call).toContain(`\\"type\\":{\\"S\\":\\"${group.type}\\"}`);
    }
    // Permission groups are not access groups.
    expect(call).not.toContain("mango-admin");
    expect(call).not.toContain("mango-agent-creator");
  });

  it("passes the Settings table and AdminProbe to mango-api", () => {
    const [task] = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
    const names = (task!.Properties.ContainerDefinitions[0].Environment as { Name: string }[]).map((e) => e.Name);
    expect(names).toEqual(expect.arrayContaining(["SETTINGS_TABLE", "ADMIN_PROBE_FUNCTION"]));
  });
});
