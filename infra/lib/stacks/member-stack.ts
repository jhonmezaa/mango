import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Aws, DefaultStackSynthesizer, Duration, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { roleArn, roleNames, SESSION_TAG_KEYS } from "../names.js";
import { acknowledge } from "../nag.js";
import { mangoAccountIdParameter, namespaceParameter, organizationIdParameter, tagNamespace } from "../params.js";

/** Every alarm of the account the role lives in, in any Region (CloudWatch is regional). */
const ALARMS_OF_THE_ACCOUNT = `arn:aws:cloudwatch:*:${Aws.ACCOUNT_ID}:alarm:*`;

/**
 * What `Mango-<ns>-ReadOnly` may read in every member account: the ceiling of a tool there (a
 * session assumed through the Read broker can never do more). Explicit read-only actions per
 * pack, never `ReadOnlyAccess` (§4.10); each one exists in the IAM service reference and none
 * writes, tags or manages permissions.
 *
 * Today, the CloudWatch pack (`packs/aws-cloudwatch`): metrics, alarms and the metadata of log
 * groups. **No log events and no Logs Insights** (`logs:StartQuery`, `logs:GetQueryResults`,
 * `logs:FilterLogEvents`, `logs:GetLogEvents`): their content may hold personal data or
 * secrets (user, 2026-10-02). A test keeps them out.
 */
export const MEMBER_READ_ONLY_STATEMENTS: { sid: string; actions: string[]; resources: string[] }[] = [
  {
    sid: "ReadMetrics",
    actions: ["cloudwatch:GetMetricData"],
    // GetMetricData is authorized on "*": a query names metrics, not a resource with an ARN.
    resources: ["*"],
  },
  {
    sid: "ReadAlarms",
    actions: ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory"],
    resources: [ALARMS_OF_THE_ACCOUNT],
  },
  {
    sid: "ListLogGroups",
    // Names, retention and size of log groups, and the saved Logs Insights queries. Neither
    // action has a resource type in the IAM service reference.
    actions: ["logs:DescribeLogGroups", "logs:DescribeQueryDefinitions"],
    resources: ["*"],
  },
];

/** The same actions as one list: the ceiling of a manifest of the member chain (D51). */
export const MEMBER_READ_ONLY_DATA_ACTIONS: string[] = MEMBER_READ_ONLY_STATEMENTS.flatMap((s) => s.actions);

/** Synthesizer of the templates without assets: no CDK bootstrap in the account that deploys them. */
export function noBootstrapSynthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ generateBootstrapVersionRule: false });
}

/**
 * `Mango-<ns>-Member`, the spoke template: deployed to every member account by the StackSet
 * of `Mango-<ns>-OrgAccess` (or by CfCT/AFT with the same template).
 *
 * Contains only `Mango-<ns>-ReadOnly`, shared by all read tools (D10) and assumable exclusively
 * by the Read broker of the Mango account. No assets and no environment: the same template
 * goes to every account of every customer, with the installation's values as parameters
 * (`Namespace`, `MangoAccountId`, `OrganizationId`), which the StackSet passes on (D58).
 */
export class MemberStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, {
      description: MEMBER_DESCRIPTION,
      ...props,
      synthesizer: noBootstrapSynthesizer(),
      analyticsReporting: false,
    });
    const ns = namespaceParameter(this);
    const mangoAccountId = mangoAccountIdParameter(this);
    const organizationId = organizationIdParameter(this);
    const mango = new iam.AccountPrincipal(mangoAccountId);
    const fromBroker = {
      ArnEquals: { "aws:PrincipalArn": roleArn(mangoAccountId, roleNames.readBroker(ns)) },
      StringEquals: { "aws:PrincipalOrgID": organizationId },
    };

    const reader = new iam.Role(this, "ReadOnly", {
      roleName: roleNames.memberReadOnly(ns),
      description: "Mango read-only access to this account, through the Read broker of the Mango account",
      // SourceIdentity is mandatory on AssumeRole: CloudTrail of this account shows the person.
      assumedBy: mango.withConditions({ ...fromBroker, Null: { "sts:SourceIdentity": "false" } }),
      // Role chaining caps the session at one hour anyway.
      maxSessionDuration: Duration.hours(1),
    });
    // The broker passes on the SourceIdentity of its own session and its transitive tags.
    reader.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [mango],
        conditions: { ...fromBroker, StringLike: { "sts:SourceIdentity": "*" } },
      }),
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [mango],
        conditions: { ...fromBroker, "ForAllValues:StringEquals": { "aws:TagKeys": SESSION_TAG_KEYS } },
      }),
    );
    for (const statement of MEMBER_READ_ONLY_STATEMENTS) {
      reader.addToPolicy(new iam.PolicyStatement(statement));
    }
    acknowledge(
      reader,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "cloudwatch:GetMetricData, logs:DescribeLogGroups and logs:DescribeQueryDefinitions only work on " +
          '"*" (no usable resource type in the IAM service reference). Exact read-only actions. Agreed on 2026-10-02.',
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:cloudwatch:*:<AWS::AccountId>:alarm:*]`,
        reason:
          "The same template goes to every member account: alarm names and Regions are not known. Scoped to " +
          "the alarms of the account the role lives in. Agreed on 2026-10-02.",
      },
    );

    tagNamespace(this, ns);
    Tags.of(this).add("mango:component", "member");
  }
}

/**
 * The spoke template as the StackSet carries it (`TemplateBody`): synthesized on its own, so
 * that the stack of the management account needs no bucket and nobody can swap the template
 * between review and deployment. It is the same for every customer: its digest is a value of
 * the release.
 */
export function synthMemberTemplate(): Record<string, unknown> {
  const outdir = mkdtempSync(join(tmpdir(), "mango-member-"));
  try {
    const app = new App({ outdir });
    const stack = new MemberStack(app, "Member");
    return app.synth().getStackArtifact(stack.artifactId).template as Record<string, unknown>;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

export const MEMBER_DESCRIPTION = "(Mango) mango-hub member account roles";
