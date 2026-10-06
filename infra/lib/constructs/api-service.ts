import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { logsKeyOf } from "../logs.js";
import { Installation } from "../config/schema.js";
import { acknowledge } from "../nag.js";
import { mangoName } from "../names.js";
import { Network } from "./network.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface ApiServiceProps {
  readonly installation: Installation;
  readonly network: Network;
  readonly taskRole: iam.IRole;
  readonly environment: Record<string, string>;
  /** The published image of a release (D58). Without it the image is built as a CDK asset. */
  readonly image?: { readonly repositoryArn: string; readonly repositoryName: string; readonly digest: string };
}

/**
 * Tasks mango-api runs on, one per Availability Zone (D70). A fixed number, not autoscaling:
 * the limits mango-api still counts per task are multiplied by it, and it is what the
 * installer pays for. Keep `infra/test/hardening.test.ts` and D70 in step with it.
 */
export const API_TASKS = 2;
/**
 * How long a task being replaced keeps answering the requests it already has. A chat turn is
 * one request that lasts as long as the agent works: this covers the default limit of a turn
 * (120 s). A longer turn is cut when the time is up (D70).
 */
export const API_DRAIN_SECONDS = 120;

/**
 * mango-api on ECS Fargate (arm64). A release runs the image published in the provider's
 * repository, by digest (D8, D58): nothing is built in or pushed to the customer account.
 */
export class ApiService extends Construct {
  readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id);
    const cfg = props.installation;
    const { vpc, listener } = props.network;

    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: mangoName(cfg.namespace, "api"),
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "Task", {
      family: mangoName(cfg.namespace, "api"),
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: props.taskRole,
    });
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/mango/${cfg.namespace}/api`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    taskDef.addContainer("api", {
      image: props.image
        ? // The execution role gets pull on that one repository; the repository policy of the
          // provider admits the customer's organization.
          ecs.ContainerImage.fromEcrRepository(
            ecr.Repository.fromRepositoryAttributes(this, "Image", {
              repositoryArn: props.image.repositoryArn,
              repositoryName: props.image.repositoryName,
            }),
            props.image.digest,
          )
        : ecs.ContainerImage.fromAsset(REPO_ROOT, {
            file: "apps/api/Dockerfile",
            platform: ecrAssets.Platform.LINUX_ARM64,
            exclude: ["**/node_modules", "**/.venv", "**/cdk.out", "apps/web", "infra", "docs", ".git"],
          }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup }),
      environment: { ...props.environment, AWS_DEFAULT_REGION: Stack.of(this).region },
      portMappings: [{ containerPort: 8000 }],
      readonlyRootFilesystem: true,
      user: "10001",
      healthCheck: {
        command: [
          "CMD",
          "python",
          "-c",
          "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)",
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(20),
      },
    });

    acknowledge(
      taskDef,
      {
        id: "AwsSolutions-ECS2",
        reason: "Environment variables carry non-secret configuration only; there are no secrets.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: "ecr:GetAuthorizationToken (task execution role) has no resource scope.",
      },
    );

    const serviceSg = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc,
      description: "mango-api tasks: inbound only from the internal ALB",
      allowAllOutbound: true,
    });

    this.service = new ecs.FargateService(this, "Service", {
      serviceName: mangoName(cfg.namespace, "api"),
      cluster,
      taskDefinition: taskDef,
      desiredCount: API_TASKS,
      assignPublicIp: true,
      // One public subnet per zone: ECS spreads the tasks between them and puts them back
      // when a zone returns.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      securityGroups: [serviceSg],
      circuitBreaker: { rollback: true },
      // A deployment starts the new tasks first and stops the old ones only once the new
      // ones are healthy: the service never has fewer than `API_TASKS` healthy tasks.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: false,
    });

    const target = listener.addTargets("Api", {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: { path: "/api/health", healthyHttpCodes: "200", interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(API_DRAIN_SECONDS),
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/api/*"])],
    });
    target.setAttribute("stickiness.enabled", "false");
    serviceSg.connections.allowFrom(props.network.alb, ec2.Port.tcp(8000), "ALB to api");
  }
}
