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

/** The same resource in every Region of the account the role lives in (`arn:aws:<service>:*:<account>:<resource>`). */
const ofTheAccount = (service: string, resource: string) => `arn:aws:${service}:*:${Aws.ACCOUNT_ID}:${resource}`;

/**
 * What `Mango-<ns>-ReadOnly` may read in every member account: the ceiling of a tool there (a
 * session assumed through the Read broker can never do more). Explicit read-only actions per
 * pack, never `ReadOnlyAccess` (§4.10); each one exists in the IAM service reference and none
 * writes, tags or manages permissions. Where the IAM service reference gives the action a
 * resource type, the statement names that resource in the account the role lives in; `*` only
 * where it gives none (checked on 2026-11-13).
 *
 * - The CloudWatch pack (`packs/aws-cloudwatch`): metrics, alarms and the metadata of log
 *   groups (user, 2026-10-02), and bounded Logs Insights queries (precision of D55 (3),
 *   proposed on 2026-11-13). No log events (`logs:FilterLogEvents`, `logs:GetLogEvents`) and
 *   no way to read or stop the query of somebody else (`logs:DescribeQueries`,
 *   `logs:StopQuery`). A test keeps them out.
 * - The SRE and database packs of 2026-11-13 (proposed): CloudTrail management events,
 *   Application Signals, ElastiCache, and Mango's own packs `aws-ops` and `aws-rds`. RDS log
 *   files are read by `rds:DownloadDBLogFilePortion` (precision of D55, proposed); Performance
 *   Insights only with tokenized SQL (no `pi:GetDimensionKeyDetails`).
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
  {
    sid: "QueryLogGroups",
    // aws-cloudwatch, D55 (3) precision (proposed): bounded by the pack's entry point (window,
    // log groups, rows, timeout). Both actions take the log group.
    actions: ["logs:StartQuery", "logs:GetQueryResults"],
    resources: [ofTheAccount("logs", "log-group:*")],
  },
  {
    sid: "ListLogAnomalies",
    actions: ["logs:ListLogAnomalyDetectors", "logs:ListAnomalies"],
    resources: [ofTheAccount("logs", "anomaly-detector:*")],
  },
  {
    sid: "CloudTrailLookupEvents",
    // aws-cloudtrail: management events of the last 90 days. No resource type. CloudTrail Lake
    // (`cloudtrail:StartQuery`) is a Write action in IAM and stays out.
    actions: ["cloudtrail:LookupEvents"],
    resources: ["*"],
  },
  {
    sid: "ApplicationSignalsRead",
    // aws-application-signals (lists of its report): services, operations, dependencies, SLOs,
    // audits and change events; metric statistics; traces by id and where segments go;
    // canaries. No resource type for any of them.
    actions: [
      "application-signals:ListServices",
      "application-signals:GetService",
      "application-signals:ListServiceOperations",
      "application-signals:ListServiceDependencies",
      "application-signals:ListServiceDependents",
      "application-signals:ListServiceLevelObjectives",
      "application-signals:ListAuditFindings",
      "application-signals:ListEntityEvents",
      "application-signals:ListServiceStates",
      "application-signals:ListGroupingAttributeDefinitions",
      "cloudwatch:GetMetricStatistics",
      "xray:BatchGetTraces",
      "xray:GetTraceSegmentDestination",
      "synthetics:DescribeCanaries",
    ],
    resources: ["*"],
  },
  {
    sid: "ApplicationSignalsSlo",
    actions: ["application-signals:GetServiceLevelObjective"],
    resources: [ofTheAccount("application-signals", "slo/*")],
  },
  {
    sid: "SyntheticsCanaryRuns",
    actions: ["synthetics:GetCanaryRuns"],
    resources: [ofTheAccount("synthetics", "canary:*")],
  },
  {
    sid: "ElastiCacheResources",
    // aws-elasticache: clusters, replication groups and serverless caches.
    actions: [
      "elasticache:DescribeCacheClusters",
      "elasticache:DescribeReplicationGroups",
      "elasticache:DescribeServerlessCaches",
    ],
    resources: [
      ofTheAccount("elasticache", "cluster:*"),
      ofTheAccount("elasticache", "replicationgroup:*"),
      ofTheAccount("elasticache", "serverlesscache:*"),
    ],
  },
  {
    sid: "ElastiCacheCatalog",
    // Events, engine versions, default parameters and service updates: no resource type.
    actions: [
      "elasticache:DescribeEvents",
      "elasticache:DescribeCacheEngineVersions",
      "elasticache:DescribeEngineDefaultParameters",
      "elasticache:DescribeServiceUpdates",
    ],
    resources: ["*"],
  },
  {
    sid: "OpsInventory",
    // aws-ops (Mango's own pack, list of its report): instances, Auto Scaling, load balancers,
    // ECS lists, stacks, Config history. No resource type for any of them. `ecs:ListTasks`
    // names a container instance only as an optional filter: `*`.
    actions: [
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeScalingActivities",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
      "ecs:ListClusters",
      "ecs:ListServices",
      "ecs:ListTasks",
      "cloudformation:ListStacks",
      "config:GetResourceConfigHistory",
    ],
    resources: ["*"],
  },
  {
    sid: "OpsEcsClusters",
    actions: ["ecs:DescribeClusters"],
    resources: [ofTheAccount("ecs", "cluster/*")],
  },
  {
    sid: "OpsEcsServices",
    actions: ["ecs:DescribeServices", "ecs:ListServiceDeployments"],
    resources: [ofTheAccount("ecs", "service/*/*")],
  },
  {
    sid: "OpsEcsDeployments",
    actions: ["ecs:DescribeServiceDeployments"],
    resources: [ofTheAccount("ecs", "service/*/*"), ofTheAccount("ecs", "service-deployment/*/*/*")],
  },
  {
    sid: "OpsEcsTasks",
    // Never `ecs:DescribeTaskDefinition`: task definitions carry environment variables. The
    // overrides of a task may carry some too: the pack's entry point leaves them out.
    actions: ["ecs:DescribeTasks"],
    resources: [ofTheAccount("ecs", "task/*/*")],
  },
  {
    sid: "OpsStackEvents",
    actions: ["cloudformation:DescribeStackEvents"],
    resources: [ofTheAccount("cloudformation", "stack/*/*")],
  },
  {
    sid: "RdsInstances",
    // aws-rds (Mango's own pack): instances, their log files and a bounded portion of one
    // (D55 precision, proposed: the entry point bounds lines and size).
    actions: ["rds:DescribeDBInstances", "rds:DescribeDBLogFiles", "rds:DownloadDBLogFilePortion"],
    resources: [ofTheAccount("rds", "db:*")],
  },
  {
    sid: "RdsClusters",
    actions: ["rds:DescribeDBClusters"],
    resources: [ofTheAccount("rds", "cluster:*")],
  },
  {
    sid: "RdsParameters",
    actions: ["rds:DescribeDBParameters", "rds:DescribeDBClusterParameters"],
    resources: [ofTheAccount("rds", "pg:*"), ofTheAccount("rds", "cluster-pg:*")],
  },
  {
    sid: "RdsMaintenanceAndBackups",
    actions: [
      "rds:DescribePendingMaintenanceActions",
      "rds:DescribeDBSnapshots",
      "rds:DescribeDBClusterSnapshots",
    ],
    resources: [
      ofTheAccount("rds", "db:*"),
      ofTheAccount("rds", "cluster:*"),
      ofTheAccount("rds", "snapshot:*"),
      ofTheAccount("rds", "cluster-snapshot:*"),
    ],
  },
  {
    sid: "RdsEvents",
    // No resource type.
    actions: ["rds:DescribeEvents"],
    resources: ["*"],
  },
  {
    sid: "PerformanceInsights",
    // Load by wait, top SQL as tokenized digests, OS metrics. Never the full text of a
    // statement (`pi:GetDimensionKeyDetails`): literals may hold personal data.
    actions: ["pi:GetResourceMetrics", "pi:DescribeDimensionKeys", "pi:ListAvailableResourceMetrics"],
    resources: [ofTheAccount("pi", "metrics/rds/*")],
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
          '"*" (no usable resource type in the IAM service reference). Exact read-only actions. Agreed on 2026-10-02. ' +
          "Also, proposed on 2026-11-13, the actions of the SRE and database packs that have no resource type in " +
          "the IAM service reference (statements CloudTrailLookupEvents, ApplicationSignalsRead, ElastiCacheCatalog, " +
          "OpsInventory, RdsEvents).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:cloudwatch:*:<AWS::AccountId>:alarm:*]`,
        reason:
          "The same template goes to every member account: alarm names and Regions are not known. Scoped to " +
          "the alarms of the account the role lives in. Agreed on 2026-10-02.",
      },
      // The packs of 2026-11-13 (proposed): one acknowledgment per resource pattern, never one
      // for the whole role.
      ...MEMBER_READ_ONLY_STATEMENTS.flatMap((statement) =>
        statement.resources
          .filter((resource) => resource !== "*" && resource !== ALARMS_OF_THE_ACCOUNT)
          .map((resource) => ({
            id: `AwsSolutions-IAM5[Resource::${resource}]`,
            reason:
              `${statement.sid}: the same template goes to every member account, so resource names and Regions ` +
              "are not known. Scoped to that resource type in the account the role lives in; exact read-only " +
              "actions. Proposed on 2026-11-13.",
          })),
      ),
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
