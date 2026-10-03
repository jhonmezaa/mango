#!/usr/bin/env node
import { App, Stack, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { applyNagSuppressions } from "../lib/nag-suppressions.js";
import { releaseSynthesizer, releaseTarget } from "../lib/release-target.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { MemberStack } from "../lib/stacks/member-stack.js";
import { OrgAccessStack } from "../lib/stacks/org-access-stack.js";
import { PackNetworkStack } from "../lib/stacks/pack-network-stack.js";
import { PayerStack } from "../lib/stacks/payer-stack.js";

const app = new App();
/** The only Region this release installs in (see the `SupportedRegion` rule of Core). */
const RELEASE_REGION = "us-east-1";

// One template for every customer (D58): no account and no installation config; what differs
// between installations is a stack parameter. The Region is fixed: some resources (DynamoDB
// tables with a customer-managed key, ALB access logs) cannot be rendered for an unknown one,
// so a release carries one Core template per supported Region.
const target = releaseTarget(app.node);
const core = new CoreStack(app, "Core", {
  description: `(Mango) mango-hub ${target.label} core installation`,
  env: { region: RELEASE_REGION },
  // Assets and image come from the provider account: no CDK bootstrap where it is installed.
  synthesizer: releaseSynthesizer(target),
  release: target,
});

// Payer, OrgAccess and Member are the same templates for every customer (D58): no assets, no
// CDK bootstrap and no environment; the installation's values are stack parameters.
const payer = new PayerStack(app, "Payer", {
  description: `(Mango) mango-hub ${target.label} billing reader`,
});

// The spoke template of the member accounts (§4.10). The StackSet of OrgAccess carries the
// same template inline; it is also synthesized here on its own, so that cdk-nag, cfn-guard and
// Checkov see it and a customer can deploy it with CfCT/AFT instead.
const member = new MemberStack(app, "Member");
const orgAccess = new OrgAccessStack(app, "OrgAccess", {
  description: `(Mango) mango-hub ${target.label} member account access`,
});

// The network of the pack runtimes, in the Mango account: installed before Core, which
// imports it, and deleted after it.
const packNetwork = new PackNetworkStack(app, "PackNetwork", {
  description: `(Mango) mango-hub ${target.label} pack runtime network`,
  env: { region: RELEASE_REGION },
  synthesizer: releaseSynthesizer(target),
});

const components = new Map<Stack, string>([
  [core, "core"],
  [packNetwork, "pack-network"],
  [payer, "payer"],
  [member, "member"],
  [orgAccess, "org-access"],
]);

for (const [stack, component] of components) {
  Tags.of(stack).add("mango:component", component);
  applyNagSuppressions(stack);
}
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
