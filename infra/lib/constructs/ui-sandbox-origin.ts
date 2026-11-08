import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnResource, CustomResource, Duration, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { CHECKOV_EXCEPTIONS, suppressCheckov } from "../checkov.js";
import { Installation } from "../config/schema.js";
import { acknowledge } from "../nag.js";
import { mangoName } from "../names.js";
import { ACCESS_LOG_FIELDS } from "./edge.js";
import { PythonFunction } from "./python-function.js";

/**
 * The second origin for code Mango did not write (D123): the distribution that will serve the
 * runner of Canvas previews and MCP Apps (V3) and the mirror of their browser dependencies (V2),
 * never the SPA's. In the PoC it is a second `*.cloudfront.net` distribution, which is another
 * registrable site (`cloudfront.net` is in the Public Suffix List). Nothing is served yet.
 */

/**
 * The ceiling of the CSP of every document of the second origin. The runner only hardens it
 * (with `<meta>`), and the inner iframes it creates with `srcdoc` inherit it, which is why the
 * code they run needs `'unsafe-inline'` and `'unsafe-eval'` here, and only here (D123 (4)):
 * - network: only the origin itself, the mirror (TM-UI4, TM-UI8);
 * - no forms, plugins, base or popups; the `sandbox` directive only works in a header (CSP3);
 * - `frame-ancestors` is not here: the function adds it with the SPA's origin (TM-UI11).
 */
export const UI_SANDBOX_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts allow-same-origin",
].join("; ");

/** Browser features the second origin never gets (TM-UI4). */
export const UI_SANDBOX_PERMISSIONS =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), storage-access=(), display-capture=()";

/** The key of the store the function reads, and the custom resource writes. */
export const SPA_ORIGIN_KEY = "spa_origin";

/** The path of the mirror of dependencies (V2): the only one answered with CORS (`*`, D123 (2)). */
export const UI_SANDBOX_VENDOR_PREFIX = "/vendor/";

/**
 * The CloudFront Function (`viewer-response`) of the second origin: the whole CSP, its ceiling
 * plus `frame-ancestors` with the SPA's origin read from the key value store, and the CORS
 * answer of the mirror. Any other value, a missing key or a failed read gives
 * `frame-ancestors 'none'`: the runner then cannot be framed at all (fails closed, TM-UI11).
 * The function owns the header so that its order with the response headers policy does not
 * matter (the policy only adds its fallback when the header is missing).
 */
export function uiSandboxFunctionCode(keyValueStoreId: string): string {
  return [
    "import cf from 'cloudfront';",
    `const kvs = cf.kvs('${keyValueStoreId}');`,
    `const CEILING = ${JSON.stringify(UI_SANDBOX_CSP)};`,
    "const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';",
    "const ORIGIN = new RegExp('^https://' + LABEL + '(?:\\\\.' + LABEL + ')+$');",
    "async function handler(event) {",
    "  var response = event.response;",
    "  var ancestors = \"'none'\";",
    "  try {",
    `    var origin = await kvs.get('${SPA_ORIGIN_KEY}');`,
    "    if (typeof origin === 'string' && origin.length <= 260 && ORIGIN.test(origin)) { ancestors = origin; }",
    "  } catch (e) {}",
    "  response.headers['content-security-policy'] = { value: CEILING + '; frame-ancestors ' + ancestors };",
    `  if (event.request.uri.indexOf('${UI_SANDBOX_VENDOR_PREFIX}') === 0) {`,
    "    response.headers['access-control-allow-origin'] = { value: '*' };",
    "  }",
    "  return response;",
    "}",
  ].join("\n");
}

export interface UiSandboxOriginProps {
  readonly installation: Installation;
  readonly accessLogs: s3.IBucket;
  /** The web ACL of the SPA's distribution, with its rate limits (TM-UI12). */
  readonly webAclArn: string;
}

/**
 * In Core: the bucket of the release's sandbox content (its own, never the SPA's, TM-UI1), its
 * distribution with OAC, the response headers policy, the function and its key value store.
 * Core needs them: the CSP of the SPA names the distribution (`frame-src`). What writes the
 * store and the access log delivery are in a stack nested in Core (`UiSandboxStack`, D99).
 */
export class UiSandboxOrigin extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly keyValueStore: cloudfront.KeyValueStore;

  constructor(scope: Construct, id: string, props: UiSandboxOriginProps) {
    super(scope, id);
    const ns = props.installation.namespace;

    // Content of the release only (V2, V3): redeployed by every release, never data (D69).
    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: props.accessLogs,
      serverAccessLogsPrefix: "ui-sandbox/",
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.keyValueStore = new cloudfront.KeyValueStore(this, "SpaOrigin", {
      keyValueStoreName: mangoName(ns, "ui-sandbox"),
      comment: "Origin of the SPA, the only one that may frame the UI sandbox (D123)",
    });
    const headersFunction = new cloudfront.Function(this, "Headers", {
      functionName: mangoName(ns, "ui-sandbox-headers"),
      comment: "CSP with frame-ancestors of the SPA and CORS of the mirror (D123)",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: this.keyValueStore,
      code: cloudfront.FunctionCode.fromInline(uiSandboxFunctionCode(this.keyValueStore.keyValueStoreId)),
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      responseHeadersPolicyName: mangoName(ns, "ui-sandbox-headers"),
      comment: "Headers of the UI sandbox origin (D123)",
      securityHeadersBehavior: {
        // Only when the function did not put it (an answer of the web ACL, which runs no
        // function): the ceiling, and nobody may frame it.
        contentSecurityPolicy: {
          override: false,
          contentSecurityPolicy: `${UI_SANDBOX_CSP}; frame-ancestors 'none'`,
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER },
        // No X-Frame-Options: DENY would block the SPA's iframe; frame-ancestors decides.
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: "Permissions-Policy", value: UI_SANDBOX_PERMISSIONS, override: true },
          // Its own agent cluster, a process of its own where the browser can (TM-UI9).
          { header: "Origin-Agent-Cluster", value: "?1", override: true },
        ],
      },
    });

    // Named (D99): the generated name would be the same in two installations of one account.
    const originAccessControl = new cloudfront.S3OriginAccessControl(this, "OriginAccess", {
      originAccessControlName: mangoName(ns, "ui-sandbox"),
      description: "UI sandbox content of the release (D123)",
    });
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: mangoName(ns, "ui-sandbox"),
      webAclId: props.webAclArn,
      defaultRootObject: "sandbox.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, { originAccessControl }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: headersFunction, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE }],
      },
    });

    // Its access logs go through the v2 delivery of `UiSandboxStack`, which the checks do not see.
    suppressCheckov(this.distribution.node.defaultChild as CfnResource, CHECKOV_EXCEPTIONS.cloudfrontLogsV2);
    acknowledge(
      this.distribution,
      {
        id: "AwsSolutions-CFR3",
        reason:
          "Access logs go through CloudFront standard logging v2 (AWS::Logs::Delivery to the access-logs bucket, " +
          "in the UiSandbox nested stack); this rule only reads the legacy logging property.",
      },
      {
        id: "AwsSolutions-CFR1",
        reason: "Serves only the release's sandbox runner and mirror; no geographic restriction is required.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason:
          "PoC uses the default *.cloudfront.net certificate (no custom domain, D15, D123 (6)); production " +
          "uses a registrable domain of its own with an ACM certificate and TLSv1.2_2021.",
      },
    );
  }

  get origin(): string {
    return `https://${this.distribution.distributionDomainName}`;
  }
}

export interface UiSandboxWriterProps {
  readonly installation: Installation;
  /** The store of `UiSandboxOrigin`, in Core. */
  readonly keyValueStoreArn: string;
  /** The origin of the SPA (`https://<distribution>`): the only one that may frame the sandbox. */
  readonly spaOrigin: string;
  /** The sandbox distribution, for its access log delivery. */
  readonly distributionId: string;
  /** The delivery destination of the access logs, in Core (`Edge`). */
  readonly accessLogDestinationArn: string;
}

/**
 * In a stack nested in Core (D99): the custom resource that writes the SPA's origin to the
 * store, once both distributions exist (that is how the two distributions do not wait for each
 * other), and the v2 access log delivery of the sandbox distribution, without the query string
 * nor the cookies (D98 (9)), to the destination of the SPA's.
 */
export class UiSandboxWriter extends Construct {
  readonly function: PythonFunction["function"];

  constructor(scope: Construct, id: string, props: UiSandboxWriterProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    const stack = Stack.of(this);

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-ui-sandbox-origin",
      packagePath: "functions/ui-sandbox-origin",
      handler: "mango_ui_sandbox_origin.handler.lambda_handler",
      functionName: mangoName(ns, "UiSandboxOrigin"),
      description: "Writes the SPA origin to the UI sandbox key value store (invoked only by CloudFormation)",
      // D58 (27): a create that rolls back leaves nothing behind.
      logsRemovalPolicy: props.installation.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
      timeout: Duration.seconds(60),
      memorySize: 256,
    }).function;
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "WriteSpaOrigin",
        actions: ["cloudfront-keyvaluestore:DescribeKeyValueStore", "cloudfront-keyvaluestore:PutKey"],
        resources: [props.keyValueStoreArn],
      }),
    );
    const writer = new CustomResource(this, "SpaOrigin", {
      serviceToken: this.function.functionArn,
      resourceType: "Custom::MangoUiSandboxOrigin",
      properties: { KeyValueStoreArn: props.keyValueStoreArn, Key: SPA_ORIGIN_KEY, Value: props.spaOrigin },
      serviceTimeout: Duration.minutes(5),
    });
    // Its permission exists before it runs.
    writer.node.addDependency(this.function.role!);

    const source = new logs.CfnDeliverySource(this, "AccessLogSource", {
      name: mangoName(ns, "ui-sandbox-access"),
      logType: "ACCESS_LOGS",
      resourceArn: stack.formatArn({
        service: "cloudfront",
        region: "",
        resource: "distribution",
        resourceName: props.distributionId,
      }),
    });
    const delivery = new logs.CfnDelivery(this, "AccessLogDelivery", {
      deliverySourceName: source.name,
      deliveryDestinationArn: props.accessLogDestinationArn,
      recordFields: [...ACCESS_LOG_FIELDS],
      s3SuffixPath: "{DistributionId}/{yyyy}/{MM}/{dd}/{HH}",
    });
    delivery.addDependency(source);
  }
}

/** The built runner and mirror (`pnpm --filter @mango/ui-sandbox build`, D123 (3), (4)). */
export const UI_SANDBOX_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/ui-sandbox/dist");

/** The alarm of the second origin, by name: the operations dashboard lists it (D99 (4)). */
export const UI_SANDBOX_ALARMS = { bytes: "UiSandbox-bytes" };

/**
 * Bytes the second origin may serve in one hour before its alarm (TM-UI12): about 140 cold loads
 * of the whole mirror (~78 MB), far above an installation's use, since browsers keep what
 * `/vendor/` serves (`immutable`) and Python, its heaviest part, loads only when a run needs it.
 */
export const UI_SANDBOX_BYTES_PER_HOUR = 10 * 1024 ** 3;

/** Every file of the mirror's manifest, as `build`/`vendor:pyodide` wrote it (TM-UI8). */
interface MirrorManifest {
  readonly files: Record<string, { sha256: string; bytes: number }>;
  readonly pyodidePackages?: string[];
}

/**
 * What a synthesis takes from the built sandbox: the runner and its mirror, complete. A release
 * also needs the Pyodide packages (`vendor:pyodide`), which only its CI downloads (D25).
 */
export function checkUiSandboxDist(dist: string, release: boolean): MirrorManifest {
  const missing = ["sandbox.html", "assets", "vendor/manifest.json", "vendor-wasm"].filter(
    (path) => !existsSync(resolve(dist, path)),
  );
  if (missing.length) {
    throw new Error(`UI sandbox not built: run 'pnpm --filter @mango/ui-sandbox build' (${dist}: ${missing.join(", ")})`);
  }
  const manifest = JSON.parse(readFileSync(resolve(dist, "vendor/manifest.json"), "utf8")) as MirrorManifest;
  for (const [path, { bytes }] of Object.entries(manifest.files)) {
    const file = resolve(dist, path.endsWith(".wasm") ? "vendor-wasm" : "vendor", path);
    if (!existsSync(file) || statSync(file).size !== bytes) throw new Error(`the mirror does not match its manifest: ${path}`);
  }
  if (release) {
    const wanted = (
      JSON.parse(readFileSync(resolve(dist, "../vendor.json"), "utf8")) as { pyodide: { packages: string[] } }
    ).pyodide.packages;
    const have = new Set(manifest.pyodidePackages ?? []);
    const absent = wanted.filter((name) => !have.has(name));
    if (absent.length) {
      throw new Error(`a release needs the Pyodide packages of the mirror (pnpm --filter @mango/ui-sandbox run vendor:pyodide): ${absent.join(", ")}`);
    }
  }
  return manifest;
}

export interface UiSandboxContentProps {
  /** The sandbox bucket, in Core. */
  readonly bucket: s3.IBucket;
  /** The sandbox distribution, in Core: the entry point is invalidated on every release. */
  readonly distributionId: string;
  readonly distributionDomainName: string;
  /** The SPA's origin, the only window the runner answers (`runner-config.json`). */
  readonly spaOrigin: string;
  /** Where the built runner and mirror are; {@link UI_SANDBOX_DIST} by default. */
  readonly dist?: string;
  /** A release: the mirror must hold the Pyodide packages. */
  readonly release: boolean;
}

/**
 * The content of the second origin, from the release (D123 (3), (4); D69): the mirror under
 * `/vendor/<package>/<version>/`, which never changes once published (`immutable`), with its
 * `.wasm` uploaded apart as `application/wasm` (`WebAssembly.instantiateStreaming` needs it),
 * the runner's hashed assets, and its entry point with `runner-config.json`, never cached.
 * Nothing is downloaded or built in the account (D25): the bytes are assets of the release.
 */
export class UiSandboxContent extends Construct {
  constructor(scope: Construct, id: string, props: UiSandboxContentProps) {
    super(scope, id);
    const dist = props.dist ?? UI_SANDBOX_DIST;
    checkUiSandboxDist(dist, props.release);
    // Core's bucket, by name and ARN (parameters of the nested stack): no grant changes Core.
    const bucket = s3.Bucket.fromBucketAttributes(this, "Bucket", {
      bucketName: props.bucket.bucketName,
      bucketArn: props.bucket.bucketArn,
    });
    const distribution = cloudfront.Distribution.fromDistributionAttributes(this, "Distribution", {
      distributionId: props.distributionId,
      domainName: props.distributionDomainName,
    });
    const immutable = [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")];
    // ~80 MB of mirror: the handler unzips it in its own storage.
    const handler = { memoryLimit: 1024, ephemeralStorageSize: Size.gibibytes(2) };

    const mirror = new s3deploy.BucketDeployment(this, "Mirror", {
      destinationBucket: bucket,
      destinationKeyPrefix: "vendor/",
      sources: [s3deploy.Source.asset(resolve(dist, "vendor"))],
      cacheControl: immutable,
      prune: false,
      ...handler,
    });
    const wasm = new s3deploy.BucketDeployment(this, "MirrorWasm", {
      destinationBucket: bucket,
      destinationKeyPrefix: "vendor/",
      sources: [s3deploy.Source.asset(resolve(dist, "vendor-wasm"))],
      contentType: "application/wasm",
      cacheControl: immutable,
      prune: false,
      ...handler,
    });
    const assets = new s3deploy.BucketDeployment(this, "RunnerAssets", {
      destinationBucket: bucket,
      destinationKeyPrefix: "assets/",
      sources: [s3deploy.Source.asset(resolve(dist, "assets"))],
      cacheControl: immutable,
      prune: false,
      ...handler,
    });
    // Last: a runner is only served once what it loads is there.
    const entry = new s3deploy.BucketDeployment(this, "RunnerEntry", {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(dist, { exclude: ["*", "!sandbox.html"] }),
        s3deploy.Source.jsonData("runner-config.json", { spaOrigin: props.spaOrigin }),
      ],
      cacheControl: [s3deploy.CacheControl.noStore()],
      prune: false,
      distribution,
      distributionPaths: ["/sandbox.html", "/runner-config.json"],
      ...handler,
    });
    entry.node.addDependency(mirror, wasm, assets);
  }
}

export interface UiSandboxBytesAlarmProps {
  readonly installation: Installation;
  readonly distributionId: string;
  readonly alertsTopic: sns.ITopic;
}

/**
 * TM-UI12: the mirror answers any site (CORS `*`), so a site that hotlinks it costs the customer
 * CloudFront traffic. The web ACL limits each IP; this alarm sees the total. CloudFront
 * publishes its metrics in us-east-1 only, where a release installs.
 */
export class UiSandboxBytesAlarm extends Construct {
  constructor(scope: Construct, id: string, props: UiSandboxBytesAlarmProps) {
    super(scope, id);
    new cloudwatch.Alarm(this, "Alarm", {
      alarmName: mangoName(props.installation.namespace, UI_SANDBOX_ALARMS.bytes),
      alarmDescription:
        "The UI sandbox origin served more than 10 GiB in one hour: far more than the previews of an installation " +
        "need, since browsers keep its mirror. Look first at its access logs (prefix of the sandbox distribution in the " +
        "access-logs bucket): the referers, the IPs and the paths under /vendor/, then at the rate limits of the web ACL.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CloudFront",
        metricName: "BytesDownloaded",
        dimensionsMap: { DistributionId: props.distributionId, Region: "Global" },
        statistic: cloudwatch.Stats.SUM,
        period: Duration.hours(1),
      }),
      threshold: UI_SANDBOX_BYTES_PER_HOUR,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.alertsTopic));
  }
}
