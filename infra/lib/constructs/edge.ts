import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { z } from "zod";
import { Installation } from "../config/schema.js";
import { acknowledge } from "../nag.js";
import { mangoName } from "../names.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_DIST = resolve(REPO_ROOT, "apps/web/dist");

export interface EdgeProps {
  readonly installation: Installation;
  readonly alb: elbv2.IApplicationLoadBalancer;
  readonly accessLogs: s3.IBucket;
}

export interface SpaRuntimeConfig {
  region: string;
  cognitoDomain: string;
  userPoolId: string;
  clientId: string;
  apiBasePath: string;
  /** Company domains shown by the sign-up form; enforced by the pre sign-up Lambda (D20). */
  signUpDomains: string[];
  /** Company AI use policy (https); sign-up only asks to accept it when present. */
  aiPolicyUrl?: string;
  /** Installation auth policy, shown read-only in Ajustes › Autenticación. */
  auth: SpaAuthConfig;
}

/**
 * Auth policy published in config.json. Public by design (no secrets); the SPA validates the
 * same shape (`runtimeConfig.ts`). `.strict()` keeps anything else out of the public file.
 */
export const spaAuthConfigSchema = z
  .object({
    installationType: z.enum(["customer", "lab"]),
    mfa: z.enum(["required", "off"]),
    sessionHours: z.number().int().min(1).max(24),
  })
  .strict();

export type SpaAuthConfig = z.infer<typeof spaAuthConfigSchema>;

/** The runtime configuration of a release: two of its values are deploy-time text (D58). */
export interface ReleaseSpaConfig extends Omit<SpaRuntimeConfig, "signUpDomains" | "aiPolicyUrl"> {
  readonly deployTime: {
    /** Company domains separated by commas; the stack parameter only admits domain characters. */
    readonly signUpDomains: string;
    /** `,"aiPolicyUrl":"…"` when a policy URL was given, empty otherwise. */
    readonly aiPolicyUrlMember: string;
  };
}

/**
 * `config.json` of a release: the same members `Source.jsonData` would write, as text put
 * together by CloudFormation. Every value is either fixed by the release or comes from a
 * resource or a parameter that only admits characters JSON does not escape (a test checks the
 * parameter patterns).
 */
export function releaseConfigJson(config: ReleaseSpaConfig): string {
  const text = (value: string) => `"${value}"`;
  const members = [
    `"region":${text(config.region)}`,
    `"cognitoDomain":${text(config.cognitoDomain)}`,
    `"userPoolId":${text(config.userPoolId)}`,
    `"clientId":${text(config.clientId)}`,
    `"apiBasePath":${text(config.apiBasePath)}`,
    `"signUpDomains":["${Fn.join('","', Fn.split(",", config.deployTime.signUpDomains))}"]`,
    `"auth":${JSON.stringify(config.auth)}`,
  ];
  return `{${members.join(",")}${config.deployTime.aiPolicyUrlMember}}`;
}

/**
 * Requests per IP address per 5 minutes at the edge (D72). Constants of the release, sized for
 * an office behind one egress address: the first one only counts what reaches mango-api
 * (about 1,000 people of one address arriving at once), the second one is the ceiling of
 * everything, files of the web application included.
 */
export const API_RATE_LIMIT = 6000;
export const EDGE_RATE_LIMIT = 20000;
const RATE_WINDOW_SECONDS = 300;
/**
 * `Retry-After` of a block. The web ACL cannot say when the count of the address falls under
 * the limit: a minute later the request either passes or gets the same answer.
 */
export const RATE_LIMITED_RETRY_SECONDS = 60;
/** The same body mango-api answers a 429 with (`rate_limited` in `web.py`): the SPA reads one format. */
export const API_RATE_LIMITED_BODY = JSON.stringify({
  error: { code: "rate_limited", message: "too many requests; try again later" },
});
/**
 * What a browser shows when the ceiling blocks a page load. Provisional text (D24: the design
 * has no screen for this state yet). No script, no style, ASCII only.
 */
export const RATE_LIMITED_PAGE =
  '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mango</title></head>' +
  "<body><h1>Demasiadas solicitudes</h1>" +
  "<p>Se recibieron demasiadas solicitudes desde tu red. Espera un minuto y vuelve a cargar la p&aacute;gina.</p>" +
  "</body></html>";

/** Deterministic Cognito managed-login domain (used by CSP before Cognito exists). */
export function cognitoDomainUrl(namespace: string, account: string, region: string): string {
  return `https://mango-${namespace}-${account}.auth.${region}.amazoncognito.com`;
}

/**
 * CloudFront + WAF in front of the SPA (S3 + OAC) and the API (`/api/*` via VPC origin to the
 * internal ALB). Security headers include CSP and HSTS.
 */
export class Edge extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly spaBucket: s3.Bucket;
  /** CloudWatch names of the web ACL and of its per-IP rate limits (`AWS/WAFV2` dimensions). */
  readonly rateLimitMetrics: { readonly webAcl: string; readonly rules: string[] };

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    const cfg = props.installation;
    const stack = Stack.of(this);
    const cognitoDomain = cognitoDomainUrl(cfg.namespace, stack.account, stack.region);

    this.spaBucket = new s3.Bucket(this, "Spa", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: props.accessLogs,
      serverAccessLogsPrefix: "spa/",
      // Versioned so a bad deployment can be rolled back; old versions expire.
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.rateLimitMetrics = {
      webAcl: mangoName(cfg.namespace, "edge"),
      rules: ["ApiRateLimitPerIp", "RateLimitPerIp"],
    };
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: true,
    });
    // A block answers 429 instead of the 403 page of CloudFront, which reads as «no permission».
    const blockWith = (body: string) => ({
      block: {
        customResponse: {
          responseCode: 429,
          customResponseBodyKey: body,
          responseHeaders: [
            { name: "Retry-After", value: String(RATE_LIMITED_RETRY_SECONDS) },
            { name: "Cache-Control", value: "no-store" },
            { name: "X-Content-Type-Options", value: "nosniff" },
            { name: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
          ],
        },
      },
    });
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: mangoName(cfg.namespace, "edge"),
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: visibility(this.rateLimitMetrics.webAcl),
      customResponseBodies: {
        ApiRateLimited: { contentType: "APPLICATION_JSON", content: API_RATE_LIMITED_BODY },
        RateLimited: { contentType: "TEXT_HTML", content: RATE_LIMITED_PAGE },
      },
      rules: [
        ...["AWSManagedRulesCommonRuleSet", "AWSManagedRulesKnownBadInputsRuleSet", "AWSManagedRulesAmazonIpReputationList"].map(
          (name, i) => ({
            name,
            priority: i,
            overrideAction: { none: {} },
            statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
            visibilityConfig: visibility(name),
          }),
        ),
        // First, so that mango-api's clients get the JSON answer. Only what reaches mango-api
        // counts: the files of the web application are two of every three requests of a
        // first load and CloudFront serves them from its cache (D72).
        {
          name: "ApiRateLimitPerIp",
          priority: 10,
          action: blockWith("ApiRateLimited"),
          statement: {
            rateBasedStatement: {
              limit: API_RATE_LIMIT,
              aggregateKeyType: "IP",
              evaluationWindowSec: RATE_WINDOW_SECONDS,
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: "/api/",
                  // Wider than the `/api/*` behavior of CloudFront on purpose: a path written
                  // another way counts here too, never less.
                  textTransformations: [
                    { priority: 0, type: "URL_DECODE" },
                    { priority: 1, type: "NORMALIZE_PATH" },
                    { priority: 2, type: "LOWERCASE" },
                  ],
                },
              },
            },
          },
          visibilityConfig: visibility("ApiRateLimitPerIp"),
        },
        {
          name: "RateLimitPerIp",
          priority: 11,
          action: blockWith("RateLimited"),
          statement: {
            rateBasedStatement: {
              limit: EDGE_RATE_LIMIT,
              aggregateKeyType: "IP",
              evaluationWindowSec: RATE_WINDOW_SECONDS,
            },
          },
          visibilityConfig: visibility("RateLimitPerIp"),
        },
      ],
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      responseHeadersPolicyName: mangoName(cfg.namespace, "security-headers"),
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            `connect-src 'self' ${cognitoDomain} https://cognito-idp.${stack.region}.amazonaws.com`,
            `form-action 'self' ${cognitoDomain}`,
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "object-src 'none'",
            "require-trusted-types-for 'script'",
            "trusted-types 'none'",
          ].join("; "),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
            override: true,
          },
        ],
      },
    });

    // SPA routing without distribution-wide error pages (which would also rewrite API errors).
    const spaRouter = new cloudfront.Function(this, "SpaRouter", {
      functionName: mangoName(cfg.namespace, "spa-router"),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var req = event.request;",
          "  if (req.uri.indexOf('.') === -1) { req.uri = '/index.html'; }",
          "  return req;",
          "}",
        ].join("\n"),
      ),
    });

    const apiOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
      vpcOriginName: mangoName(cfg.namespace, "api"),
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: mangoName(cfg.namespace, "web"),
      webAclId: webAcl.attrArn,
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: props.accessLogs,
      logFilePrefix: "cloudfront/",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.spaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaRouter, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
          compress: false,
        },
      },
    });
    this.acknowledgeFindings();
  }

  private acknowledgeFindings(): void {
    acknowledge(
      this.distribution,
      {
        id: "AwsSolutions-CFR1",
        reason: "Access is controlled by authentication; no geographic restriction is required.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason:
          "PoC uses the default *.cloudfront.net certificate (no custom domain, D15); production " +
          "uses the customer's ACM certificate with TLSv1.2_2021.",
      },
    );
  }

  get origin(): string {
    return `https://${this.distribution.distributionDomainName}`;
  }

  /**
   * Upload the built SPA plus its runtime configuration. `signUpDomains` and `aiPolicyUrl`
   * may be given as `deployTime` text instead (a release, D58): the list and the optional URL
   * are then only known at deployment, so that part of the JSON is written by CloudFormation.
   */
  deploySpa(config: SpaRuntimeConfig | ReleaseSpaConfig): void {
    // Fail the synth rather than publish a config.json the SPA would reject.
    spaAuthConfigSchema.parse(config.auth);
    if (!existsSync(resolve(WEB_DIST, "index.html"))) {
      throw new Error(`SPA not built: run 'pnpm --filter @mango/web build' (${WEB_DIST})`);
    }
    // Hashed assets are immutable; the entry point and runtime config are never cached.
    const assets = new s3deploy.BucketDeployment(this, "SpaAssets", {
      destinationBucket: this.spaBucket,
      sources: [s3deploy.Source.asset(WEB_DIST, { exclude: ["index.html"] })],
      cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
      prune: false,
      memoryLimit: 512,
    });
    const entry = new s3deploy.BucketDeployment(this, "SpaEntry", {
      destinationBucket: this.spaBucket,
      sources: [
        s3deploy.Source.asset(WEB_DIST, { exclude: ["*", "!index.html"] }),
        "deployTime" in config
          ? s3deploy.Source.data("config.json", releaseConfigJson(config))
          : s3deploy.Source.jsonData("config.json", config),
      ],
      cacheControl: [s3deploy.CacheControl.noStore()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ["/index.html", "/config.json"],
      memoryLimit: 512,
    });
    entry.node.addDependency(assets);
  }
}
