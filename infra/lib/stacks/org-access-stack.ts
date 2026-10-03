import { createHash } from "node:crypto";
import { Aws, CfnOutput, CfnParameter, CfnRule, CfnStackSet, Fn, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { memberStackSetName } from "../names.js";
import { mangoAccountIdParameter, namespaceParameter, organizationIdParameter, tagNamespace } from "../params.js";
import { noBootstrapSynthesizer, synthMemberTemplate } from "./member-stack.js";

/** Share of the target accounts that may fail before a StackSet operation stops (§4.10). */
export const FAILURE_TOLERANCE_PERCENT = 10;
/** CloudFormation limit for an inline `TemplateBody`. */
const MAX_TEMPLATE_BODY_BYTES = 51_200;

/**
 * `Mango-<ns>-OrgAccess`, deployed in the organization management account or in a delegated
 * administrator of StackSets (§4.10, D5).
 *
 * Contains only the service-managed StackSet that deploys the spoke template
 * (`Mango-<ns>-Member`) to the accounts of the chosen root or OUs, and to the accounts that
 * join them later. It creates no role in this account: StackSets uses its own service roles.
 * It does not change the organization (no OUs, no SCPs, no trusted access).
 *
 * The same template for every customer (D58): where the roles go is a stack parameter.
 */
export class OrgAccessStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    // No assets: the account that owns the StackSet needs no CDK bootstrap.
    super(scope, id, { ...props, synthesizer: noBootstrapSynthesizer() });
    const ns = namespaceParameter(this);
    const mangoAccountId = mangoAccountIdParameter(this);
    const organizationId = organizationIdParameter(this);
    tagNamespace(this, ns);
    const targets = new CfnParameter(this, "Targets", {
      type: "CommaDelimitedList",
      description:
        "Where the member roles are deployed, now and as accounts join: the organization root (r-…) alone, or " +
        "up to 50 OU ids (their child OUs included). Explicit OUs are preferred.",
      // CloudFormation checks the pattern against each element of the list.
      allowedPattern: "^r-[0-9a-z]{4,32}$|^ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}$",
      constraintDescription: "must be one root id, or OU ids separated by commas",
    });
    const excluded = new CfnParameter(this, "ExcludedAccountIds", {
      type: "CommaDelimitedList",
      description:
        "Accounts inside the targets that must not get the roles. It always includes the Mango account: no " +
        "agent reads Mango's own operational data.",
      allowedPattern: "^[0-9]{12}$",
      constraintDescription: "must be 12-digit account ids separated by commas",
    });
    const callAs = new CfnParameter(this, "CallAs", {
      type: "String",
      default: "SELF",
      allowedValues: ["SELF", "DELEGATED_ADMIN"],
      description: "SELF in the organization management account; DELEGATED_ADMIN in a delegated administrator of StackSets.",
    });
    // The Mango account never gets the member role (D51), whatever the targets are. StackSets
    // never reach the management account, so naming it would only fail the deployment.
    new CfnRule(this, "MangoAccountIsExcluded", {
      assertions: [
        {
          assert: Fn.conditionContains(excluded.valueAsList, mangoAccountId),
          assertDescription: "ExcludedAccountIds must include the Mango account (MangoAccountId).",
        },
      ],
    });

    const templateBody = JSON.stringify(synthMemberTemplate());
    if (Buffer.byteLength(templateBody) > MAX_TEMPLATE_BODY_BYTES) {
      throw new Error("the member template no longer fits in a StackSet TemplateBody");
    }
    const templateSha256 = (this.memberTemplateSha256 = createHash("sha256").update(templateBody).digest("hex"));

    const stackSet = new CfnStackSet(this, "Member", {
      stackSetName: memberStackSetName(ns),
      description: `Mango member account roles sha256:${templateSha256.slice(0, 16)}`,
      permissionModel: "SERVICE_MANAGED",
      callAs: callAs.valueAsString,
      capabilities: ["CAPABILITY_NAMED_IAM"],
      autoDeployment: { enabled: true, retainStacksOnAccountRemoval: false },
      managedExecution: { Active: true },
      operationPreferences: {
        failureTolerancePercentage: FAILURE_TOLERANCE_PERCENT,
        maxConcurrentPercentage: 25,
        regionConcurrencyType: "SEQUENTIAL",
      },
      // The spoke template is the same for every customer; these are its only inputs.
      parameters: [
        { parameterKey: "Namespace", parameterValue: ns },
        { parameterKey: "MangoAccountId", parameterValue: mangoAccountId },
        { parameterKey: "OrganizationId", parameterValue: organizationId },
      ],
      stackInstancesGroup: [
        {
          regions: [Aws.REGION],
          deploymentTargets: {
            organizationalUnitIds: targets.valueAsList,
            accountFilterType: "DIFFERENCE",
            accounts: excluded.valueAsList,
          },
        },
      ],
      templateBody,
    });

    new CfnOutput(this, "MemberStackSetId", { value: stackSet.attrStackSetId });
    new CfnOutput(this, "MemberTemplateSha256", { value: templateSha256 });
  }

  /** Digest of the spoke template every installation of this release deploys. */
  readonly memberTemplateSha256: string;
}
