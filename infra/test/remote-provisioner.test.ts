import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { REMOTE_PROVISIONER_WRITABLE_ATTRIBUTES } from "../lib/constructs/remote-provisioner.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

// The provisioner lives in the RemoteMcp stack nested in Core (D99).
const core = new CoreStack(
  new App({ context: { skipSpa: true, packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) } }),
  "Core",
  { installation: cfg, env: { account: cfg.mangoAccountId, region: cfg.region } },
);
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;

function roleId(name: string): string {
  const ids = Object.keys(template.findResources("AWS::IAM::Role", { Properties: { RoleName: name } }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}
function statementsOf(id: string): Statement[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === id))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const all = (id: string) => statementsOf(id).flatMap(actions);
const sid = (id: string, name: string) => {
  const found = statementsOf(id).find((s) => s.Sid === name);
  expect(found, name).toBeDefined();
  return found!;
};

const provisioner = roleId(`Mango-${ns}-RemoteMcpProvisioner`);
const api = roleId(`Mango-${ns}-ApiTask`);

describe("remote MCP provisioner (D98, PR-4)", () => {
  it("lives in the RemoteMcp stack nested in Core, not in Core (D99)", () => {
    const remoteMcp = nestedStacks(core).find((n) => n.node.id === "RemoteMcp")!;
    const typesOf = (t: Record<string, any>) => Object.values(t.Resources as Record<string, Resource>).map((r) => r.Type);
    expect(typesOf(nestedTemplate(remoteMcp))).toEqual(
      expect.arrayContaining(["AWS::StepFunctions::StateMachine", "AWS::Lambda::Function", "AWS::IAM::Role"]),
    );
    const own = Template.fromStack(core).findResources("AWS::IAM::Role", {
      Properties: { RoleName: `Mango-${ns}-RemoteMcpProvisioner` },
    });
    expect(Object.keys(own)).toHaveLength(0);
  });

  it("is a state machine of its own, with its own function and role", () => {
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineName: `Mango-${ns}-RemoteMcpProvisioner`,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `Mango-${ns}-RemoteMcpProvisioner`,
      Handler: "mango_provisioner.remotes.handler.lambda_handler",
    });
  });

  it("signs only with the remote MCP key, and nobody else may (TM-012)", () => {
    const sign = sid(provisioner, "SignApprovedRemoteCatalog");
    expect(actions(sign).sort()).toEqual(["kms:GetPublicKey", "kms:Sign"]);
    const keyId = Object.keys(
      template.findResources("AWS::KMS::Key", {
        Properties: { Description: Match.stringLikeRegexp("approved catalog of remote MCP") },
      }),
    );
    expect(keyId).toHaveLength(1);
    expect(sign.Resource).toEqual({ "Fn::GetAtt": [keyId[0], "Arn"] });
    // The key policy denies kms:Sign to every principal but this role.
    const key = resources[keyId[0]!]!;
    const deny = key.Properties.KeyPolicy.Statement.find((s: Statement) => s.Sid === "OnlyTheRemoteProvisionerSigns");
    expect(deny.Effect).toBe("Deny");
    expect(JSON.stringify(deny.Condition)).toContain(`role/Mango-${ns}-RemoteMcpProvisioner`);
    // mango-api, the pack and agent provisioners never get kms:Sign on it.
    for (const name of ["ApiTask", "PackProvisioner", "Provisioner"]) {
      const statements = statementsOf(roleId(`Mango-${ns}-${name}`));
      expect(
        statements.filter((s) => actions(s).includes("kms:Sign") && JSON.stringify(s.Resource).includes(keyId[0]!)),
        name,
      ).toEqual([]);
    }
  });

  it("cannot create or change an OAuth2 provider: the secret only goes through mango-api", () => {
    const granted = all(provisioner);
    expect(granted).not.toContain("bedrock-agentcore:CreateOauth2CredentialProvider");
    expect(granted).not.toContain("bedrock-agentcore:UpdateOauth2CredentialProvider");
    expect(granted).not.toContain("secretsmanager:GetSecretValue");
    const providers = JSON.stringify(sid(provisioner, "DeleteRemoteProviders").Resource);
    expect(providers).toContain(`oauth2credentialprovider/Mango-${ns}-remote-*`);
  });

  it("writes only the lifecycle of a registration and the approved catalog", () => {
    const lifecycle = sid(provisioner, "WriteRemoteLifecycle");
    expect(actions(lifecycle)).toEqual(["dynamodb:UpdateItem"]);
    expect(lifecycle.Condition!["ForAllValues:StringLike"]).toEqual({ "dynamodb:LeadingKeys": ["REMOTE#*"] });
    expect(lifecycle.Condition!["ForAllValues:StringEquals"]).toEqual({
      "dynamodb:Attributes": REMOTE_PROVISIONER_WRITABLE_ATTRIBUTES,
    });
    for (const owned of ["organization", "tenant_id", "client_id", "toolsets", "groups", "generation", "requested_by"]) {
      expect(REMOTE_PROVISIONER_WRITABLE_ATTRIBUTES).not.toContain(owned);
    }
    const catalog = sid(provisioner, "WriteApprovedRemoteCatalog");
    expect(catalog.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MCP_REMOTE#*"] } });
    // No other write on Settings: not the requests, the organizations or the consents.
    const writes = statementsOf(provisioner).filter((s) =>
      actions(s).some((a) => ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"].includes(a)),
    );
    expect(writes.map((s) => s.Sid).sort()).toEqual(["WriteApprovedRemoteCatalog", "WriteAuditIndex", "WriteRemoteLifecycle"]);
  });

  it("touches only the remote policies and the Gateway's own workload identity", () => {
    expect(JSON.stringify(sid(provisioner, "ManageRemotePolicies").Resource)).toContain(`/policy/Mango_${ns}_remote_*`);
    expect(JSON.stringify(sid(provisioner, "GatewayReturnUrl").Resource)).toContain(
      `workload-identity-directory/default/workload-identity/mango-${ns}-tools-*`,
    );
    expect(all(provisioner)).not.toContain("bedrock-agentcore:SynchronizeGatewayTargets");
    expect(all(provisioner).filter((a) => a.startsWith("iam:"))).toEqual([]);
  });

  it("returns to the SPA route", () => {
    const fn = Object.values(template.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: `Mango-${ns}-RemoteMcpProvisioner` },
    }))[0]!;
    const variables = fn.Properties.Environment.Variables;
    expect(JSON.stringify(variables.REMOTE_RETURN_URL)).toContain("/conexiones/vuelta");
    expect(variables.REMOTE_MCP_KEY_ARN).toEqual({ "Fn::GetAtt": [expect.stringMatching(/RemoteMcpKey/), "Arn"] });
    // An installation without signed profiles has an empty catalog: nothing can be registered.
    expect(variables.REMOTE_CATALOG).toBe("{}");
    // mango-api gets StartExecution in its own managed policy (PR-5), not in its full inline one.
    expect(statementsOf(api).filter((s) => s.Sid === "StartRemoteMcpProvisioner")).toEqual([]);
  });

  it("is swept by the uninstall guard: remote policies and providers of this installation", () => {
    const guard = roleId(`Mango-${ns}-UninstallGuard`);
    expect(JSON.stringify(sid(guard, "DeletePackPolicies").Resource)).toContain(`/policy/Mango_${ns}_remote_*`);
    expect(JSON.stringify(sid(guard, "DeleteRemoteProviders").Resource)).toContain(
      `oauth2credentialprovider/Mango-${ns}-remote-*`,
    );
  });
});
