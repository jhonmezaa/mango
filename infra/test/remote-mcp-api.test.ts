import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

/* mango-api and remote MCP registrations (D93, D98; remote-mcp-threat-model.md). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const template = fromCore(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const text = (value: unknown) => JSON.stringify(value);
const apiRoleId = Object.keys(template.findResources("AWS::IAM::Role", { Properties: { RoleName: `Mango-${ns}-ApiTask` } }))[0]!;
const policies = Object.values(template.findResources("AWS::IAM::ManagedPolicy", {
  Properties: { ManagedPolicyName: `Mango-${ns}-ApiRemoteMcp` },
}));
const statements = (policies[0]?.Properties.PolicyDocument.Statement ?? []) as Statement[];
const bySid = (sid: string) => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found).toHaveLength(1);
  return found[0]!;
};
function apiEnvironment(): Record<string, unknown> {
  const task = Object.values(resources).find((r) => r.Type === "AWS::ECS::TaskDefinition")!;
  const env = task.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
  return Object.fromEntries(env.map((e) => [e.Name, e.Value]));
}

describe("mango-api and remote MCP registrations", () => {
  it("has a managed policy of its own and no overflow of the inline one", () => {
    expect(policies).toHaveLength(1);
    expect(policies[0]!.Properties.Roles).toEqual([{ Ref: apiRoleId }]);
    expect(Object.keys(resources).filter((id) => id.startsWith("ApiTaskRoleOverflowPolicy"))).toEqual([]);
  });

  it("manages only the Identity providers of this installation's remote registrations", () => {
    const providers = bySid("RemoteMcpProviders");
    expect(actions(providers).sort()).toEqual([
      "bedrock-agentcore:CreateOauth2CredentialProvider",
      "bedrock-agentcore:DeleteOauth2CredentialProvider",
      "bedrock-agentcore:GetOauth2CredentialProvider",
      "bedrock-agentcore:TagResource",
      "bedrock-agentcore:UpdateOauth2CredentialProvider",
    ]);
    expect(text(providers.Resource)).toContain(`token-vault/default/oauth2credentialprovider/Mango-${ns}-remote-*`);
    const secrets = bySid("RemoteMcpProviderSecrets");
    expect(text(secrets.Resource)).toContain(`secret:bedrock-agentcore-identity!default/oauth2/Mango-${ns}-remote-*`);
    expect(actions(secrets)).not.toContain("secretsmanager:GetSecretValue");
    // Nothing of the policy reads a secret, signs, or reaches anything else of AgentCore.
    for (const statement of statements) {
      for (const action of actions(statement)) {
        expect(action).not.toMatch(/\*|GetSecretValue|kms:Sign|GetResourceOauth2Token|InvokeHarness/);
      }
      expect(text(statement.Resource)).not.toBe('"*"');
    }
  });

  it("closes a person's consent only on the Gateway's workload identity (D98 (1))", () => {
    const consent = bySid("CompleteRemoteConsent");
    expect(actions(consent)).toEqual(["bedrock-agentcore:CompleteResourceTokenAuth"]);
    const targets = text(consent.Resource);
    expect(targets).toContain("workload-identity-directory/default");
    expect(targets).toContain(`workload-identity-directory/default/workload-identity/mango-${ns}-tools-*`);
    expect(targets).not.toContain("token-vault");
    // Only this statement may close a consent; nothing else of the role names the action.
    const others = statements.filter((s) => s.Sid !== "CompleteRemoteConsent");
    expect(others.flatMap(actions)).not.toContain("bedrock-agentcore:CompleteResourceTokenAuth");
  });

  it("reads the public key of the approved catalogs only through its alias, and never signs", () => {
    const key = bySid("RemoteMcpPublicKey");
    expect(actions(key)).toEqual(["kms:GetPublicKey"]);
    expect(key.Condition).toEqual({ StringEquals: { "kms:RequestAlias": `alias/Mango-${ns}-remote-mcp` } });
    expect(apiEnvironment().REMOTE_MCP_KEY_ID).toBe(`alias/Mango-${ns}-remote-mcp`);
  });

  it("starts only the remote provisioner", () => {
    const start = bySid("StartRemoteProvisioner");
    expect(actions(start)).toEqual(["states:StartExecution"]);
    expect(text(start.Resource)).toContain(`stateMachine:Mango-${ns}-RemoteMcpProvisioner`);
    expect(text(apiEnvironment().REMOTE_PROVISIONER_STATE_MACHINE_ARN)).toContain(
      `stateMachine:Mango-${ns}-RemoteMcpProvisioner`,
    );
  });

  it("reads the tags of its own stack only (D76)", () => {
    const tags = bySid("ReadInstallationStackTags");
    expect(actions(tags)).toEqual(["cloudformation:DescribeStacks"]);
    expect(tags.Resource).toEqual({ Ref: "AWS::StackId" });
    expect(apiEnvironment().MANGO_STACK_ID).toEqual({ Ref: "AWS::StackId" });
  });

  it("cannot write the signed approved catalogs nor the pending consents", () => {
    const inline = Object.values(resources).filter(
      (r) => r.Type === "AWS::IAM::Policy" && (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === apiRoleId),
    );
    const provisionerOnly = inline
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
      .find((s) => s.Sid === "InstalledPacksAreProvisionerOnly")!;
    expect(provisionerOnly.Effect).toBe("Deny");
    expect(provisionerOnly.Condition!["ForAnyValue:StringLike"]!["dynamodb:LeadingKeys"]).toContain("MCP_REMOTE#*");
    const consents = bySid("ConsentsAreTheInterceptors");
    expect(consents.Effect).toBe("Deny");
    expect(actions(consents).sort()).toEqual(["dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(consents.Condition).toEqual({ "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["MCP_CONSENT#*"] } });
  });

  it("is off unless the installation turns it on (D98 (4)), and names the release's profiles", () => {
    const env = apiEnvironment();
    expect(env.REMOTE_MCP_ENABLED).toBe("false");
    // The unit tests ship no signed profiles: the catalog is empty and nothing is readable.
    expect(env.REMOTE_CATALOG).toBe("{}");
    expect(statements.some((s) => s.Sid === "ReadReleaseRemoteProfiles")).toBe(false);
  });
});
