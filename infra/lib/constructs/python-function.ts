import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetHashType, Duration, ILocalBundling, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { logsKeyOf } from "../logs.js";
import { acknowledge, REASONS } from "../nag.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface PythonFunctionProps {
  /** uv workspace package name, e.g. `mango-cost-explorer`. */
  readonly packageName: string;
  /** Workspace path of the package, e.g. `connectors/cost-explorer`. */
  readonly packagePath: string;
  /** Handler in `module.function` form. */
  readonly handler: string;
  readonly functionName: string;
  readonly role?: iam.IRole;
  readonly environment?: Record<string, string>;
  /** Customer-managed key for the environment variables (required when `environment` is set). */
  readonly environmentEncryption?: kms.IKey;
  readonly timeout?: Duration;
  readonly memorySize?: number;
  readonly description?: string;
  /** Keep the log group when the stack is deleted (true outside the lab). */
  readonly retainLogs?: boolean;
  /** Required for functions invoked asynchronously (AGENTS.md): events that fail every retry. */
  readonly deadLetterQueue?: sqs.IQueue;
}

/**
 * Python 3.13 arm64 Lambda bundled locally with uv from Linux wheels
 * (`deployment/bundle-python.sh`): no Docker and no CodeBuild.
 */
export class PythonFunction extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: PythonFunctionProps) {
    super(scope, id);

    const bundler: ILocalBundling = {
      tryBundle(outputDir: string): boolean {
        execFileSync(
          resolve(REPO_ROOT, "deployment/bundle-python.sh"),
          [props.packageName, outputDir],
          { stdio: "inherit", cwd: REPO_ROOT },
        );
        return true;
      },
    };

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: props.retainLogs === false ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    if (props.environment && !props.environmentEncryption) {
      throw new Error(`${props.functionName}: environment variables need a customer-managed key`);
    }

    // Explicit role without AWS managed policies: only this function's log group and X-Ray.
    const role =
      props.role ??
      new iam.Role(this, "Role", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });

    this.function = new lambda.Function(this, "Function", {
      functionName: props.functionName,
      description: props.description,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: props.handler,
      code: lambda.Code.fromAsset(resolve(REPO_ROOT, props.packagePath), {
        // The asset is named after what the bundle holds, not after the package directory:
        // the lock file and the shared workspace packages change the zip too. No `exclude`:
        // it would leave files of the bundle out of the name.
        assetHashType: AssetHashType.OUTPUT,
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          local: bundler,
        },
      }),
      role,
      environment: props.environment,
      environmentEncryption: props.environmentEncryption,
      timeout: props.timeout ?? Duration.seconds(30),
      memorySize: props.memorySize ?? 512,
      deadLetterQueue: props.deadLetterQueue,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      tracing: lambda.Tracing.ACTIVE,
    });
    // Lambda decrypts the environment through a grant made at deploy time: the execution role
    // needs no kms:Decrypt on the key.
    logGroup.grantWrite(role);

    acknowledge(
      this,
      { id: "AwsSolutions-L1", reason: REASONS.pythonRuntime },
      { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray },
    );
    if (!props.role) acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
  }
}
