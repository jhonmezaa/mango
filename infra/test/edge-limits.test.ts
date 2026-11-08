import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  API_RATE_LIMIT,
  API_RATE_LIMITED_BODY,
  BODY_SIZE_LABEL,
  BODY_SIZE_RULE,
  CANVAS_VERSIONS_PATH,
  EDGE_RATE_LIMIT,
  RATE_LIMITED_PAGE,
  RATE_LIMITED_RETRY_SECONDS,
  RATE_LIMITED_STYLE,
  RATE_LIMITED_STYLE_HASH,
} from "../lib/constructs/edge.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

/* Per-IP rate limits of the edge web ACL, sized for an office behind one address (D72). */

const cfg = loadInstallation(
  resolve(import.meta.dirname, "../config/example.json"),
);
const template = fromCore(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
/* eslint-disable @typescript-eslint/no-explicit-any */
const [acl] = Object.values(
  template.findResources("AWS::WAFv2::WebACL", {
    Properties: { Scope: "CLOUDFRONT" },
  }),
) as any[];
const rules = acl.Properties.Rules as any[];
const rule = (name: string) => rules.find((r) => r.Name === name);
// The SPA's distribution and its headers policy; the second origin (D123) has its own of each.
const spaDistributions = () =>
  template.findResources("AWS::CloudFront::Distribution", {
    Properties: {
      DistributionConfig: { Comment: `Mango-${cfg.namespace}-web` },
    },
  });
const spaPolicies = () =>
  template.findResources("AWS::CloudFront::ResponseHeadersPolicy", {
    Properties: {
      ResponseHeadersPolicyConfig: {
        Name: `Mango-${cfg.namespace}-security-headers`,
      },
    },
  });

describe("edge web ACL (D72)", () => {
  it("evaluates the managed rules first, then the limit of the API, then the ceiling of everything", () => {
    expect(
      [...rules].sort((a, b) => a.Priority - b.Priority).map((r) => r.Name),
    ).toEqual([
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesAmazonIpReputationList",
      "BodySizeOutsideCanvas",
      "ApiRateLimitPerIp",
      "RateLimitPerIp",
    ]);
    expect(new Set(rules.map((r) => r.Priority)).size).toBe(rules.length);
  });

  it("blocks bodies over 8 KB everywhere but the save of a Canvas version (D124 (6) (i))", () => {
    const common = rule("AWSManagedRulesCommonRuleSet").Statement
      .ManagedRuleGroupStatement;
    // Only that one rule of the group counts; every other one still blocks.
    expect(common.RuleActionOverrides).toEqual([
      { Name: BODY_SIZE_RULE, ActionToUse: { Count: {} } },
    ]);
    for (const name of [
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesAmazonIpReputationList",
    ]) {
      expect(
        rule(name).Statement.ManagedRuleGroupStatement.RuleActionOverrides,
      ).toBeUndefined();
    }
    const size = rule("BodySizeOutsideCanvas");
    expect(size.Action).toEqual({ Block: {} });
    const [label, not] = size.Statement.AndStatement.Statements;
    expect(label).toEqual({
      LabelMatchStatement: { Scope: "LABEL", Key: BODY_SIZE_LABEL },
    });
    const [method, path] = not.NotStatement.Statement.AndStatement.Statements;
    expect(method.ByteMatchStatement).toMatchObject({
      SearchString: "POST",
      PositionalConstraint: "EXACTLY",
    });
    expect(path.RegexMatchStatement.RegexString).toBe(CANVAS_VERSIONS_PATH);
    const re = new RegExp(CANVAS_VERSIONS_PATH);
    expect(
      re.test(
        `/api/conversations/${"a".repeat(32)}/textdocs/01${"D".repeat(24)}/versions`,
      ),
    ).toBe(true);
    for (const other of [
      `/api/conversations/${"a".repeat(32)}/textdocs/01${"D".repeat(24)}/exports`,
      `/api/conversations/${"a".repeat(32)}/textdocs/01${"D".repeat(24)}/versions/1`,
      `/api/chat`,
      `/api/conversations/${"a".repeat(32)}/textdocs/01${"D".repeat(24)}/versions/../../x`,
    ]) {
      expect(re.test(other)).toBe(false);
    }
  });

  it("counts per IP address every 5 minutes: 6,000 to mango-api and 20,000 in all", () => {
    expect([API_RATE_LIMIT, EDGE_RATE_LIMIT]).toEqual([6000, 20000]);
    const api = rule("ApiRateLimitPerIp").Statement.RateBasedStatement;
    expect(api).toMatchObject({
      Limit: 6000,
      AggregateKeyType: "IP",
      EvaluationWindowSec: 300,
    });
    // What CloudFront sends to mango-api: the same prefix as its `/api/*` behavior, on the path
    // as it was sent. A transformation would let `/api/%2e%2e/x` reach mango-api uncounted.
    expect(api.ScopeDownStatement).toEqual({
      ByteMatchStatement: {
        FieldToMatch: { UriPath: {} },
        PositionalConstraint: "STARTS_WITH",
        SearchString: "/api/",
        TextTransformations: [{ Priority: 0, Type: "NONE" }],
      },
    });
    expect(Object.keys(spaDistributions())).toHaveLength(1);
    const [distribution] = Object.values(spaDistributions()) as any[];
    expect(
      distribution.Properties.DistributionConfig.CacheBehaviors.map(
        (b: any) => b.PathPattern,
      ),
    ).toEqual(["/api/*"]);
    // The ceiling has no filter: nothing gets around it.
    const all = rule("RateLimitPerIp").Statement.RateBasedStatement;
    expect(all).toEqual({
      Limit: 20000,
      AggregateKeyType: "IP",
      EvaluationWindowSec: 300,
    });
  });

  it("answers a block with 429 and a Retry-After of 3 minutes, not with the 403 page of CloudFront", () => {
    // A block lifts between 90 and 180 seconds after the traffic drops (measured, D72).
    expect(RATE_LIMITED_RETRY_SECONDS).toBe(180);
    const bodies = acl.Properties.CustomResponseBodies;
    expect(Object.keys(bodies).sort()).toEqual([
      "ApiRateLimited",
      "RateLimited",
    ]);
    for (const [name, body] of [
      ["ApiRateLimitPerIp", "ApiRateLimited"],
      ["RateLimitPerIp", "RateLimited"],
    ] as const) {
      const response = rule(name).Action.Block.CustomResponse;
      expect(response.ResponseCode).toBe(429);
      expect(response.CustomResponseBodyKey).toBe(body);
      const headers = Object.fromEntries(
        response.ResponseHeaders.map((h: any) => [h.Name, h.Value]),
      );
      expect(headers).toEqual({
        "Retry-After": String(RATE_LIMITED_RETRY_SECONDS),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      // Whole seconds, at least 1, as every 429 of mango-api.
      expect(headers["Retry-After"]).toMatch(/^[1-9][0-9]*$/);
    }
  });

  it("leaves the CSP of a block to the response headers policy of the distribution", () => {
    // What this checks is the template. What a browser gets was seen in an installation
    // (2026-10-06, D72): the 429 of both rules arrived with the CSP of the application, also
    // while the web ACL still declared one of its own, because the policy of CloudFront
    // overrides it. So the web ACL declares none, and the policy must stay on every behavior,
    // with `override` and with its CSP.
    // The rate limits answer with a body of their own; the body size rule (D124 (6) (i)) with
    // the plain block of the managed group.
    for (const r of rules.filter((x) => x.Action?.Block?.CustomResponse)) {
      const names = r.Action.Block.CustomResponse.ResponseHeaders.map(
        (h: any) => h.Name.toLowerCase(),
      );
      expect(names).not.toContain("content-security-policy");
    }
    const policies = spaPolicies();
    expect(Object.keys(policies)).toHaveLength(1);
    const [policyId, policy] = Object.entries(policies)[0] as [string, any];
    const csp =
      policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
        .ContentSecurityPolicy;
    expect(csp.Override).toBe(true);
    // The CSP names the documents bucket of the knowledge bases (D88 (9)): a join, rendered
    // here with each deploy-time value as `<value>`.
    const text = renderJoin(csp.ContentSecurityPolicy);
    const directives = text.split("; ");
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      `style-src 'self' ${RATE_LIMITED_STYLE_HASH}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ]) {
      expect(directives).toContain(directive);
    }
    expect(text).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    const [distribution] = Object.values(spaDistributions()) as any[];
    const config = distribution.Properties.DistributionConfig;
    for (const behavior of [
      config.DefaultCacheBehavior,
      ...config.CacheBehaviors,
    ]) {
      expect(behavior.ResponseHeadersPolicyId).toEqual({ Ref: policyId });
    }
  });

  it("answers what reaches mango-api with the JSON error mango-api itself gives for a rate limit", () => {
    expect(acl.Properties.CustomResponseBodies.ApiRateLimited).toEqual({
      ContentType: "APPLICATION_JSON",
      Content: API_RATE_LIMITED_BODY,
    });
    const body = JSON.parse(API_RATE_LIMITED_BODY);
    expect(body).toEqual({
      error: {
        code: "rate_limited",
        message: "too many requests; try again later",
      },
    });
    // The code and the message of `rate_limited()` in mango-api: the SPA reads one format.
    const web = readFileSync(
      resolve(import.meta.dirname, "../../apps/api/src/mango_api/web.py"),
      "utf8",
    );
    expect(web).toContain(`"${body.error.code}"`);
    expect(web).toContain(`"${body.error.message}"`);
    expect(web).toContain(
      'content={**(extra or {}), "error": {"code": code, "message": message}}',
    );
  });

  it("answers a page load with the design's page: no script, nothing external, nothing but ASCII", () => {
    expect(acl.Properties.CustomResponseBodies.RateLimited).toEqual({
      ContentType: "TEXT_HTML",
      Content: RATE_LIMITED_PAGE,
    });
    expect(RATE_LIMITED_PAGE).toMatch(/^<!doctype html><html lang="es">/);
    // The wait it names agrees with `Retry-After`: minutes, not «un minuto».
    expect(RATE_LIMITED_PAGE).toContain("Espera unos minutos");
    expect(RATE_LIMITED_PAGE).toContain("Volver a cargar");
    expect(RATE_LIMITED_PAGE).not.toMatch(
      /<script|<link|<img|<form|<iframe|style=|src=|url\(|@import|\son[a-z]+=/i,
    );
    // One link, to the same address (a reload); one style block, the hashed one.
    expect(RATE_LIMITED_PAGE.match(/href=/g)).toEqual(["href="]);
    expect(RATE_LIMITED_PAGE).toContain('href=""');
    expect(RATE_LIMITED_PAGE.match(/<style>([^<]*)<\/style>/g)).toEqual([
      `<style>${RATE_LIMITED_STYLE}</style>`,
    ]);
    // CloudFormation does not keep other characters of a template intact.
    expect(RATE_LIMITED_PAGE).toMatch(/^[\x20-\x7e]+$/);
    // A body of a web ACL holds at most 4 KB.
    expect(Buffer.byteLength(RATE_LIMITED_PAGE)).toBeLessThan(4096);
  });

  it("allows the style of that page by its hash, never with 'unsafe-inline'", () => {
    // Written out in edge.ts: changing the style without its hash fails here.
    const [, style] = /<style>([^<]*)<\/style>/.exec(RATE_LIMITED_PAGE) ?? [];
    const hash = createHash("sha256")
      .update(style ?? "", "utf8")
      .digest("base64");
    expect(RATE_LIMITED_STYLE_HASH).toBe(`'sha256-${hash}'`);
    const [policy] = Object.values(spaPolicies()) as any[];
    const text = renderJoin(
      policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
        .ContentSecurityPolicy.ContentSecurityPolicy,
    );
    const styleSrc = text.split("; ").filter((d) => d.startsWith("style-src"));
    expect(styleSrc).toEqual([`style-src 'self' 'sha256-${hash}'`]);
  });
});

function renderJoin(value: unknown): string {
  if (typeof value === "string") return value;
  const join = (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
  if (!join) return "<value>";
  return join[1].map(renderJoin).join(join[0]);
}
