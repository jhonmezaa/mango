import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { GLOBAL_METRICS_REGION, OPERATIONAL_THRESHOLDS } from "../lib/constructs/operational-alarms.js";
import { PACK_DNS_BLOCKED_QUERIES } from "../lib/constructs/pack-network.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { PackNetworkStack } from "../lib/stacks/pack-network-stack.js";
import { instantiate } from "./parameters.js";

/* Operational alarms and the dashboard (D71): what would otherwise fail in silence. */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Resource = { Type: string; Properties: any };
type Resources = Record<string, Resource>;
interface Query {
  Id: string;
  Expression?: string;
  Period?: number;
  MetricStat?: { Metric: { Namespace: string; MetricName: string; Dimensions?: Dimension[] }; Period: number; Stat: string };
}
interface Dimension {
  Name: string;
  Value: unknown;
}

const resources = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
).toJSON().Resources as Resources;
const ofType = (all: Resources, type: string) => Object.entries(all).filter(([, r]) => r.Type === type);
const alarmsOf = (all: Resources) =>
  Object.fromEntries(ofType(all, "AWS::CloudWatch::Alarm").map(([, r]) => [r.Properties.AlarmName as string, r.Properties]));

const alarms = alarmsOf(resources);
/** The alarms of the publication path: they live in `Reconciler` and have their own tests. */
const PUBLICATION = ["AgentDeprovisioner-failed", "AgentProvisioner-failed", "AgentProvisioner-volume", "Reconciler-failed", "Reconciler-findings"];
const operational = Object.fromEntries(
  Object.entries(alarms).filter(([name]) => !PUBLICATION.some((suffix) => name === `Mango-${ns}-${suffix}`)),
);
const alarm = (suffix: string) => {
  const found = alarms[`Mango-${ns}-${suffix}`];
  expect(found, suffix).toBeDefined();
  return found;
};
const queries = (properties: any): Query[] => properties.Metrics ?? [];
/** Metrics an alarm reads, whether it is written as one metric or as an expression. */
const metricsOf = (properties: any): { namespace: string; name: string; dimensions: Dimension[]; stat: string; period: number }[] =>
  properties.Metrics === undefined
    ? [
        {
          namespace: properties.Namespace,
          name: properties.MetricName,
          dimensions: properties.Dimensions ?? [],
          stat: properties.Statistic,
          period: properties.Period,
        },
      ]
    : queries(properties)
        .filter((q) => q.MetricStat !== undefined)
        .map((q) => ({
          namespace: q.MetricStat!.Metric.Namespace,
          name: q.MetricStat!.Metric.MetricName,
          dimensions: q.MetricStat!.Metric.Dimensions ?? [],
          stat: q.MetricStat!.Stat,
          period: q.MetricStat!.Period,
        }));
const expressionOf = (properties: any) => queries(properties).find((q) => q.Expression !== undefined)?.Expression;
const dimension = (dimensions: Dimension[], name: string) => dimensions.find((d) => d.Name === name)?.Value;

const topicId = ofType(resources, "AWS::SNS::Topic").map(([id]) => id);
const tables = ofType(resources, "AWS::DynamoDB::GlobalTable");

describe("operational alarms of Core", () => {
  it("creates these alarms, besides one per table", () => {
    const names = Object.keys(operational).filter((name) => !name.startsWith(`Mango-${ns}-Table-`));
    expect(names.sort()).toEqual(
      [
        "Api-errors",
        "Api-no-healthy-targets",
        "Api-tasks-below-desired",
        "Api-unhealthy-targets",
        "Api-unreachable",
        "DynamoDB-system-errors",
        "Edge-errors",
        "Edge-rate-limited",
        "GatewayInterceptor-failing",
        "PreSignUp-throttled",
        "PreTokenGeneration-failing",
        "UninstallGuard-failed",
      ].map((suffix) => `Mango-${ns}-${suffix}`),
    );
  });

  it("names every alarm after the installation and notifies the alerts topic, and nothing else", () => {
    expect(topicId).toHaveLength(1);
    for (const [name, properties] of Object.entries(alarms)) {
      expect(name).toMatch(new RegExp(`^Mango-${ns}-[A-Za-z0-9-]+$`));
      expect(properties.AlarmActions, name).toEqual([{ Ref: topicId[0] }]);
      expect(properties.OKActions, name).toBeUndefined();
      expect(properties.InsufficientDataActions, name).toBeUndefined();
    }
  });

  it("does not take missing data for a breach, with one exception, and says what to look at first", () => {
    // The load balancer stops reporting HealthyHostCount when no target is registered: for
    // this alarm, no data is the worst case (a service without tasks), not a quiet installation.
    const breachesWithoutData = [`Mango-${ns}-Api-no-healthy-targets`];
    for (const [name, properties] of Object.entries(operational)) {
      expect(properties.TreatMissingData, name).toBe(breachesWithoutData.includes(name) ? "breaching" : "notBreaching");
      expect(properties.AlarmDescription, name).toMatch(/Look first at /);
    }
    for (const name of breachesWithoutData) expect(operational[name], name).toBeDefined();
  });

  it("reads periods of one or five minutes, so that an alarm is evaluated at most 15 minutes late", () => {
    for (const [name, properties] of Object.entries(operational)) {
      const periods = [...metricsOf(properties).map((m) => m.period), ...queries(properties).flatMap((q) => q.Period ?? [])];
      expect(periods.length, name).toBeGreaterThan(0);
      for (const period of periods) expect([60, 300], name).toContain(period);
      expect(Math.max(...periods) * properties.EvaluationPeriods, name).toBeLessThanOrEqual(900);
    }
  });
});

describe("mango-api and its load balancer", () => {
  const [serviceId, service] = ofType(resources, "AWS::ECS::Service")[0]!;
  const [clusterId] = ofType(resources, "AWS::ECS::Cluster")[0]!;
  const [groupId] = ofType(resources, "AWS::ElasticLoadBalancingV2::TargetGroup")[0]!;

  it("compares the running tasks with what the service asks for, without writing a number of tasks", () => {
    const properties = alarm("Api-tasks-below-desired");
    expect(expressionOf(properties)).toBe("desired - running");
    const byId = Object.fromEntries(queries(properties).map((q) => [q.Id, q.MetricStat?.Metric]));
    expect(byId.desired!.MetricName).toBe("DesiredTaskCount");
    expect(byId.running!.MetricName).toBe("RunningTaskCount");
    for (const metric of [byId.desired!, byId.running!]) {
      expect(metric.Namespace).toBe("ECS/ContainerInsights");
      expect(dimension(metric.Dimensions!, "ClusterName")).toEqual({ Ref: clusterId });
      expect(dimension(metric.Dimensions!, "ServiceName")).toEqual({ "Fn::GetAtt": [serviceId, "Name"] });
    }
    // One task missing, however many the service runs: the threshold is a difference.
    expect(properties).toMatchObject({ Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", EvaluationPeriods: 5 });
    expect(service.Properties.DesiredCount).toBeDefined();
  });

  it("needs Container Insights on the cluster for those two metrics", () => {
    const settings = resources[clusterId]!.Properties.ClusterSettings as { Name: string; Value: string }[];
    expect(settings).toContainEqual({ Name: "containerInsights", Value: "enabled" });
  });

  it("alarms when no target is healthy, and when one stays unhealthy", () => {
    const none = alarm("Api-no-healthy-targets");
    expect(none).toMatchObject({ MetricName: "HealthyHostCount", Statistic: "Maximum", Threshold: 1, ComparisonOperator: "LessThanThreshold" });
    const some = alarm("Api-unhealthy-targets");
    expect(some).toMatchObject({ MetricName: "UnHealthyHostCount", Statistic: "Maximum", Threshold: 1, EvaluationPeriods: 5 });
    for (const properties of [none, some]) {
      expect(dimension(properties.Dimensions, "TargetGroup")).toEqual({ "Fn::GetAtt": [groupId, "TargetGroupFullName"] });
    }
  });

  it("creates the alarm that breaches without data after the service, so that it never waits for a first task", () => {
    const [, resource] = ofType(resources, "AWS::CloudWatch::Alarm").find(
      ([, r]) => r.Properties.AlarmName === `Mango-${ns}-Api-no-healthy-targets`,
    )!;
    expect((resource as Resource & { DependsOn?: string[] }).DependsOn).toContain(serviceId);
  });

  it("judges the 5xx rate of the API only above a minimum of requests", () => {
    const properties = alarm("Api-errors");
    expect(expressionOf(properties)).toBe(
      `IF(FILL(requests, 0) >= ${OPERATIONAL_THRESHOLDS.apiMinimumRequests}, 100 * FILL(errors, 0) / requests, 0)`,
    );
    expect(metricsOf(properties).map((m) => m.name).sort()).toEqual(["HTTPCode_Target_5XX_Count", "RequestCount"]);
    expect(properties).toMatchObject({
      Threshold: OPERATIONAL_THRESHOLDS.apiErrorPercent,
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
    });
  });

  it("alarms on the 5xx the load balancer answers itself", () => {
    expect(alarm("Api-unreachable")).toMatchObject({
      Namespace: "AWS/ApplicationELB",
      MetricName: "HTTPCode_ELB_5XX_Count",
      Statistic: "Sum",
      Threshold: OPERATIONAL_THRESHOLDS.albErrors,
    });
  });
});

describe("functions people depend on", () => {
  const functionNamed = (name: string) => {
    const found = ofType(resources, "AWS::Lambda::Function").filter(([, r]) => r.Properties.FunctionName === name);
    expect(found, name).toHaveLength(1);
    return { Ref: found[0]![0] };
  };

  it.each(["PreTokenGeneration", "GatewayInterceptor"])("alarms on errors and throttles of %s", (name) => {
    const properties = alarm(`${name}-failing`);
    const metrics = metricsOf(properties);
    expect(metrics.map((m) => m.name).sort()).toEqual(["Errors", "Throttles"]);
    for (const metric of metrics) {
      expect(metric.namespace).toBe("AWS/Lambda");
      expect(dimension(metric.dimensions, "FunctionName")).toEqual(functionNamed(`Mango-${ns}-${name}`));
    }
    expect(properties.Threshold).toBe(OPERATIONAL_THRESHOLDS.functionFailures);
  });

  it("does not alarm on the errors of the pre sign-up trigger: it refuses a sign-up by raising", () => {
    const properties = alarm("PreSignUp-throttled");
    expect(properties).toMatchObject({ Namespace: "AWS/Lambda", MetricName: "Throttles", Threshold: 1 });
    expect(dimension(properties.Dimensions, "FunctionName")).toEqual(functionNamed(`Mango-${ns}-PreSignUp`));
    expect(Object.keys(alarms).filter((name) => name.includes("PreSignUp"))).toEqual([`Mango-${ns}-PreSignUp-throttled`]);
  });

  it("alarms on the dead-letter queue of the uninstall guard", () => {
    const [queueId] = ofType(resources, "AWS::SQS::Queue").find(([, r]) => r.Properties.QueueName === `Mango-${ns}-UninstallGuard-dlq`)!;
    const properties = alarm("UninstallGuard-failed");
    expect(properties).toMatchObject({ MetricName: "ApproximateNumberOfMessagesVisible", Threshold: 1 });
    expect(dimension(properties.Dimensions, "QueueName")).toEqual({ "Fn::GetAtt": [queueId, "QueueName"] });
  });
});

describe("DynamoDB", () => {
  it("has one throttling alarm for every table of the stack, whichever they are", () => {
    expect(tables.length).toBeGreaterThanOrEqual(7);
    const watched = Object.entries(operational)
      .filter(([name]) => name.startsWith(`Mango-${ns}-Table-`))
      .map(([, properties]) => {
        const metrics = metricsOf(properties);
        expect(metrics.map((m) => m.name).sort()).toEqual(["ReadThrottleEvents", "WriteThrottleEvents"]);
        const names = metrics.map((m) => dimension(m.dimensions, "TableName"));
        expect(names[0]).toEqual(names[1]);
        return (names[0] as { Ref: string }).Ref;
      });
    expect(watched.sort()).toEqual(tables.map(([id]) => id).sort());
  });

  it("alarms on internal errors of any table and operation with one query", () => {
    const properties = alarm("DynamoDB-system-errors");
    expect(queries(properties)).toEqual([
      expect.objectContaining({
        Expression: 'SELECT SUM(SystemErrors) FROM SCHEMA("AWS/DynamoDB", Operation,TableName)',
        Period: 300,
        ReturnData: true,
      }),
    ]);
  });
});

describe("edge", () => {
  it("is synthesized for the Region where CloudFront and its web ACL report", () => {
    expect(cfg.region).toBe(GLOBAL_METRICS_REGION);
  });

  it("judges the 5xx rate of CloudFront only above a minimum of requests", () => {
    const properties = alarm("Edge-errors");
    const [distributionId] = ofType(resources, "AWS::CloudFront::Distribution")[0]!;
    expect(expressionOf(properties)).toBe(`IF(FILL(requests, 0) >= ${OPERATIONAL_THRESHOLDS.edgeMinimumRequests}, rate, 0)`);
    const metrics = metricsOf(properties);
    expect(metrics.map((m) => m.name).sort()).toEqual(["5xxErrorRate", "Requests"]);
    for (const metric of metrics) {
      expect(metric.namespace).toBe("AWS/CloudFront");
      // CloudFront reports under both dimensions; without `Region` the alarm would see nothing.
      expect(metric.dimensions).toEqual([
        { Name: "DistributionId", Value: { Ref: distributionId } },
        { Name: "Region", Value: "Global" },
      ]);
    }
  });

  it("alarms on the per-IP rate limit of the edge web ACL, not on every block of the managed rules", () => {
    const acl = ofType(resources, "AWS::WAFv2::WebACL").find(([, r]) => r.Properties.Scope === "CLOUDFRONT")![1].Properties;
    const rule = (acl.Rules as any[]).find((r) => r.Statement.RateBasedStatement !== undefined);
    const properties = alarm("Edge-rate-limited");
    const [metric] = metricsOf(properties);
    expect(metric).toMatchObject({ namespace: "AWS/WAFV2", name: "BlockedRequests", stat: "Sum" });
    // A CloudFront web ACL has no `Region` dimension.
    expect(metric!.dimensions).toEqual([
      { Name: "Rule", Value: rule.VisibilityConfig.MetricName },
      { Name: "WebACL", Value: acl.VisibilityConfig.MetricName },
    ]);
    expect(rule.Action).toEqual({ Block: {} });
    expect(properties.Threshold).toBe(OPERATIONAL_THRESHOLDS.rateLimited);
    expect(Object.keys(alarms).filter((name) => /waf|cognito/i.test(name))).toEqual([]);
  });
});

describe("dashboard", () => {
  it("is one, named after the installation, and shows every alarm of the stack", () => {
    const dashboards = ofType(resources, "AWS::CloudWatch::Dashboard");
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]![1].Properties.DashboardName).toBe(`Mango-${ns}-Operations`);
    const body = JSON.stringify(dashboards[0]![1].Properties.DashboardBody);
    for (const [id] of ofType(resources, "AWS::CloudWatch::Alarm")) expect(body, id).toContain(`"${id}"`);
  });
});

describe("a release (D58): names come from the Namespace parameter", () => {
  // No signed packs, whatever `dist/packs` holds on this machine.
  const context = { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")), skipSpa: true };
  const core = Template.fromStack(new CoreStack(new App({ context }), "Core", { env: { region: "us-east-1" } })).toJSON()
    .Resources as Resources;
  const network = Template.fromStack(
    new PackNetworkStack(new App({ context }), "PackNetwork", { env: { region: "us-east-1" } }),
  ).toJSON().Resources as Resources;
  const values = { Namespace: "acme", "AWS::AccountId": "111122223333", "AWS::Partition": "aws" };

  it("names the alarms and the dashboard of Core after the installation", () => {
    const names = Object.keys(alarmsOf(instantiate(core, values)));
    expect(names.length).toBe(Object.keys(alarms).length);
    for (const name of names) expect(name).toMatch(/^Mango-acme-[A-Za-z0-9-]+$/);
    const [dashboard] = ofType(instantiate(core, values), "AWS::CloudWatch::Dashboard");
    expect(dashboard![1].Properties.DashboardName).toBe("Mango-acme-Operations");
  });

  it("alarms in the pack network on the queries its DNS Firewall refuses (TM-E2)", () => {
    const found = ofType(network, "AWS::CloudWatch::Alarm");
    expect(found).toHaveLength(1);
    const properties = found[0]![1].Properties;
    expect(properties).toMatchObject({
      Namespace: "AWS/Route53Resolver",
      MetricName: "FirewallRuleQueryVolume",
      Statistic: "Sum",
      Period: 300,
      Threshold: PACK_DNS_BLOCKED_QUERIES,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
    // With the name of the installation in it, the description is no longer a plain string.
    const description = instantiate(properties.AlarmDescription, values);
    expect(description).toMatch(/Look first at /);
    expect(instantiate(properties.AlarmName, values)).toBe("Mango-acme-PackDns-blocked");

    // The list that refuses everything, in the rule group associated with the pack VPC: not
    // the list of what the AgentCore machine asks for by itself, which is refused before it.
    const [groupId, group] = ofType(network, "AWS::Route53Resolver::FirewallRuleGroup")[0]!;
    const blocking = (group.Properties.FirewallRules as any[]).filter((rule) => rule.Action === "BLOCK");
    expect(blocking.map((rule) => rule.Priority)).toEqual([150, 200]);
    const listOf = (rule: any) => network[rule.FirewallDomainListId["Fn::GetAtt"][0]]!.Properties;
    expect(listOf(blocking[0]).Domains).toEqual(["time.aws.com."]);
    expect(listOf(blocking[1]).Domains).toEqual(["*."]);
    expect(dimension(properties.Dimensions, "FirewallRuleGroupId")).toEqual({ "Fn::GetAtt": [groupId, "Id"] });
    expect(dimension(properties.Dimensions, "FirewallDomainListId")).toEqual(blocking[1].FirewallDomainListId);
    // It says where the names are, by the real name of the log group of this installation:
    // whoever reads the alert email can open it. The flow logs do not carry names.
    const [queryLog] = ofType(network, "AWS::Logs::LogGroup").filter(([id]) => id.includes("DnsQueries"));
    const logGroupName = instantiate(queryLog![1].Properties.LogGroupName, values);
    expect(logGroupName).toBe("Mango-acme-PackNetwork-dns-queries");
    expect(description).toContain(`(log group ${logGroupName})`);
    expect(description).not.toMatch(/[<>{}]|\$\{/);
  });

  it("notifies the alerts topic of Core by its name: the pack network is installed first", () => {
    const [alarmResource] = ofType(network, "AWS::CloudWatch::Alarm");
    const [topic] = ofType(instantiate(core, values), "AWS::SNS::Topic");
    expect(instantiate(alarmResource![1].Properties.AlarmActions, values)).toEqual([
      `arn:aws:sns:us-east-1:111122223333:${topic![1].Properties.TopicName}`,
    ]);
    expect(topic![1].Properties.TopicName).toBe("Mango-acme-Alerts");
  });
});
