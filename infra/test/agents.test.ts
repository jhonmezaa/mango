import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { installationSchema, loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));

function synth(installation = cfg) {
  const template = Template.fromStack(
    new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
      installation,
      env: { account: installation.mangoAccountId, region: installation.region },
    }),
  );
  return {
    template,
    resources: template.toJSON().Resources as Record<string, { Type: string; Properties: any; [k: string]: any }>,
  };
}

const { template, resources } = synth();

function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

const agentsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: "Mango-poc-Agents" });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-ApiTask" });
const agents = resources[agentsId]!;

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
}

/** Identity-policy statements that mention the Agents table, with the roles they attach to. */
function agentsGrants(): { roles: string[]; statement: Statement }[] {
  const out: { roles: string[]; statement: Statement }[] = [];
  for (const r of Object.values(resources)) {
    if (r.Type !== "AWS::IAM::Policy") continue;
    const roles = (r.Properties.Roles ?? []).map((ref: { Ref: string }) => ref.Ref);
    for (const statement of r.Properties.PolicyDocument.Statement as Statement[]) {
      if (JSON.stringify(statement.Resource ?? "").includes(`"${agentsId}"`)) out.push({ roles, statement });
    }
  }
  return out;
}

describe("Agents table (Marketplace v1, D18)", () => {
  it("carries the namespace and the PK/SK key schema", () => {
    expect(agents.Properties.TableName).toBe(`Mango-${cfg.namespace}-Agents`);
    expect(agents.Properties.KeySchema).toEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    expect(agents.Properties.BillingMode).toBe("PAY_PER_REQUEST");
  });

  it("is encrypted with the customer-managed data key, with PITR and deletion protection", () => {
    const keyId = logicalId("AWS::KMS::Alias", { AliasName: "alias/Mango-poc-data" });
    const keyRef = resources[keyId]!.Properties.TargetKeyId;
    expect(agents.Properties.SSESpecification.SSEType).toBe("KMS");
    const replica = agents.Properties.Replicas[0];
    expect(replica.SSESpecification.KMSMasterKeyId).toEqual(keyRef);
    expect(replica.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(replica.DeletionProtectionEnabled).toBe(true);
  });

  it("is retained when the stack is deleted", () => {
    expect(agents.DeletionPolicy).toBe("Retain");
    expect(agents.UpdateReplacePolicy).toBe("Retain");
  });

  it("is only disposable in the lab", () => {
    const lab = synth(
      installationSchema.parse({ ...cfg, installationType: "lab", retainData: false }),
    );
    const [table] = Object.values(
      lab.template.findResources("AWS::DynamoDB::GlobalTable", {
        Properties: { TableName: "Mango-poc-Agents" },
      }),
    );
    expect(table!.DeletionPolicy).toBe("Delete");
    // Encryption and PITR do not depend on the installation type.
    expect(table!.Properties.SSESpecification.SSEType).toBe("KMS");
    expect(table!.Properties.Replicas[0].PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
  });

  it("expires only items that carry a ttl (daily submission counters)", () => {
    expect(agents.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "ttl", Enabled: true });
  });

  it("has the two sparse indexes the repository queries", () => {
    const indexes = Object.fromEntries(
      (agents.Properties.GlobalSecondaryIndexes as { IndexName: string; KeySchema: unknown; Projection: unknown }[]).map(
        (i) => [i.IndexName, i],
      ),
    );
    expect(Object.keys(indexes).sort()).toEqual(["ByCreator", "ByStatus"]);
    expect(indexes.ByStatus!.KeySchema).toEqual([
      { AttributeName: "status_index", KeyType: "HASH" },
      { AttributeName: "status_at", KeyType: "RANGE" },
    ]);
    expect(indexes.ByCreator!.KeySchema).toEqual([
      { AttributeName: "creator_index", KeyType: "HASH" },
      { AttributeName: "created_at", KeyType: "RANGE" },
    ]);
  });

  it("lets mango-api use the table and its indexes by name, except the published pointer", () => {
    const grants = agentsGrants().filter((g) => g.roles.includes(apiRoleId));
    expect(grants.map((g) => g.statement.Sid).sort()).toEqual(["AgentsTable", "PublishedPointerIsProvisionerOnly"]);
    const { statement } = grants.find((g) => g.statement.Sid === "AgentsTable")!;
    expect(statement.Action).toEqual([
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    const arn = { "Fn::GetAtt": [agentsId, "Arn"] };
    expect(statement.Resource).toEqual([
      arn,
      { "Fn::Join": ["", [arn, "/index/ByStatus"]] },
      { "Fn::Join": ["", [arn, "/index/ByCreator"]] },
    ]);
    expect(JSON.stringify(statement.Resource)).not.toContain("*");
    expect(grants.find((g) => g.statement.Sid === "PublishedPointerIsProvisionerOnly")!.statement.Effect).toBe("Deny");
  });

  it("gives the table to nobody else but the provisioner, the deprovisioner, the reconciler and the release seed", () => {
    // Details in provisioner.test.ts, deprovisioner.test.ts, reconciler.test.ts and release-agents.test.ts.
    const provisionerRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-Provisioner" });
    const deprovisionerRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-Deprovisioner" });
    const reconcilerRoleId = logicalId("AWS::IAM::Role", { RoleName: "Mango-poc-Reconciler" });
    const others = agentsGrants().filter((g) => !g.roles.includes(apiRoleId));
    const sidsOf = (roleId: string) =>
      others.filter((g) => g.roles.length === 1 && g.roles[0] === roleId).map((g) => g.statement.Sid).sort();
    expect(sidsOf(provisionerRoleId)).toEqual(["ReadAgentVersions", "WritePublicationState", "WritePublishedPointer"]);
    expect(sidsOf(reconcilerRoleId)).toEqual(["ReadAgentRecordsWithoutContent"]);
    // D48: it reads the state of a retired agent and holds its lock; no content, no state change.
    expect(sidsOf(deprovisionerRoleId)).toEqual(["HoldAgentLock", "ReadAgentStateWithoutContent"]);
    // The only other grant: the stack's own seed of the release agents (put-if-absent).
    const known = [provisionerRoleId, deprovisionerRoleId, reconcilerRoleId];
    const rest = others.filter((g) => !g.roles.some((r) => known.includes(r)));
    expect(rest).toHaveLength(1);
    expect(rest[0]!.statement.Action).toBe("dynamodb:PutItem");
    expect(rest[0]!.roles).toHaveLength(1);
    expect(rest[0]!.roles[0]).toMatch(/^AWS679f53fac002430cb0da5b7982bd2287ServiceRole/);
    expect(others).toHaveLength(7);
  });

  it("passes the table name to mango-api", () => {
    const [task] = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
    const env = task!.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "AGENTS_TABLE")?.Value).toEqual({ Ref: agentsId });
  });
});

describe("Model catalog seed (rule 7, read-only Brains)", () => {
  const seeds = Object.values(template.findResources("Custom::AWS")).filter((r) =>
    JSON.stringify(r.Properties.Create ?? "").includes("MODELS"),
  );

  it("seeds the catalog put-if-absent on create and update, never on delete", () => {
    expect(seeds).toHaveLength(1);
    for (const phase of ["Create", "Update"]) {
      const call = JSON.stringify(seeds[0]!.Properties[phase]);
      expect(call).toContain("attribute_not_exists(PK)");
      expect(call).toContain("ConditionalCheckFailedException");
    }
    expect(seeds[0]!.Properties.Delete).toBeUndefined();
  });

  it("lists every priced model and enables only the agent model", () => {
    // The custom resource stores the SDK call as a JSON string (with a table-name token).
    const create = seeds[0]!.Properties.Create as { "Fn::Join": [string, unknown[]] };
    const raw = create["Fn::Join"][1].filter((part): part is string => typeof part === "string").join("");
    const escaped = /"models":\{"S":"((?:[^"\\]|\\.)*)"\}/.exec(raw);
    expect(escaped).not.toBeNull();
    const models = JSON.parse(JSON.parse(`"${escaped![1]}"`)) as Record<string, unknown>[];

    expect(models.map((m) => m.id).sort()).toEqual(Object.keys(cfg.modelPrices).sort());
    expect(models.filter((m) => m.enabled).map((m) => m.id)).toEqual([cfg.models.agent]);
    const agent = models.find((m) => m.id === cfg.models.agent)!;
    const price = cfg.modelPrices[cfg.models.agent]!;
    expect(agent).toEqual({
      id: cfg.models.agent,
      name: cfg.models.agent,
      provider: "anthropic",
      enabled: true,
      supports_tools: true,
      input_usd: String(price.input),
      output_usd: String(price.output),
      cache_read_usd: String(price.cacheRead),
      cache_write_usd: String(price.cacheWrite),
    });
  });
});

describe("Brains: model catalog administration (D38)", () => {
  const statements = Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .flatMap((r) =>
      (r.Properties.PolicyDocument.Statement as Statement[]).map((statement) => ({
        roles: (r.Properties.Roles ?? []).map((ref: { Ref: string }) => ref.Ref) as string[],
        statement,
      })),
    );

  it("lets only mango-api list Bedrock models, and nothing else of Bedrock's control plane", () => {
    const listing = statements.filter(({ statement }) => statement.Sid === "ListBedrockModels");
    expect(listing).toHaveLength(1);
    expect(listing[0]!.roles).toEqual([apiRoleId]);
    expect(listing[0]!.statement).toEqual({
      Sid: "ListBedrockModels",
      Effect: "Allow",
      Action: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
      Resource: "*",
    });
    const actions = statements.flatMap(({ statement }) => [statement.Action].flat());
    expect(actions.filter((a) => /^bedrock:(List|Get|Create|Put|Delete|Update)/.test(a)).sort()).toEqual([
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
    ]);
    expect(actions).not.toContain("bedrock:*");
  });

  it("keeps the model listing as the only `*` resource of the mango-api role", () => {
    // The cdk-nag acknowledgment on the role is granular by resource, not by action.
    const wildcards = statements.filter(
      ({ roles, statement }) => roles.includes(apiRoleId) && [statement.Resource].flat().includes("*"),
    );
    expect(wildcards.map(({ statement }) => statement.Sid)).toEqual(["ListBedrockModels"]);
  });

  it("registers ManageModels for administrators only", () => {
    const [store] = Object.values(template.findResources("AWS::VerifiedPermissions::PolicyStore"));
    const schema = JSON.parse(store!.Properties.Schema.CedarJson).Mango;
    expect(schema.actions.ManageModels.appliesTo).toEqual({
      principalTypes: ["User"],
      resourceTypes: ["Platform"],
    });
    const policies = Object.values(template.findResources("AWS::VerifiedPermissions::Policy"))
      .map((p) => p.Properties.Definition.Static.Statement as string)
      .filter((s) => s.includes('Mango::Action::"ManageModels"'));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain("when { principal.isAdmin }");
    expect(policies[0]).toContain('resource == Mango::Platform::"mango"');
  });
});

describe("Agent authorization (Cedar L1, D33)", () => {
  const [store] = Object.values(template.findResources("AWS::VerifiedPermissions::PolicyStore"));
  const schema = JSON.parse(store!.Properties.Schema.CedarJson).Mango;
  const statements = Object.values(template.findResources("AWS::VerifiedPermissions::Policy")).map(
    (p) => p.Properties.Definition.Static.Statement as string,
  );
  const policyFor = (action: string) => statements.filter((s) => s.includes(`Mango::Action::"${action}"`));

  it("registers the agent actions on the resource they are decided for", () => {
    const resourceTypes = (action: string) => schema.actions[action].appliesTo.resourceTypes;
    expect(resourceTypes("CreateAgent")).toEqual(["Platform"]);
    expect(resourceTypes("ViewMcpCatalog")).toEqual(["Platform"]);
    expect(resourceTypes("EditAgent")).toEqual(["Agent"]);
    expect(resourceTypes("RetireAgent")).toEqual(["Agent"]);
    expect(resourceTypes("ApproveAgent")).toEqual(["Agent", "Platform"]);
    expect(resourceTypes("UseAgent")).toEqual(["Agent"]);
  });

  it("describes an agent with optional attributes only (rolling updates)", () => {
    const attributes = schema.entityTypes.Agent.shape.attributes;
    expect(attributes).toEqual({
      creator: { type: "Entity", name: "User", required: false },
      groups: { type: "Set", element: { type: "String" }, required: false },
      users: { type: "Set", element: { type: "Entity", name: "User" }, required: false },
    });
  });

  it("decides UseAgent from the agent's own groups and users, never per agent id", () => {
    // Nothing names an agent: the release agent (FinOps) is data like the rest.
    expect(statements.filter((s) => /Mango::Agent::"/.test(s))).toEqual([]);
    const byData = policyFor("UseAgent").filter((s) => s.includes("resource is Mango::Agent"));
    expect(byData).toHaveLength(1);
    expect(byData[0]).toContain("resource has users && resource.users.contains(principal)");
    expect(byData[0]).toContain("resource.groups.containsAny(principal.groups)");
    expect(byData[0]).toContain("principal has groups &&");
    expect(byData[0]).not.toContain("isAdmin");
  });

  it("keeps review and retirement for administrators", () => {
    for (const action of ["ApproveAgent", "RetireAgent"]) {
      const policies = policyFor(action);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toContain("when { principal.isAdmin }");
      expect(policies[0]).not.toContain("mango-agent-creator");
    }
  });

  it("lets creators create, and edit only the agents they created", () => {
    for (const action of ["CreateAgent", "ViewMcpCatalog", "EditAgent"]) {
      const policies = policyFor(action);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toContain("principal has groups &&");
      expect(policies[0]).toContain('principal.groups.contains("mango-agent-creator")');
    }
    expect(policyFor("EditAgent")[0]).toContain("resource has creator &&");
    expect(policyFor("EditAgent")[0]).toContain("resource.creator == principal");
  });

  it("only permits, and never without a condition", () => {
    for (const statement of statements) {
      const code = statement.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bforbid\b/);
      expect(code.match(/\bpermit\s*\(/g)).toHaveLength(1);
      expect(code).toMatch(/\bwhen\s*\{/);
    }
  });
});
