#!/usr/bin/env node
import { App, Aspects, DefaultStackSynthesizer, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { GuardSuppressions } from "../lib/guard.js";
import { releaseVersion } from "../lib/constructs/release-agents.js";
import { PROVIDER_PREFIX, ProviderStack } from "../lib/stacks/provider-stack.js";

// The provider account (D58): its own app, so nothing of it reaches the customer templates.
// `-c retain=false` only for a temporary provider account that must be removed whole.
const app = new App();
const provider = new ProviderStack(app, "Provider", {
  stackName: PROVIDER_PREFIX,
  description: `(Mango) mango-hub provider account: release store and signing [v${releaseVersion()}]`,
  // No assets and no CDK bootstrap: deployed with `aws cloudformation deploy`.
  synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
  retain: app.node.tryGetContext("retain") !== "false",
});
Tags.of(provider).add("mango:component", "provider");
// Only the rule false positive on TLS-only bucket policies applies here (AGENTS.md).
Aspects.of(provider).add(new GuardSuppressions());
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
