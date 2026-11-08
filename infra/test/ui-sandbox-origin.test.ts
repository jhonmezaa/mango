import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { App, CfnParameter, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { afterAll, describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { assertNoSandboxContent } from "../lib/constructs/edge.js";
import { ACCESS_LOG_FIELDS } from "../lib/constructs/edge.js";
import {
  checkUiSandboxDist,
  SPA_ORIGIN_KEY,
  UI_SANDBOX_ALARMS,
  UI_SANDBOX_BYTES_PER_HOUR,
  UiSandboxContent,
  UI_SANDBOX_CSP,
  UI_SANDBOX_PERMISSIONS,
  uiSandboxFunctionCode,
} from "../lib/constructs/ui-sandbox-origin.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

/* The second origin for code Mango did not write (D123, ui-sandbox-threat-model.md). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
  installation: cfg,
  env: { account: cfg.mangoAccountId, region: cfg.region },
});
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Json>;
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);

const distributions = ofType("AWS::CloudFront::Distribution");
const byComment = (comment: string) => {
  const found = distributions.filter(([, d]) => d.Properties.DistributionConfig.Comment === comment);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const [spaId, spa] = byComment(`Mango-${ns}-web`);
const [sandboxId, sandbox] = byComment(`Mango-${ns}-ui-sandbox`);
const policyNamed = (name: string) => {
  const found = ofType("AWS::CloudFront::ResponseHeadersPolicy").filter(
    ([, p]) => p.Properties.ResponseHeadersPolicyConfig.Name === name,
  );
  expect(found).toHaveLength(1);
  return found[0]!;
};
const [spaHeadersId, spaHeaders] = policyNamed(`Mango-${ns}-security-headers`);
const [sandboxHeadersId, sandboxHeaders] = policyNamed(`Mango-${ns}-ui-sandbox-headers`);

/** The logical ids of the buckets an S3 origin of a distribution reads. */
function originBuckets(distribution: Json): string[] {
  return (distribution.Properties.DistributionConfig.Origins as Json[]).flatMap((origin) => {
    const domain = JSON.stringify(origin.DomainName);
    return Object.keys(resources).filter(
      (id) => resources[id].Type === "AWS::S3::Bucket" && domain.includes(`"${id}"`),
    );
  });
}
const sandboxBucket = originBuckets(sandbox);

/** The CSP of the SPA as text, with the tokens it names by their logical ids. */
function spaCsp(): string {
  const value = spaHeaders.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
  return JSON.stringify(value.ContentSecurityPolicy);
}

describe("the second origin (D123)", () => {
  it("is a distribution of its own, only toward a bucket of its own (TM-UI1)", () => {
    expect(distributions).toHaveLength(2);
    expect(sandboxBucket).toHaveLength(1);
    expect(sandbox.Properties.DistributionConfig.Origins).toHaveLength(1);
    expect(sandbox.Properties.DistributionConfig.CacheBehaviors ?? []).toEqual([]);
    // Neither the default nor any other behavior of the SPA reads the sandbox bucket.
    expect(originBuckets(spa)).not.toContain(sandboxBucket[0]);
    expect(JSON.stringify(spa.Properties.DistributionConfig)).not.toContain(sandboxBucket[0]);
    expect(JSON.stringify(spa.Properties.DistributionConfig)).not.toContain(sandboxHeadersId);
  });

  it("keeps its bucket private, encrypted, versioned and logged, reachable through its OAC only", () => {
    const bucket = resources[sandboxBucket[0]!].Properties;
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.BucketEncryption).toBeDefined();
    expect(bucket.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(bucket.LoggingConfiguration.LogFilePrefix).toBe("ui-sandbox/");
    const [oacId, oac] = ofType("AWS::CloudFront::OriginAccessControl").find(
      ([, o]) => o.Properties.OriginAccessControlConfig.Name === `Mango-${ns}-ui-sandbox`,
    )!;
    expect(oac.Properties.OriginAccessControlConfig.SigningBehavior).toBe("always");
    expect(JSON.stringify(sandbox.Properties.DistributionConfig.Origins[0])).toContain(oacId);
    const policy = ofType("AWS::S3::BucketPolicy").find(([, p]) => p.Properties.Bucket.Ref === sandboxBucket[0])!;
    const reads = (policy[1].Properties.PolicyDocument.Statement as Json[]).filter((s) => s.Effect === "Allow");
    const cloudfrontReads = reads.filter((s) => s.Principal?.Service === "cloudfront.amazonaws.com");
    expect(cloudfrontReads).toHaveLength(1);
    expect(JSON.stringify(cloudfrontReads[0].Condition)).toContain(sandboxId);
  });

  it("only answers GET and HEAD, over HTTPS, behind the SPA's web ACL (TM-UI12)", () => {
    const behavior = sandbox.Properties.DistributionConfig.DefaultCacheBehavior;
    expect(behavior.AllowedMethods ?? ["GET", "HEAD"]).toEqual(["GET", "HEAD"]);
    expect(behavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(sandbox.Properties.DistributionConfig.WebACLId).toEqual(spa.Properties.DistributionConfig.WebACLId);
    expect(behavior.ResponseHeadersPolicyId).toEqual({ Ref: sandboxHeadersId });
  });

  it("sends its own headers: nosniff, no referrer, HSTS, Permissions-Policy, its own agent cluster", () => {
    const config = sandboxHeaders.Properties.ResponseHeadersPolicyConfig;
    const security = config.SecurityHeadersConfig;
    expect(security.ContentTypeOptions).toEqual({ Override: true });
    expect(security.ReferrerPolicy).toEqual({ Override: true, ReferrerPolicy: "no-referrer" });
    expect(security.StrictTransportSecurity).toMatchObject({ Override: true, IncludeSubdomains: true });
    // DENY would block the SPA's iframe: frame-ancestors decides.
    expect(security.FrameOptions).toBeUndefined();
    const custom = Object.fromEntries(
      (config.CustomHeadersConfig.Items as Json[]).map((h) => [h.Header, h.Value]),
    );
    expect(custom).toEqual({ "Permissions-Policy": UI_SANDBOX_PERMISSIONS, "Origin-Agent-Cluster": "?1" });
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "storage-access"]) {
      expect(UI_SANDBOX_PERMISSIONS).toContain(`${feature}=()`);
    }
  });

  it("has a CSP ceiling with the sandbox directive, network to itself only, and no frame-ancestors", () => {
    const csp = sandboxHeaders.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
    // The policy is the fallback only (answers of the web ACL): nobody may frame those.
    expect(csp).toEqual({ Override: false, ContentSecurityPolicy: `${UI_SANDBOX_CSP}; frame-ancestors 'none'` });
    expect(csp.ContentSecurityPolicy.length).toBeLessThanOrEqual(1783);
    const directives = Object.fromEntries(
      UI_SANDBOX_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]),
    );
    expect(directives["default-src"]).toBe("'self'");
    expect(directives["connect-src"]).toBe("'self'");
    expect(directives["form-action"]).toBe("'none'");
    expect(directives["base-uri"]).toBe("'none'");
    expect(directives["object-src"]).toBe("'none'");
    expect(directives.sandbox).toBe("allow-scripts allow-same-origin");
    expect(directives["frame-ancestors"]).toBeUndefined();
    expect(UI_SANDBOX_CSP).not.toMatch(/https?:|\*/);
  });

  it("frames only from the SPA: the function reads its origin from the store, and fails closed", () => {
    const functions = ofType("AWS::CloudFront::Function").filter(
      ([, f]) => f.Properties.Name === `Mango-${ns}-ui-sandbox-headers`,
    );
    expect(functions).toHaveLength(1);
    const [functionId, fn] = functions[0]!;
    const [kvsId, kvs] = ofType("AWS::CloudFront::KeyValueStore")[0]!;
    expect(kvs.Properties.Name).toBe(`Mango-${ns}-ui-sandbox`);
    expect(fn.Properties.FunctionConfig.Runtime).toBe("cloudfront-js-2.0");
    expect(JSON.stringify(fn.Properties.FunctionConfig.KeyValueStoreAssociations)).toContain(kvsId);
    expect(JSON.stringify(fn.Properties.FunctionCode)).toContain(kvsId);
    expect(sandbox.Properties.DistributionConfig.DefaultCacheBehavior.FunctionAssociations).toEqual([
      { EventType: "viewer-response", FunctionARN: { "Fn::GetAtt": [functionId, "FunctionARN"] } },
    ]);
  });
});

/** Runs the function's code as CloudFront would, with `store` as its key value store. */
async function run(store: Record<string, string>, uri = "/sandbox.html", fail = false): Promise<Json> {
  const code = uiSandboxFunctionCode("0f3c2c4e-1111-2222-3333-444455556666")
    .replace("import cf from 'cloudfront';", "")
    .concat("\nresult = handler(event);");
  const cf = {
    kvs: (id: string) => ({
      get: async (key: string) => {
        expect(id).toBe("0f3c2c4e-1111-2222-3333-444455556666");
        if (fail) throw new Error("read failed");
        if (!(key in store)) throw new Error("not found");
        return store[key];
      },
    }),
  };
  const sandboxContext: Json = { cf, event: { request: { uri }, response: { headers: {} } }, result: undefined };
  runInNewContext(code, sandboxContext);
  return (await sandboxContext.result).headers;
}

describe("the function of the second origin (TM-UI11)", () => {
  const spaOrigin = "https://d123.cloudfront.net";

  it("puts the ceiling with the SPA's origin as the only frame ancestor", async () => {
    const headers = await run({ [SPA_ORIGIN_KEY]: spaOrigin });
    expect(headers["content-security-policy"].value).toBe(`${UI_SANDBOX_CSP}; frame-ancestors ${spaOrigin}`);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each([
    ["no value", {}],
    ["another directive", { [SPA_ORIGIN_KEY]: `${spaOrigin}; script-src *` }],
    ["a wildcard", { [SPA_ORIGIN_KEY]: "https://*.cloudfront.net" }],
    ["http", { [SPA_ORIGIN_KEY]: "http://d123.cloudfront.net" }],
    ["a path", { [SPA_ORIGIN_KEY]: `${spaOrigin}/x` }],
    ["a keyword", { [SPA_ORIGIN_KEY]: "'self'" }],
  ])("lets nobody frame it with %s in the store", async (_what, store) => {
    const headers = await run(store as Record<string, string>);
    expect(headers["content-security-policy"].value).toBe(`${UI_SANDBOX_CSP}; frame-ancestors 'none'`);
  });

  it("lets nobody frame it when the store cannot be read", async () => {
    const headers = await run({ [SPA_ORIGIN_KEY]: spaOrigin }, "/sandbox.html", true);
    expect(headers["content-security-policy"].value).toContain("frame-ancestors 'none'");
  });

  it("answers the mirror with CORS for any origin, and nothing else", async () => {
    const vendor = await run({ [SPA_ORIGIN_KEY]: spaOrigin }, "/vendor/pyodide/0.26.4/pyodide.asm.wasm");
    expect(vendor["access-control-allow-origin"]).toEqual({ value: "*" });
    expect(vendor["access-control-allow-credentials"]).toBeUndefined();
    const other = await run({ [SPA_ORIGIN_KEY]: spaOrigin }, "/x/vendor/a.js");
    expect(other["access-control-allow-origin"]).toBeUndefined();
  });

  it("fits CloudFront's limit for the code of a function (10 KB)", () => {
    expect(Buffer.byteLength(uiSandboxFunctionCode("0f3c2c4e-1111-2222-3333-444455556666"))).toBeLessThan(10240);
  });
});

describe("the CSP of the SPA (TM-UI2)", () => {
  it("frames the second origin only, by its exact host", () => {
    const csp = spaCsp();
    expect(csp).toContain("frame-src https://");
    expect(csp).toMatch(new RegExp(`frame-src https://",\\{"Fn::GetAtt":\\["${sandboxId}","DomainName"\\]\\}`));
    expect(csp).not.toMatch(/\*\.cloudfront\.net|frame-src \*/);
  });

  it("keeps script-src 'self', Trusted Types and frame-ancestors 'none'", () => {
    const csp = spaCsp();
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
    // blob: only for the figures of a code cell (img-src, D116 (5)), never for scripts.
    expect(csp).toContain("script-src 'self';");
    expect(csp.match(/img-src [^;]*;/g)).toEqual(["img-src 'self' data: blob:;"]);
    expect(csp).not.toMatch(/(script|worker|frame)-src [^;]*blob:/);
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("trusted-types 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(spaHeadersId).not.toBe(sandboxHeadersId);
  });

  it("refuses a wildcard or a non-https frame origin", async () => {
    const { Edge } = await import("../lib/constructs/edge.js");
    const edge = core.node.findChild("Edge") as InstanceType<typeof Edge>;
    expect(() => edge.allowFrameFrom("https://*.cloudfront.net")).toThrow(/exact https origin/);
    expect(() => edge.allowFrameFrom("http://d123.cloudfront.net")).toThrow(/exact https origin/);
  });
});

describe("the SPA bucket never holds sandbox content (TM-UI1)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const dist = (...files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "mango-spa-dist-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "");
    for (const file of files) {
      if (file.endsWith("/")) mkdirSync(join(dir, file));
      else writeFileSync(join(dir, file), "");
    }
    return dir;
  };

  it("fails the synthesis with the runner or the mirror in the built SPA", () => {
    expect(() => assertNoSandboxContent(dist())).not.toThrow();
    expect(() => assertNoSandboxContent(dist("sandbox.html"))).toThrow(/sandbox\.html/);
    expect(() => assertNoSandboxContent(dist("vendor/"))).toThrow(/vendor/);
  });
});

describe("what writes the store, in the UiSandbox nested stack (D99)", () => {
  it("writes the SPA's origin to the store once both distributions exist", () => {
    const writers = ofType("Custom::MangoUiSandboxOrigin");
    expect(writers).toHaveLength(1);
    const props = writers[0]![1].Properties;
    expect(props.Key).toBe(SPA_ORIGIN_KEY);
    expect(JSON.stringify(props.Value)).toContain(`"${spaId}","DomainName"`);
    const [kvsId] = ofType("AWS::CloudFront::KeyValueStore")[0]!;
    expect(JSON.stringify(props.KeyValueStoreArn)).toContain(kvsId);
  });

  it("may only describe and write that one store", () => {
    const fn = ofType("AWS::Lambda::Function").find(([, f]) => f.Properties.FunctionName === `Mango-${ns}-UiSandboxOrigin`)!;
    const roleId = fn[1].Properties.Role["Fn::GetAtt"][0];
    const statements = ofType("AWS::IAM::Policy")
      .filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(roleId))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Json[]);
    const kvs = statements.filter((s) => JSON.stringify(s.Action).includes("cloudfront-keyvaluestore"));
    expect(kvs).toHaveLength(1);
    expect(kvs[0].Action).toEqual(["cloudfront-keyvaluestore:DescribeKeyValueStore", "cloudfront-keyvaluestore:PutKey"]);
    const [kvsId] = ofType("AWS::CloudFront::KeyValueStore")[0]!;
    expect(kvs[0].Resource).toEqual({ "Fn::GetAtt": [kvsId, "Arn"] });
    expect(JSON.stringify(statements)).not.toContain('"cloudfront:*"');
  });

  it("delivers the access logs of the sandbox distribution without the query nor the cookies", () => {
    const source = ofType("AWS::Logs::DeliverySource").find(([, s]) => s.Properties.Name === `Mango-${ns}-ui-sandbox-access`)!;
    expect(JSON.stringify(source[1].Properties.ResourceArn)).toContain(sandboxId);
    const delivery = ofType("AWS::Logs::Delivery").find(([, d]) => d.Properties.DeliverySourceName === `Mango-${ns}-ui-sandbox-access`)!;
    expect(delivery[1].Properties.RecordFields).toEqual([...ACCESS_LOG_FIELDS]);
    // The same destination as the SPA's: the access-logs bucket, prefix `cloudfront`.
    const spaDelivery = ofType("AWS::Logs::Delivery").find(([, d]) => d !== delivery[1])!;
    expect(delivery[1].Properties.DeliveryDestinationArn).toEqual(spaDelivery[1].Properties.DeliveryDestinationArn);
  });
});

describe("the alarm of bytes served (TM-UI12)", () => {
  it("watches the bytes of the sandbox distribution per hour and notifies the alerts topic", () => {
    const alarms = ofType("AWS::CloudWatch::Alarm").filter(
      ([, a]) => a.Properties.AlarmName === `Mango-${ns}-${UI_SANDBOX_ALARMS.bytes}`,
    );
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0]![1].Properties;
    expect(alarm.Namespace).toBe("AWS/CloudFront");
    expect(alarm.MetricName).toBe("BytesDownloaded");
    expect(alarm.Statistic).toBe("Sum");
    expect(alarm.Period).toBe(3600);
    expect(alarm.Threshold).toBe(UI_SANDBOX_BYTES_PER_HOUR);
    const dimensions = Object.fromEntries((alarm.Dimensions as Json[]).map((d) => [d.Name, d.Value]));
    expect(dimensions.Region).toBe("Global");
    expect(JSON.stringify(dimensions.DistributionId)).toContain(sandboxId);
    expect(alarm.TreatMissingData).toBe("notBreaching");
    const actions = JSON.stringify(alarm.AlarmActions);
    expect(ofType("AWS::SNS::Topic").some(([id]) => actions.includes(`"${id}"`))).toBe(true);
  });

  it("is on the operations dashboard", () => {
    const [, dashboard] = ofType("AWS::CloudWatch::Dashboard")[0]!;
    expect(JSON.stringify(dashboard.Properties.DashboardBody)).toContain(`${UI_SANDBOX_ALARMS.bytes}`);
  });
});

describe("the content of the second origin, from the release (V2, D123 (3))", () => {
  const root = mkdtempSync(join(tmpdir(), "ui-sandbox-dist-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A built sandbox: the runner and a small mirror, its .wasm in its own tree. */
  function built(pyodidePackages?: string[]): string {
    const dist = mkdtempSync(join(root, "dist-"));
    const files: Record<string, string> = {
      "sandbox.html": "<!doctype html>",
      "assets/sandbox-abc.js": "void 0",
      "vendor/react/18.3.1/react.mjs": "export default 1",
      "vendor/pyodide/0.26.4/pyodide.js": "void 0",
      "vendor-wasm/pyodide/0.26.4/pyodide.asm.wasm": "\0asm",
    };
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dist, path, ".."), { recursive: true });
      writeFileSync(join(dist, path), body);
    }
    const listed = Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => path.startsWith("vendor"))
        .map(([path, body]) => [path.replace(/^vendor(-wasm)?\//, ""), { sha256: "0".repeat(64), bytes: Buffer.byteLength(body) }]),
    );
    writeFileSync(join(dist, "vendor/manifest.json"), JSON.stringify({ files: listed, ...(pyodidePackages ? { pyodidePackages } : {}) }));
    writeFileSync(join(root, "vendor.json"), JSON.stringify({ pyodide: { packages: ["numpy", "pandas", "matplotlib"] } }));
    return dist;
  }

  function synth(dist: string): Record<string, Json> {
    const stack = new Stack(new App(), "Content", { env: { account: "111122223333", region: "us-east-1" } });
    const bucket = new s3.Bucket(stack, "SandboxBucket");
    const spaOrigin = new CfnParameter(stack, "SpaOrigin", { type: "String" }).valueAsString;
    new UiSandboxContent(stack, "Content", {
      bucket,
      distributionId: "E2EXAMPLE",
      distributionDomainName: "d123.cloudfront.net",
      spaOrigin,
      dist,
      release: false,
    });
    return Template.fromStack(stack).toJSON().Resources as Record<string, Json>;
  }

  const deployments = synth(built());
  const all = Object.values(deployments).filter((r) => r.Type === "Custom::CDKBucketDeployment");
  const prefixed = (prefix: string) => all.filter((d) => d.Properties.DestinationBucketKeyPrefix === prefix);

  it("serves .wasm as application/wasm, uploaded apart from the rest of the mirror (P4)", () => {
    const mirror = prefixed("vendor/");
    expect(mirror).toHaveLength(2);
    const wasm = mirror.filter((d) => d.Properties.SystemMetadata?.["content-type"] === "application/wasm");
    expect(wasm).toHaveLength(1);
    const rest = mirror.find((d) => d !== wasm[0])!;
    expect(rest.Properties.SystemMetadata?.["content-type"]).toBeUndefined();
  });

  it("keeps the mirror and the runner's assets forever in the browser, and never the entry point", () => {
    for (const deployment of [...prefixed("vendor/"), ...prefixed("assets/")]) {
      expect(deployment.Properties.SystemMetadata["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(deployment.Properties.Prune).toBe(false);
    }
    const entry = all.filter((d) => d.Properties.DestinationBucketKeyPrefix === undefined);
    expect(entry).toHaveLength(1);
    expect(entry[0].Properties.SystemMetadata["cache-control"]).toBe("no-store");
    expect(entry[0].Properties.DistributionPaths).toEqual(["/sandbox.html", "/runner-config.json"]);
    expect(entry[0].Properties.DistributionId).toBe("E2EXAMPLE");
  });

  it("writes runner-config.json with the SPA's origin, the only window the runner answers", () => {
    const entry = all.find((d) => d.Properties.DestinationBucketKeyPrefix === undefined)!;
    // sandbox.html and runner-config.json; the origin is a deploy-time value of the template.
    expect(entry.Properties.SourceObjectKeys).toHaveLength(2);
    expect(JSON.stringify(entry.Properties.SourceMarkers)).toContain('{"Ref":"SpaOrigin"}');
  });

  it("refuses a sandbox that is not built, or a mirror that is not its manifest", () => {
    const dist = built();
    expect(() => checkUiSandboxDist(join(root, "nothing"), false)).toThrow(/not built/);
    writeFileSync(join(dist, "vendor/react/18.3.1/react.mjs"), "changed after the manifest");
    expect(() => checkUiSandboxDist(dist, false)).toThrow(/does not match its manifest/);
  });

  it("refuses a release whose mirror lacks the Pyodide packages", () => {
    expect(() => checkUiSandboxDist(built(), true)).toThrow(/Pyodide packages/);
    expect(() => checkUiSandboxDist(built(["numpy"]), true)).toThrow(/pandas, matplotlib/);
    expect(() => checkUiSandboxDist(built(["matplotlib", "numpy", "pandas"]), true)).not.toThrow();
  });
});
