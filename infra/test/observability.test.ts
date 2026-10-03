import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { Installation, loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const base = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));

function synth(cfg: Installation): Template {
  const app = new App();
  const stack = new CoreStack(app, "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  });
  return Template.fromStack(stack);
}

describe("agent runtime observability", () => {
  const template = synth(base);

  it("gives mango-api the same session lifecycle the provisioner stores in each harness (D39)", () => {
    const env = (type: string, pick: (resource: Record<string, any>) => Record<string, unknown>) =>
      Object.values(template.findResources(type)).map(pick);
    const [api] = env("AWS::ECS::TaskDefinition", (task) =>
      Object.fromEntries(
        (task.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map((e) => [
          e.Name,
          e.Value,
        ]),
      ),
    );
    const provisioner = env("AWS::Lambda::Function", (fn) => fn.Properties.Environment?.Variables ?? {}).find(
      (variables) => "AGENT_BOUNDARY_ARN" in variables,
    );
    expect(api!.AGENT_SESSION_IDLE_SECONDS).toBe("300");
    expect(api!.AGENT_SESSION_MAX_SECONDS).toBe("28800");
    expect(provisioner!.AGENT_SESSION_IDLE_SECONDS).toBe(api!.AGENT_SESSION_IDLE_SECONDS);
    expect(provisioner!.AGENT_SESSION_MAX_SECONDS).toBe(api!.AGENT_SESSION_MAX_SECONDS);
  });

  it("encrypts the runtime log groups of agents with a rotating key scoped to them", () => {
    // Content redaction (D16) is part of the harness the provisioner creates:
    // functions/provisioner/tests/test_steps.py.
    template.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "CloudWatchLogsAgentRuntimeLogGroups",
            Condition: { ArnLike: { "kms:EncryptionContext:aws:logs:arn": Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  it("enables transaction search only when the stack owns it", () => {
    template.resourceCountIs("AWS::XRay::TransactionSearchConfig", 1);
    const external = synth({ ...base, observability: { transactionSearch: "external" } });
    external.resourceCountIs("AWS::XRay::TransactionSearchConfig", 0);
    expect(
      external.findResources("AWS::Logs::ResourcePolicy", {
        Properties: { PolicyName: Match.stringLikeRegexp("TransactionSearch") },
      }),
    ).toEqual({});
  });
});
