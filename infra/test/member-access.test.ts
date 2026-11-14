import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { Installation, installationSchema, loadInstallation } from "../lib/config/schema.js";
import { SESSION_TAG_KEYS } from "../lib/names.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import {
  MEMBER_READ_ONLY_DATA_ACTIONS,
  MEMBER_READ_ONLY_STATEMENTS,
  MemberStack,
  synthMemberTemplate,
} from "../lib/stacks/member-stack.js";
import { FAILURE_TOLERANCE_PERCENT, OrgAccessStack } from "../lib/stacks/org-access-stack.js";
import { instantiate, Values } from "./parameters.js";
import { expectOnlyTheEvalsContentDeny } from "./evals-deny.js";

const examplePath = resolve(import.meta.dirname, "../config/example.json");
const cfg = loadInstallation(examplePath);
const raw = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;
const ns = cfg.namespace;
const MANGO = cfg.mangoAccountId;
const BROKER = `arn:aws:iam::${MANGO}:role/Mango-${ns}-ReadBroker`;
const PROBE_ROLE = `Mango-${ns}-AdminProbe`;

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Principal?: { AWS?: unknown; Service?: unknown };
  Condition?: Record<string, Record<string, unknown>>;
}
interface Resource {
  Type: string;
  Properties: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const listed = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);
const byAction = (statements: Statement[]) =>
  Object.fromEntries(statements.flatMap((s) => listed(s.Action).map((action) => [action, s])));

/** What an installer would pass to the parameterized templates for the example installation. */
const MEMBER_VALUES: Values = {
  Namespace: ns,
  MangoAccountId: MANGO,
  OrganizationId: cfg.organizationId,
  "AWS::Partition": "aws",
};
const ORG_ACCESS_VALUES: Values = {
  ...MEMBER_VALUES,
  Targets: cfg.orgAccess!.targets,
  ExcludedAccountIds: [MANGO],
  CallAs: "SELF",
};

/** The spoke template as synthesized: the same for every customer. */
const memberSource = () => Template.fromStack(new MemberStack(new App(), "Member")).toJSON() as Record<string, unknown>;
/** And as CloudFormation deploys it for the example installation. */
function member(values: Values = MEMBER_VALUES): Template {
  return Template.fromJSON(instantiate(memberSource(), values));
}

const orgAccessSource = () => Template.fromStack(new OrgAccessStack(new App(), "OrgAccess"));
function orgAccess(values: Values = ORG_ACCESS_VALUES): Template {
  return Template.fromJSON(instantiate(orgAccessSource().toJSON() as Record<string, unknown>, values));
}

const core = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: MANGO, region: cfg.region },
  }),
);

describe("Member (spoke template of every member account)", () => {
  const template = member();
  const resources = template.toJSON().Resources as Record<string, Resource>;

  it("contains one role and its inline policy, nothing else: no assets, no bootstrap", () => {
    const json = template.toJSON() as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["Description", "Parameters", "Resources"]);
    expect(Object.values(resources).map((r) => r.Type).sort()).toEqual(["AWS::IAM::Policy", "AWS::IAM::Role"]);
    const [role] = Object.values(resources);
    expect(role!.Properties.RoleName).toBe(`Mango-${ns}-ReadOnly`);
    expect(role!.Properties.MaxSessionDuration).toBe(3600);
  });

  it("trusts only the Read broker of the Mango account, of the organization, with SourceIdentity", () => {
    const [role] = Object.values(resources);
    const statements = role!.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(statements.flatMap((s) => listed(s.Action)).sort()).toEqual([
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
      "sts:TagSession",
    ]);
    for (const statement of statements) {
      expect(statement.Effect).toBe("Allow");
      // The account as principal, narrowed by condition: the spoke may exist before the broker.
      expect(JSON.stringify(statement.Principal)).toContain(`:iam::${MANGO}:root`);
      expect(statement.Principal?.Service).toBeUndefined();
      expect(statement.Condition?.ArnEquals).toEqual({ "aws:PrincipalArn": BROKER });
      expect(statement.Condition?.StringEquals).toEqual({ "aws:PrincipalOrgID": cfg.organizationId });
    }
    const trust = byAction(statements);
    expect(trust["sts:AssumeRole"]!.Condition?.Null).toEqual({ "sts:SourceIdentity": "false" });
    expect(trust["sts:TagSession"]!.Condition?.["ForAllValues:StringEquals"]).toEqual({
      "aws:TagKeys": SESSION_TAG_KEYS,
    });
    expect(JSON.stringify(statements)).not.toContain("sts:ExternalId");
  });

  const policy = () => {
    const policies = Object.values(resources).filter((r) => r.Type === "AWS::IAM::Policy");
    expect(policies).toHaveLength(1);
    return policies[0]!.Properties.PolicyDocument.Statement as Statement[];
  };

  it("grants exactly the read actions of the release's packs, and never a managed policy", () => {
    const [role] = Object.values(resources).filter((r) => r.Type === "AWS::IAM::Role");
    expect(role!.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role!.Properties.Policies).toBeUndefined();
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
    const statements = policy();
    expect(statements.every((s) => s.Effect === "Allow" && s.Condition === undefined)).toBe(true);
    expect(statements.flatMap((s) => listed(s.Action)).sort()).toEqual([...MEMBER_READ_ONLY_DATA_ACTIONS].sort());
    // CloudWatch metrics and alarms, and the metadata of log groups (user, 2026-10-02); the
    // actions of the SRE and database packs and bounded Logs Insights (proposed, 2026-11-13).
    expect([...MEMBER_READ_ONLY_DATA_ACTIONS].sort()).toEqual([
      "application-signals:GetService",
      "application-signals:GetServiceLevelObjective",
      "application-signals:ListAuditFindings",
      "application-signals:ListEntityEvents",
      "application-signals:ListGroupingAttributeDefinitions",
      "application-signals:ListServiceDependencies",
      "application-signals:ListServiceDependents",
      "application-signals:ListServiceLevelObjectives",
      "application-signals:ListServiceOperations",
      "application-signals:ListServiceStates",
      "application-signals:ListServices",
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeScalingActivities",
      "cloudformation:DescribeStackEvents",
      "cloudformation:ListStacks",
      "cloudtrail:LookupEvents",
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "config:GetResourceConfigHistory",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeInstances",
      "ecs:DescribeClusters",
      "ecs:DescribeServiceDeployments",
      "ecs:DescribeServices",
      "ecs:DescribeTasks",
      "ecs:ListClusters",
      "ecs:ListServiceDeployments",
      "ecs:ListServices",
      "ecs:ListTasks",
      "elasticache:DescribeCacheClusters",
      "elasticache:DescribeCacheEngineVersions",
      "elasticache:DescribeEngineDefaultParameters",
      "elasticache:DescribeEvents",
      "elasticache:DescribeReplicationGroups",
      "elasticache:DescribeServerlessCaches",
      "elasticache:DescribeServiceUpdates",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
      "logs:DescribeLogGroups",
      "logs:DescribeQueryDefinitions",
      "logs:GetQueryResults",
      "logs:ListAnomalies",
      "logs:ListLogAnomalyDetectors",
      "logs:StartQuery",
      "pi:DescribeDimensionKeys",
      "pi:GetResourceMetrics",
      "pi:ListAvailableResourceMetrics",
      "rds:DescribeDBClusterParameters",
      "rds:DescribeDBClusterSnapshots",
      "rds:DescribeDBClusters",
      "rds:DescribeDBInstances",
      "rds:DescribeDBLogFiles",
      "rds:DescribeDBParameters",
      "rds:DescribeDBSnapshots",
      "rds:DescribeEvents",
      "rds:DescribePendingMaintenanceActions",
      "rds:DownloadDBLogFilePortion",
      "synthetics:DescribeCanaries",
      "synthetics:GetCanaryRuns",
      "xray:BatchGetTraces",
      "xray:GetTraceSegmentDestination",
    ]);
    expect(new Set(MEMBER_READ_ONLY_DATA_ACTIONS).size).toBe(MEMBER_READ_ONLY_DATA_ACTIONS.length);
  });

  /**
   * Read actions whose name does not start with Get, List or Describe, each one allowed by a
   * decision. All of them are read actions in the IAM service reference (checked 2026-11-13).
   */
  const READS_BY_DECISION: Record<string, string> = {
    // D55 (3) precision (proposed 2026-11-13): bounded Logs Insights queries of aws-cloudwatch.
    "logs:StartQuery": "D55 (3) precision",
    // aws-cloudtrail (proposed 2026-11-13): management events of the last 90 days.
    "cloudtrail:LookupEvents": "aws-cloudtrail",
    // aws-application-signals (proposed 2026-11-13): traces by id.
    "xray:BatchGetTraces": "aws-application-signals",
    // aws-rds and D55 precision (proposed 2026-11-13): a bounded portion of a database log file.
    "rds:DownloadDBLogFilePortion": "D55 precision, aws-rds",
  };

  it("lists exact read-only actions: no wildcard, nothing that writes, starts a job or manages", () => {
    const services = [
      "application-signals",
      "autoscaling",
      "cloudformation",
      "cloudtrail",
      "cloudwatch",
      "config",
      "ec2",
      "ecs",
      "elasticache",
      "elasticloadbalancing",
      "logs",
      "pi",
      "rds",
      "synthetics",
      "xray",
    ];
    const read = new RegExp(`^(${services.join("|")}):(Get|List|Describe)[A-Za-z0-9]+$`);
    for (const action of MEMBER_READ_ONLY_DATA_ACTIONS) {
      if (action in READS_BY_DECISION) continue;
      expect(action).toMatch(read);
    }
    // Every exception is still in the list: a stale one would hide a new action.
    for (const action of Object.keys(READS_BY_DECISION)) expect(MEMBER_READ_ONLY_DATA_ACTIONS).toContain(action);
  });

  it("reads no log events and cannot reach the queries of other people", () => {
    for (const action of [
      // Content of log groups, outside a bounded Logs Insights query (D55 (3)).
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:GetLogRecord",
      "logs:StartLiveTail",
      "logs:Unmask",
      // A query is named by an id: listing or stopping one reaches somebody else's.
      "logs:StopQuery",
      "logs:DescribeQueries",
      // The full text of a SQL statement (only tokenized SQL, 2026-11-13).
      "pi:GetDimensionKeyDetails",
      // Environment variables of every task (aws-ops, 2026-11-13).
      "ecs:DescribeTaskDefinition",
      // CloudTrail Lake: a Write action in IAM, billed per GB scanned.
      "cloudtrail:StartQuery",
    ]) {
      expect(MEMBER_READ_ONLY_DATA_ACTIONS).not.toContain(action);
    }
    expect(MEMBER_READ_ONLY_DATA_ACTIONS.filter((a) => /^(rds-data|secretsmanager|redshift|lambda|s3|kms):/.test(a))).toEqual([]);
  });

  it("names the resource of the account the role lives in, and uses '*' only where the API has no resource", () => {
    const bySid: Record<string, Statement> = Object.fromEntries(policy().map((s) => [s.Sid, s]));
    expect(Object.keys(bySid).sort()).toEqual(MEMBER_READ_ONLY_STATEMENTS.map((s) => s.sid).sort());
    expect(bySid.ReadAlarms!.Resource).toEqual({
      "Fn::Join": ["", ["arn:aws:cloudwatch:*:", { Ref: "AWS::AccountId" }, ":alarm:*"]],
    });
    expect(listed(bySid.ReadMetrics!.Action)).toEqual(["cloudwatch:GetMetricData"]);
    // The statements on "*": their actions have no resource type in the IAM service reference.
    const anywhere = Object.values(bySid)
      .filter((s) => listed(s.Resource).includes("*"))
      .map((s) => s.Sid!)
      .sort();
    expect(anywhere).toEqual([
      "ApplicationSignalsRead",
      "CloudTrailLookupEvents",
      "ElastiCacheCatalog",
      "ListLogGroups",
      "OpsInventory",
      "RdsEvents",
      "ReadMetrics",
    ]);
    for (const sid of anywhere) expect(bySid[sid]!.Resource).toBe("*");
    // Every other one: resources of this account only, in any Region.
    for (const statement of Object.values(bySid).filter((s) => !anywhere.includes(s.Sid!))) {
      for (const resource of listed(statement.Resource)) {
        const [, [prefix, account]] = (resource as { "Fn::Join": [string, [string, unknown, string]] })["Fn::Join"];
        expect(prefix, statement.Sid).toMatch(/^arn:aws:[a-z0-9-]+:\*:$/);
        expect(account, statement.Sid).toEqual({ Ref: "AWS::AccountId" });
      }
    }
    expect(listed(bySid.QueryLogGroups!.Action).sort()).toEqual(["logs:GetQueryResults", "logs:StartQuery"]);
    expect(JSON.stringify(bySid.QueryLogGroups!.Resource)).toContain(":log-group:*");
    expect(JSON.stringify(bySid.ListLogAnomalies!.Resource)).toContain(":anomaly-detector:*");
    expect(JSON.stringify(bySid.OpsEcsTasks!.Resource)).toContain(":task/*/*");
    expect(JSON.stringify(bySid.RdsInstances!.Resource)).toContain(":db:*");
    expect(listed(bySid.RdsInstances!.Action)).toContain("rds:DownloadDBLogFilePortion");
  });

  it("is the same template for every customer: the installation's values are its only parameters (D58)", () => {
    const source = memberSource();
    expect(Object.keys(source.Parameters as object).sort()).toEqual(["MangoAccountId", "Namespace", "OrganizationId"]);
    for (const parameter of Object.values(source.Parameters as Record<string, { AllowedPattern?: string; Default?: string }>)) {
      expect(parameter.AllowedPattern).toMatch(/^\^.*\$$/);
      expect(parameter.Default).toBeUndefined();
    }
    const text = JSON.stringify(source);
    // No account, organization or namespace of anyone is written in it.
    expect(text).not.toMatch(/[0-9]{12}/);
    expect(text).not.toMatch(/o-[a-z0-9]{10}/);
    expect(text).not.toContain(`Mango-${ns}-`);
    expect(text).not.toContain("BootstrapVersion");
  });

  it("fits the StackSet's inline template", () => {
    // The list is no longer in the provisioner's environment (ceilings.py, packs.test.ts).
    expect(JSON.stringify(synthMemberTemplate()).length).toBeLessThan(51_200);
  });

  it("carries no scanner suppression", () => {
    for (const template of [member(), orgAccess()]) {
      for (const resource of Object.values(template.toJSON().Resources as Record<string, { Metadata?: object }>)) {
        expect(resource.Metadata ?? {}).not.toHaveProperty("guard");
        expect(resource.Metadata ?? {}).not.toHaveProperty("checkov");
      }
    }
  });

  it("carries the namespace in every global name (rule 6)", () => {
    const other = member({ ...MEMBER_VALUES, Namespace: "acme" });
    const text = JSON.stringify(other.toJSON());
    expect(text).toContain("Mango-acme-ReadOnly");
    expect(text).toContain("role/Mango-acme-ReadBroker");
    expect(text).not.toContain(`Mango-${ns}-`);
  });
});

describe("OrgAccess (management account or StackSets delegated administrator)", () => {
  const source = orgAccessSource().toJSON() as {
    Parameters: Record<string, { Type: string; AllowedPattern?: string; AllowedValues?: string[]; Default?: string }>;
    Rules: Record<string, { Assertions: { Assert: unknown }[] }>;
  };
  const template = orgAccess();
  const stackSets = Object.values(template.findResources("AWS::CloudFormation::StackSet"));
  const stackSet = stackSets[0]!.Properties;

  it("contains only the StackSet: no role, no function, no bucket, no bootstrap", () => {
    const types = Object.values(template.toJSON().Resources as Record<string, Resource>).map((r) => r.Type);
    expect(types.filter((t) => t !== "AWS::CDK::Metadata")).toEqual(["AWS::CloudFormation::StackSet"]);
    expect(JSON.stringify(source)).not.toContain("BootstrapVersion");
  });

  it("asks only for where the roles go and for what the spoke template needs (D58)", () => {
    expect(Object.keys(source.Parameters).sort()).toEqual([
      "CallAs",
      "ExcludedAccountIds",
      "MangoAccountId",
      "Namespace",
      "OrganizationId",
      "Targets",
    ]);
    const text = JSON.stringify(source);
    expect(text).not.toMatch(/[0-9]{12}/);
    expect(text).not.toMatch(/"ou-|"r-[0-9a-z]{4}"/);
  });

  it("is service-managed, with auto-deployment that removes the role when an account leaves", () => {
    expect(stackSet.StackSetName).toBe(`Mango-${ns}-Member`);
    expect(stackSet.PermissionModel).toBe("SERVICE_MANAGED");
    expect(stackSet.AutoDeployment).toEqual({ Enabled: true, RetainStacksOnAccountRemoval: false });
    expect(stackSet.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(stackSet.AdministrationRoleARN).toBeUndefined();
    expect(stackSet.ExecutionRoleName).toBeUndefined();
  });

  it("hands the spoke template the installation's values and nothing else", () => {
    expect(stackSet.Parameters).toEqual([
      { ParameterKey: "Namespace", ParameterValue: ns },
      { ParameterKey: "MangoAccountId", ParameterValue: MANGO },
      { ParameterKey: "OrganizationId", ParameterValue: cfg.organizationId },
    ]);
  });

  it("deploys to the given targets, in the stack's region, tolerating few failures", () => {
    expect(stackSet.StackInstancesGroup).toEqual([
      {
        Regions: [{ Ref: "AWS::Region" }],
        DeploymentTargets: {
          OrganizationalUnitIds: cfg.orgAccess!.targets,
          AccountFilterType: "DIFFERENCE",
          Accounts: [MANGO],
        },
      },
    ]);
    expect(stackSet.OperationPreferences.FailureTolerancePercentage).toBe(FAILURE_TOLERANCE_PERCENT);
    expect(FAILURE_TOLERANCE_PERCENT).toBeLessThan(100);
  });

  it("never deploys the member role to the Mango account (D51)", () => {
    expect(source.Rules.MangoAccountIsExcluded!.Assertions).toEqual([
      expect.objectContaining({
        Assert: { "Fn::Contains": [{ Ref: "ExcludedAccountIds" }, { Ref: "MangoAccountId" }] },
      }),
    ]);
    // No default: whoever installs has to name the excluded accounts.
    expect(source.Parameters.ExcludedAccountIds!.Default).toBeUndefined();
  });

  it("only accepts the root alone or a list of OUs, and well-formed account ids", () => {
    const targets = new RegExp(source.Parameters.Targets!.AllowedPattern!);
    // CloudFormation checks each element of a list parameter against the pattern.
    for (const ok of ["r-abcd", "ou-abcd-11111111"]) expect(ok).toMatch(targets);
    for (const bad of ["", "*", "ou-abcd", "111111111111", "o-exampleorg1"]) expect(bad).not.toMatch(targets);
    const accounts = new RegExp(source.Parameters.ExcludedAccountIds!.AllowedPattern!);
    expect("111111111111").toMatch(accounts);
    for (const bad of ["", "1234", "*", "ou-abcd-11111111"]) expect(bad).not.toMatch(accounts);
  });

  it("carries the spoke template inline, identical to the one synthesized on its own", () => {
    expect(stackSet.TemplateURL).toBeUndefined();
    const body = stackSet.TemplateBody as string;
    expect(JSON.parse(body)).toEqual(memberSource());
    expect(JSON.parse(body)).toEqual(synthMemberTemplate());
    const sha256 = createHash("sha256").update(body).digest("hex");
    template.hasOutput("MemberTemplateSha256", { Value: sha256 });
    expect(stackSet.Description).toContain(`sha256:${sha256.slice(0, 16)}`);
  });

  it("carries a spoke template of plain ASCII, so the StackSet stores it byte for byte", () => {
    // CloudFormation replaces any other character with `?`: the hash would never match.
    // eslint-disable-next-line no-control-regex
    expect(stackSet.TemplateBody as string).toMatch(/^[\x00-\x7F]*$/);
  });

  it("calls as the management account by default and as a delegated administrator when asked", () => {
    expect(source.Parameters.CallAs).toMatchObject({ Default: "SELF", AllowedValues: ["SELF", "DELEGATED_ADMIN"] });
    expect(stackSet.CallAs).toBe("SELF");
    const [other] = Object.values(
      orgAccess({ ...ORG_ACCESS_VALUES, Targets: ["r-abcd"], CallAs: "DELEGATED_ADMIN" }).findResources(
        "AWS::CloudFormation::StackSet",
      ),
    );
    expect(other!.Properties.CallAs).toBe("DELEGATED_ADMIN");
    expect(other!.Properties.StackInstancesGroup[0].DeploymentTargets.OrganizationalUnitIds).toEqual(["r-abcd"]);
  });
});

describe("orgAccess configuration", () => {
  const parse = (access: unknown) => installationSchema.safeParse({ ...raw, orgAccess: access });

  it("accepts the root alone or a list of OUs", () => {
    expect(parse({ targets: ["r-abcd"] }).success).toBe(true);
    expect(parse({ targets: ["ou-abcd-11111111", "ou-abcd-22222222"] }).success).toBe(true);
  });

  it.each([
    ["no targets", { targets: [] }],
    ["an account as a target", { targets: ["111111111111"] }],
    ["the root mixed with OUs", { targets: ["r-abcd", "ou-abcd-11111111"] }],
    ["duplicate targets", { targets: ["ou-abcd-11111111", "ou-abcd-11111111"] }],
    ["a wildcard", { targets: ["*"] }],
    ["an invalid excluded account", { targets: ["r-abcd"], excludedAccountIds: ["1234"] }],
    ["the management account as excluded", { targets: ["r-abcd"], excludedAccountIds: [cfg.managementAccountId] }],
    ["an unknown key", { targets: ["r-abcd"], regions: ["us-west-2"] }],
  ])("rejects %s", (_name, access) => {
    expect(parse(access).success).toBe(false);
  });
});

describe("ReadBroker (Core)", () => {
  const roles = core.findResources("AWS::IAM::Role", { Properties: { RoleName: `Mango-${ns}-ReadBroker` } });
  const [brokerId, broker] = Object.entries(roles)[0]!;
  const policies = Object.values(core.findResources("AWS::IAM::Policy")) as Resource[];
  const refersTo = (value: unknown, logicalId: string) => JSON.stringify(value).includes(`"${logicalId}"`);
  const probeRoleId = Object.keys(
    core.findResources("AWS::IAM::Role", { Properties: { RoleName: PROBE_ROLE } }),
  )[0]!;

  it("trusts exactly the AdminProbe role, of the organization, with SourceIdentity", () => {
    const all = broker.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    // The daily account health has statements of its own (D84, account-health.test.ts).
    const statements = all.filter((s) => !s.Sid?.startsWith("AccountHealth"));
    expect(all.length - statements.length).toBe(2);
    expect(statements.flatMap((s) => listed(s.Action)).sort()).toEqual([
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
      "sts:TagSession",
    ]);
    for (const statement of statements) {
      expect(JSON.stringify(statement.Principal)).toContain(`:iam::${MANGO}:root`);
      expect(statement.Condition?.ArnEquals).toEqual({
        "aws:PrincipalArn": [{ "Fn::GetAtt": [probeRoleId, "Arn"] }],
      });
      expect(statement.Condition?.StringEquals).toEqual({ "aws:PrincipalOrgID": cfg.organizationId });
    }
    expect(byAction(statements)["sts:AssumeRole"]!.Condition?.Null).toEqual({ "sts:SourceIdentity": "false" });
    // Never as the system identity of the daily account health (D84).
    for (const action of ["sts:AssumeRole", "sts:SetSourceIdentity"]) {
      expect(byAction(statements)[action]!.Condition?.StringNotEqualsIgnoreCase).toEqual({ "sts:SourceIdentity": "mango-health" });
    }
    expect(broker.Properties.MaxSessionDuration).toBe(3600);
  });

  it("can only assume the spoke role, in accounts of the organization, and holds no data permission", () => {
    expectOnlyTheEvalsContentDeny(broker.Properties.ManagedPolicyArns);
    const own = policies.filter((p) => refersTo(p.Properties.Roles, brokerId));
    expect(own).toHaveLength(1);
    const statements = own[0]!.Properties.PolicyDocument.Statement as Statement[];
    const spoke = `arn:aws:iam::*:role/Mango-${ns}-ReadOnly`;
    expect(statements).toEqual([
      {
        Sid: "AssumeMemberReadOnly",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: spoke,
        Condition: { StringEquals: { "aws:ResourceOrgID": cfg.organizationId } },
      },
      {
        Sid: "PassIdentityToMemberReadOnly",
        Effect: "Allow",
        Action: ["sts:SetSourceIdentity", "sts:TagSession"],
        Resource: spoke,
      },
    ]);
  });

  it("is the role the spoke template trusts", () => {
    expect(JSON.stringify(member().toJSON())).toContain(BROKER);
  });

  it("is named in the identity policy of the AdminProbe, of the daily account health and of nobody else", () => {
    const naming = policies.filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes("ReadBroker"));
    expect(naming).toHaveLength(2);
    const healthRoleId = Object.keys(
      core.findResources("AWS::IAM::Role", { Properties: { RoleName: `Mango-${ns}-AccountHealth` } }),
    )[0]!;
    expect(naming.map((p) => [probeRoleId, healthRoleId].find((id) => refersTo(p.Properties.Roles, id))).sort()).toEqual(
      [probeRoleId, healthRoleId].sort(),
    );
    const managed = Object.values(core.findResources("AWS::IAM::ManagedPolicy")) as Resource[];
    // The only managed policy that names it is the permissions boundary of pack roles: a
    // ceiling, not a grant. Who can use the broker is still decided by its trust (D49, D51).
    const ceilings = managed.filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes("ReadBroker"));
    expect(ceilings.map((p) => p.Properties.ManagedPolicyName)).toEqual([`Mango-${ns}-mcp-boundary`]);
    const inBoundary = (ceilings[0]!.Properties.PolicyDocument.Statement as Statement[]).filter((s) =>
      JSON.stringify(s).includes("ReadBroker"),
    );
    expect(inBoundary.map((s) => s.Sid)).toEqual(["AssumeBroker"]);
    // Nobody in Core can reach the spoke role without the broker.
    for (const policy of [...policies, ...managed]) {
      if (refersTo(policy.Properties.Roles ?? [], brokerId)) continue;
      expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain(`Mango-${ns}-ReadOnly`);
    }
  });

  it("tells the AdminProbe where the chain is", () => {
    const [probe] = Object.values(
      core.findResources("AWS::Lambda::Function", { Properties: { FunctionName: PROBE_ROLE } }),
    );
    const variables = probe!.Properties.Environment.Variables as Record<string, unknown>;
    expect(variables.READ_BROKER_ROLE_ARN).toBe(BROKER);
    expect(variables.MEMBER_READ_ROLE_NAME).toBe(`Mango-${ns}-ReadOnly`);
    // The accounts it checks are the ones the StackSet reaches (same configuration).
    expect(variables.ORG_ACCESS_TARGETS).toBe(cfg.orgAccess!.targets.join(","));
    expect(variables.ORG_ACCESS_EXCLUDED_ACCOUNT_IDS).toBe(cfg.orgAccess!.excludedAccountIds.join(","));
  });
});
