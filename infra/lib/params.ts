import { CfnParameter, CfnRule, Fn, Stack, Tags } from "aws-cdk-lib";

/**
 * Stack parameters of an installation (D58): the few values that differ between customers.
 * Everything else is a value of the release or is configured in the app. One declaration per
 * parameter, so every template that asks for it uses the same name, pattern and description.
 *
 * Descriptions are plain ASCII: CloudFormation stores any other character of a StackSet
 * template as `?`, and the deployed spoke template would no longer match its published hash.
 */

const ACCOUNT_ID = "^[0-9]{12}$";

/** Prefixed to every global name (rule 6): `Mango-<ns>-…`. */
export function namespaceParameter(stack: Stack): string {
  return new CfnParameter(stack, "Namespace", {
    type: "String",
    description: "3 to 8 lowercase letters or digits, prefixed to every name of this installation (Mango-<namespace>-...).",
    allowedPattern: "^[a-z0-9]{3,8}$",
    constraintDescription: "must be 3 to 8 lowercase letters or digits",
  }).valueAsString;
}

export function organizationIdParameter(stack: Stack): string {
  return new CfnParameter(stack, "OrganizationId", {
    type: "String",
    description: "Id of the AWS Organization (o-...): every cross-account trust of Mango is limited to it.",
    allowedPattern: "^o-[a-z0-9]{10,32}$",
    constraintDescription: "must be an organization id (o-...)",
  }).valueAsString;
}

/** Account where `Mango-<ns>-Core` is installed, asked for by the stacks of other accounts. */
export function mangoAccountIdParameter(stack: Stack): string {
  return new CfnParameter(stack, "MangoAccountId", {
    type: "String",
    description: "Account id where Mango (the Core stack) is installed.",
    allowedPattern: ACCOUNT_ID,
    constraintDescription: "must be a 12-digit account id",
  }).valueAsString;
}

/** Organization management (payer) account, asked for by Core. */
export function managementAccountIdParameter(stack: Stack): string {
  return new CfnParameter(stack, "ManagementAccountId", {
    type: "String",
    description: "Account id of the organization management (payer) account, where the Payer stack is installed.",
    allowedPattern: ACCOUNT_ID,
    constraintDescription: "must be a 12-digit account id",
  }).valueAsString;
}

/**
 * `mango:namespace` on every resource of a parameterized stack. The value is only known at
 * deployment, so it cannot be a tag of the stack itself: whoever deploys passes that one.
 */
export function tagNamespace(stack: Stack, namespace: string): void {
  Tags.of(stack).add("mango:namespace", namespace, { excludeResourceTypes: ["aws:cdk:stack"] });
}

/** A stack that belongs to another account must not be created in the Mango account. */
export function assertNotTheMangoAccount(stack: Stack, mangoAccountId: string): void {
  new CfnRule(stack, "NotTheMangoAccount", {
    assertions: [
      {
        assert: Fn.conditionNot(Fn.conditionEquals(mangoAccountId, stack.account)),
        assertDescription: "This stack belongs to the organization management account, not to the Mango account.",
      },
    ],
  });
}
