import { Duration, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { Alerts } from "./alerts.js";

/** CloudFront and its web ACL only report metrics in this Region. */
export const GLOBAL_METRICS_REGION = "us-east-1";

/**
 * Thresholds of the operational alarms (D71). Rates only count above a minimum of requests,
 * so that one failed request of a quiet installation is not an incident.
 */
export const OPERATIONAL_THRESHOLDS = {
  /** Responses the load balancer itself answered with 5xx (no target, timeout), per 5 minutes. */
  albErrors: 5,
  /** Percentage of mango-api responses that are 5xx, and the requests it takes to judge. */
  apiErrorPercent: 5,
  apiMinimumRequests: 20,
  /** Percentage of CloudFront responses that are 5xx, and the requests it takes to judge. */
  edgeErrorPercent: 5,
  edgeMinimumRequests: 100,
  /** Errors plus throttles of a function people depend on, per 5 minutes. One is a blip. */
  functionFailures: 2,
  /**
   * Requests the per-IP rate limits of a web ACL blocked, per 5 minutes: the edge and the user
   * pool each have their alarm. An address over a limit is blocked on every request, so a real
   * block passes this in seconds and a stray one does not reach it.
   */
  rateLimited: 50,
};

const MINUTE = Duration.minutes(1);
const FIVE_MINUTES = Duration.minutes(5);
const AT_LEAST = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD;
const ABOVE = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD;

export interface OperationalAlarmsProps {
  readonly installation: Installation;
  /** Where alarms notify. */
  readonly alerts: Alerts;
  readonly alb: elbv2.ApplicationLoadBalancer;
  /** mango-api. The number of tasks it should run is read from its metrics, never written here. */
  readonly service: ecs.FargateService;
  readonly distribution: cloudfront.Distribution;
  /** CloudWatch names of the edge web ACL and of its per-IP rate limits. */
  readonly edgeRateLimits: { readonly webAcl: string; readonly rules: string[] };
  /** The same of the regional web ACL of the user pool. */
  readonly userPoolRateLimits: { readonly webAcl: string; readonly rules: string[] };
  /** Functions every sign-in or tool call goes through: their errors and throttles alarm. */
  readonly criticalFunctions: Record<string, lambda.IFunction>;
  /**
   * Functions that refuse a request by raising (the pre sign-up trigger): their errors are
   * what anyone on the internet can cause, so only their throttles alarm.
   */
  readonly refusingFunctions: Record<string, lambda.IFunction>;
  /** Dead-letter queues without an alarm of their own, by the name of what failed. */
  readonly deadLetterQueues: Record<string, sqs.IQueue>;
}

/**
 * Alarms for what would otherwise fail in silence (D71), and one dashboard with the same
 * signals: mango-api and its load balancer, the Cognito triggers and the Gateway interceptor,
 * the DynamoDB tables, CloudFront and the per-IP rate limits of the two web ACLs. Every alarm notifies the alerts
 * topic and says in its description what to look at first.
 *
 * Missing data does not breach: an installation nobody is using stays quiet. The one exception
 * is `Api-no-healthy-targets`, whose metric stops exactly when the failure is worst. The tables
 * and the target groups are the ones the stack holds when this construct is created, so it goes
 * last.
 * The alarms of the publication path live in `Reconciler`; the one of the pack network, in
 * `PackNetwork`.
 */
export class OperationalAlarms extends Construct {
  private readonly ns: string;
  private readonly notify: cloudwatchActions.SnsAction;

  constructor(scope: Construct, id: string, props: OperationalAlarmsProps) {
    super(scope, id);
    this.ns = props.installation.namespace;
    this.notify = new cloudwatchActions.SnsAction(props.alerts.topic);
    const stack = Stack.of(this);
    const everything = stack.node.findAll();
    const tables = everything.filter((c): c is dynamodb.TableV2 => c instanceof dynamodb.TableV2);
    const targetGroups = everything.filter(
      (c): c is elbv2.ApplicationTargetGroup => c instanceof elbv2.ApplicationTargetGroup,
    );
    const global = stack.region === GLOBAL_METRICS_REGION;

    const api = this.apiAlarms(props, targetGroups);
    const functions = this.functionAlarms(props);
    const data = this.tableAlarms(tables);
    this.queueAlarms(props.deadLetterQueues);
    // An alarm only reads metrics of its own Region. A template for another Region goes
    // without these two; the load balancer alarms still see what reaches the API.
    const edge = global ? this.edgeAlarms(props) : [];
    const userPool = this.userPoolAlarms(props, stack.region);

    // Every alarm of the stack, the ones of the publication path included.
    const alarms = stack.node.findAll().filter((c): c is cloudwatch.Alarm => c instanceof cloudwatch.Alarm);
    new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: mangoName(this.ns, "Operations"),
      defaultInterval: Duration.hours(3),
      widgets: [
        [new cloudwatch.AlarmStatusWidget({ title: "Alarms", alarms, width: 24, height: 4 })],
        api,
        [...functions, ...data],
        [...edge, ...userPool],
      ].filter((row) => row.length > 0),
    });
  }

  private alarm(
    id: string,
    name: string,
    description: string,
    options: Omit<cloudwatch.AlarmProps, "alarmName" | "alarmDescription" | "treatMissingData">,
    treatMissingData = cloudwatch.TreatMissingData.NOT_BREACHING,
  ): cloudwatch.Alarm {
    const created = new cloudwatch.Alarm(this, id, {
      alarmName: mangoName(this.ns, name),
      alarmDescription: description,
      treatMissingData,
      ...options,
    });
    created.addAlarmAction(this.notify);
    return created;
  }

  /** mango-api: what the load balancer answers, the health of its targets and its tasks. */
  private apiAlarms(props: OperationalAlarmsProps, targetGroups: elbv2.ApplicationTargetGroup[]): cloudwatch.IWidget[] {
    const sum = { statistic: cloudwatch.Stats.SUM, period: FIVE_MINUTES };
    const albErrors = props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, sum);
    this.alarm(
      "AlbErrors",
      "Api-unreachable",
      "The load balancer answered 5xx itself: mango-api had no healthy task, closed the connection or took " +
        "too long. Look first at the tasks of the ECS service (stopped tasks and their reason) and at the " +
        "alarms Api-no-healthy-targets and Api-tasks-below-desired.",
      { metric: albErrors, threshold: OPERATIONAL_THRESHOLDS.albErrors, comparisonOperator: AT_LEAST, evaluationPeriods: 1 },
    );

    const health: cloudwatch.IMetric[] = [];
    const traffic: cloudwatch.IMetric[] = [albErrors];
    const latency: cloudwatch.IMetric[] = [];
    targetGroups.forEach((group, index) => {
      // One target group today (mango-api). A second one gets its own alarms, told apart by number.
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const requests = group.metrics.requestCount(sum);
      const errors = group.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, sum);
      this.alarm(
        `ApiErrors${suffix}`,
        `Api-errors${suffix}`,
        `More than ${OPERATIONAL_THRESHOLDS.apiErrorPercent} % of the responses of mango-api were 5xx, with at ` +
          `least ${OPERATIONAL_THRESHOLDS.apiMinimumRequests} requests in 5 minutes. Look first at the errors in ` +
          "the log group of mango-api (/mango/<namespace>/api), then at the DynamoDB alarms.",
        {
          metric: new cloudwatch.MathExpression({
            expression: `IF(FILL(requests, 0) >= ${OPERATIONAL_THRESHOLDS.apiMinimumRequests}, 100 * FILL(errors, 0) / requests, 0)`,
            usingMetrics: { requests, errors },
            label: "mango-api 5xx (%)",
            period: FIVE_MINUTES,
          }),
          threshold: OPERATIONAL_THRESHOLDS.apiErrorPercent,
          comparisonOperator: ABOVE,
          evaluationPeriods: 3,
          datapointsToAlarm: 2,
        },
      );
      const healthy = group.metrics.healthyHostCount({ statistic: cloudwatch.Stats.MAXIMUM, period: MINUTE });
      const unhealthy = group.metrics.unhealthyHostCount({ statistic: cloudwatch.Stats.MAXIMUM, period: MINUTE });
      // The load balancer only reports this metric while a target is registered. A service left
      // without tasks reports nothing, so here, and only here, missing data breaches (D71).
      const noHealthy = this.alarm(
        `NoHealthyTargets${suffix}`,
        `Api-no-healthy-targets${suffix}`,
        "No task of mango-api passes the health check of the load balancer, or none is registered with it: " +
          "nobody can use the application. Look first at the events of the ECS service and at the last lines " +
          "of the mango-api log group.",
        {
          metric: healthy,
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 3,
        },
        cloudwatch.TreatMissingData.BREACHING,
      );
      // Created once the service is stable and deleted before it: the alarm does not exist
      // while an installation has no first task yet, nor after an uninstall stops the last one.
      noHealthy.node.addDependency(props.service);
      this.alarm(
        `UnhealthyTargets${suffix}`,
        `Api-unhealthy-targets${suffix}`,
        "A task of mango-api has been failing the health check of the load balancer for 5 minutes. The service " +
          "may still answer from another task. Look first at the stopped tasks of the ECS service and their reason.",
        { metric: unhealthy, threshold: 1, comparisonOperator: AT_LEAST, evaluationPeriods: 5 },
      );
      health.push(healthy, unhealthy);
      traffic.push(requests, errors);
      latency.push(group.metrics.targetResponseTime({ statistic: "p95", period: FIVE_MINUTES }));
    });

    // Container Insights reports what the service wants and what it has: the alarm follows
    // the desired count wherever it is set (the template, auto scaling or an operator).
    const tasks = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: "ECS/ContainerInsights",
        metricName,
        dimensionsMap: {
          ClusterName: props.service.cluster.clusterName,
          ServiceName: props.service.serviceName,
        },
        statistic: cloudwatch.Stats.MINIMUM,
        period: MINUTE,
      });
    const desired = tasks("DesiredTaskCount").with({ statistic: cloudwatch.Stats.MAXIMUM });
    const running = tasks("RunningTaskCount");
    this.alarm(
      "TasksBelowDesired",
      "Api-tasks-below-desired",
      "mango-api has been running fewer tasks than the service asks for, for 5 minutes: tasks stop or cannot " +
        "start. Look first at the events of the ECS service and at the stopped tasks (image pull, health " +
        "check, out of memory).",
      {
        metric: new cloudwatch.MathExpression({
          expression: "desired - running",
          usingMetrics: { desired, running },
          label: "mango-api tasks missing",
          period: MINUTE,
        }),
        threshold: 1,
        comparisonOperator: AT_LEAST,
        evaluationPeriods: 5,
      },
    );

    const utilization = (metricName: string) => tasks(metricName).with({ statistic: cloudwatch.Stats.AVERAGE, period: FIVE_MINUTES });
    return [
      new cloudwatch.GraphWidget({ title: "mango-api: requests and 5xx", left: traffic, width: 8 }),
      new cloudwatch.GraphWidget({ title: "mango-api: response time p95", left: latency, width: 4 }),
      new cloudwatch.GraphWidget({ title: "mango-api: tasks and targets", left: [desired, running, ...health], width: 6 }),
      new cloudwatch.GraphWidget({
        title: "mango-api: CPU units and memory (MiB)",
        left: [utilization("CpuUtilized"), utilization("CpuReserved")],
        right: [utilization("MemoryUtilized"), utilization("MemoryReserved")],
        width: 6,
      }),
    ];
  }

  /** Cognito triggers and the Gateway interceptor: nobody signs in or calls a tool without them. */
  private functionAlarms(props: OperationalAlarmsProps): cloudwatch.IWidget[] {
    const sum = { statistic: cloudwatch.Stats.SUM, period: FIVE_MINUTES };
    const graphed: cloudwatch.IMetric[] = [];
    for (const [name, fn] of Object.entries(props.criticalFunctions)) {
      const errors = fn.metricErrors(sum);
      const throttles = fn.metricThrottles(sum);
      this.alarm(
        `${name}Failing`,
        `${name}-failing`,
        `The function ${name} failed or was throttled at least ${OPERATIONAL_THRESHOLDS.functionFailures} times ` +
          "in 5 minutes: the requests that went through it were refused. Look first at the errors in its log " +
          "group (/aws/lambda/<function name>), then at the Lambda concurrency of the account.",
        {
          metric: new cloudwatch.MathExpression({
            expression: "FILL(errors, 0) + FILL(throttles, 0)",
            usingMetrics: { errors, throttles },
            label: `${name} errors and throttles`,
            period: FIVE_MINUTES,
          }),
          threshold: OPERATIONAL_THRESHOLDS.functionFailures,
          comparisonOperator: AT_LEAST,
          evaluationPeriods: 1,
        },
      );
      graphed.push(errors, throttles);
    }
    for (const [name, fn] of Object.entries(props.refusingFunctions)) {
      const throttles = fn.metricThrottles(sum);
      this.alarm(
        `${name}Throttled`,
        `${name}-throttled`,
        `Lambda throttled the function ${name}: the requests that went through it were refused. Its errors do ` +
          "not alarm, because it refuses a request by raising one. Look first at the Lambda concurrency of the account.",
        { metric: throttles, threshold: 1, comparisonOperator: AT_LEAST, evaluationPeriods: 1 },
      );
      graphed.push(fn.metricErrors(sum), throttles);
    }
    return [new cloudwatch.GraphWidget({ title: "Sign-in and tool functions: errors and throttles", left: graphed, width: 8 })];
  }

  /**
   * Every table of the stack: throttled reads and writes, one alarm per table. Internal errors
   * of DynamoDB are reported per operation, so one query covers every table of the account.
   */
  private tableAlarms(tables: dynamodb.TableV2[]): cloudwatch.IWidget[] {
    const graphed: cloudwatch.IMetric[] = [];
    for (const table of tables) {
      const name = table.node.id;
      const events = (metricName: string) =>
        new cloudwatch.Metric({
          namespace: "AWS/DynamoDB",
          metricName,
          dimensionsMap: { TableName: table.tableName },
          statistic: cloudwatch.Stats.SUM,
          period: FIVE_MINUTES,
          label: `${name} ${metricName}`,
        });
      const reads = events("ReadThrottleEvents");
      const writes = events("WriteThrottleEvents");
      this.alarm(
        `${name}Throttled`,
        `Table-${name}-throttled`,
        `DynamoDB throttled reads or writes of the ${name} table in 2 of the last 3 periods of 5 minutes. The ` +
          "tables are on demand. Look first at whether one partition key takes most of the traffic, then at the " +
          "table and account throughput quotas of DynamoDB.",
        {
          metric: new cloudwatch.MathExpression({
            expression: "FILL(reads, 0) + FILL(writes, 0)",
            usingMetrics: { reads, writes },
            label: `${name} throttle events`,
            period: FIVE_MINUTES,
          }),
          threshold: 1,
          comparisonOperator: AT_LEAST,
          evaluationPeriods: 3,
          datapointsToAlarm: 2,
        },
      );
      graphed.push(reads, writes);
    }

    const systemErrors = new cloudwatch.MathExpression({
      // Metrics Insights: every table and operation of the account, without naming them.
      expression: 'SELECT SUM(SystemErrors) FROM SCHEMA("AWS/DynamoDB", Operation,TableName)',
      usingMetrics: {},
      label: "DynamoDB internal errors",
      period: FIVE_MINUTES,
    });
    this.alarm(
      "TableSystemErrors",
      "DynamoDB-system-errors",
      "DynamoDB answered with internal errors (HTTP 500) in 2 of the last 3 periods of 5 minutes, on any table " +
        "of the account. It is a failure of the service. Look first at the AWS Health Dashboard, then at which " +
        "table and operation report SystemErrors.",
      { metric: systemErrors, threshold: 1, comparisonOperator: AT_LEAST, evaluationPeriods: 3, datapointsToAlarm: 2 },
    );
    return [
      new cloudwatch.GraphWidget({ title: "DynamoDB: throttle events", left: graphed, width: 8 }),
      new cloudwatch.GraphWidget({ title: "DynamoDB: internal errors", left: [systemErrors], width: 8 }),
    ];
  }

  private queueAlarms(queues: Record<string, sqs.IQueue>): void {
    for (const [name, queue] of Object.entries(queues)) {
      this.alarm(
        `${name}DeadLetters`,
        `${name}-failed`,
        `An asynchronous invocation of ${name} failed every retry: its event is in the dead-letter queue. Look ` +
          "first at the errors in the log group of the function, then at the message in the queue.",
        {
          metric: queue.metricApproximateNumberOfMessagesVisible({
            statistic: cloudwatch.Stats.MAXIMUM,
            period: FIVE_MINUTES,
          }),
          threshold: 1,
          comparisonOperator: AT_LEAST,
          evaluationPeriods: 1,
        },
      );
    }
  }

  /** CloudFront and its web ACL. Their metrics only exist in `GLOBAL_METRICS_REGION`. */
  private edgeAlarms(props: OperationalAlarmsProps): cloudwatch.IWidget[] {
    // CloudFront reports under `DistributionId` and `Region: Global`; the metric helpers of the
    // distribution leave the second one out, and CloudWatch only matches the exact set.
    const ofDistribution = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/CloudFront",
        metricName,
        dimensionsMap: { DistributionId: props.distribution.distributionId, Region: "Global" },
        statistic,
        period: FIVE_MINUTES,
      });
    const requests = ofDistribution("Requests", cloudwatch.Stats.SUM);
    const errorRate = ofDistribution("5xxErrorRate", cloudwatch.Stats.AVERAGE);
    this.alarm(
      "EdgeErrors",
      "Edge-errors",
      `More than ${OPERATIONAL_THRESHOLDS.edgeErrorPercent} % of the responses of CloudFront were 5xx, with at ` +
        `least ${OPERATIONAL_THRESHOLDS.edgeMinimumRequests} requests in 5 minutes. If the Api alarms are quiet, ` +
        "the failure is between CloudFront and its origins. Look first at the VPC origin and the security " +
        "group of the load balancer, then at the bucket of the web application.",
      {
        metric: new cloudwatch.MathExpression({
          expression: `IF(FILL(requests, 0) >= ${OPERATIONAL_THRESHOLDS.edgeMinimumRequests}, rate, 0)`,
          usingMetrics: { requests, rate: errorRate },
          label: "CloudFront 5xx (%)",
          period: FIVE_MINUTES,
        }),
        threshold: OPERATIONAL_THRESHOLDS.edgeErrorPercent,
        comparisonOperator: ABOVE,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
      },
    );

    // A CloudFront web ACL has no Region dimension.
    const rateLimited = this.blockedBy(props.edgeRateLimits, {}, "Edge");
    this.alarm(
      "EdgeRateLimited",
      "Edge-rate-limited",
      `The per-IP rate limits of the edge web ACL blocked at least ${OPERATIONAL_THRESHOLDS.rateLimited} requests ` +
        "in 5 minutes: people get 429 answers. Either one address is flooding the application or many people " +
        "share one address (an office behind one egress IP) and are being blocked. Look first at the dashboard " +
        "for which rule blocked (ApiRateLimitPerIp counts what reaches mango-api, RateLimitPerIp everything), " +
        "then at the sampled requests of that rule in the WAF console: whose address it is.",
      { metric: rateLimited.total, threshold: OPERATIONAL_THRESHOLDS.rateLimited, comparisonOperator: AT_LEAST, evaluationPeriods: 1 },
    );
    return [
      new cloudwatch.GraphWidget({ title: "CloudFront: requests and 5xx (%)", left: [requests], right: [errorRate], width: 8 }),
      new cloudwatch.GraphWidget({ title: "Edge web ACL: blocked by the rate limits", left: rateLimited.perRule, width: 8 }),
    ];
  }

  /**
   * The web ACL of the user pool: sign-in, sign-up and recovery go from the browser to Cognito
   * and never reach mango-api, so a block here shows nowhere else (D72).
   */
  private userPoolAlarms(props: OperationalAlarmsProps, region: string): cloudwatch.IWidget[] {
    // A regional web ACL reports under its Region too.
    const rateLimited = this.blockedBy(props.userPoolRateLimits, { Region: region }, "User pool");
    this.alarm(
      "CognitoRateLimited",
      "Cognito-rate-limited",
      `The per-IP rate limits of the user pool web ACL blocked at least ${OPERATIONAL_THRESHOLDS.rateLimited} ` +
        "requests in 5 minutes: people of that address cannot sign in, sign up or recover a password. Either " +
        "one address is guessing passwords or sending emails, or many people share one address (an office " +
        "behind one egress IP). Look first at the dashboard for which rule blocked (SecretOperationsPerIp, " +
        "EmailOperationsPerIp or RateLimitPerIp), then at the sampled requests of that rule in the WAF " +
        "console: whose address it is and which operation it repeats.",
      { metric: rateLimited.total, threshold: OPERATIONAL_THRESHOLDS.rateLimited, comparisonOperator: AT_LEAST, evaluationPeriods: 1 },
    );
    return [
      new cloudwatch.GraphWidget({ title: "User pool web ACL: blocked by the rate limits", left: rateLimited.perRule, width: 8 }),
    ];
  }

  /** Requests each per-IP rule of a web ACL blocked, and their sum. Managed rules are left out. */
  private blockedBy(
    acl: { readonly webAcl: string; readonly rules: string[] },
    extraDimensions: Record<string, string>,
    label: string,
  ): { perRule: cloudwatch.Metric[]; total: cloudwatch.MathExpression } {
    const perRule = acl.rules.map(
      (rule) =>
        new cloudwatch.Metric({
          namespace: "AWS/WAFV2",
          metricName: "BlockedRequests",
          dimensionsMap: { WebACL: acl.webAcl, Rule: rule, ...extraDimensions },
          statistic: cloudwatch.Stats.SUM,
          period: FIVE_MINUTES,
          label: `Blocked by ${rule}`,
        }),
    );
    const usingMetrics = Object.fromEntries(perRule.map((metric, index) => [`rule${index}`, metric]));
    return {
      perRule,
      total: new cloudwatch.MathExpression({
        expression: Object.keys(usingMetrics).map((id) => `FILL(${id}, 0)`).join(" + "),
        usingMetrics,
        label: `${label}: blocked by the per-IP rate limits`,
        period: FIVE_MINUTES,
      }),
    };
  }
}
