import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  API_RATE_LIMIT,
  API_RATE_LIMITED_BODY,
  EDGE_RATE_LIMIT,
  RATE_LIMITED_PAGE,
  RATE_LIMITED_RETRY_SECONDS,
} from "../lib/constructs/edge.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* Per-IP rate limits of the edge web ACL, sized for an office behind one address (D72). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
/* eslint-disable @typescript-eslint/no-explicit-any */
const [acl] = Object.values(template.findResources("AWS::WAFv2::WebACL", { Properties: { Scope: "CLOUDFRONT" } })) as any[];
const rules = acl.Properties.Rules as any[];
const rule = (name: string) => rules.find((r) => r.Name === name);

describe("edge web ACL (D72)", () => {
  it("evaluates the managed rules first, then the limit of the API, then the ceiling of everything", () => {
    expect([...rules].sort((a, b) => a.Priority - b.Priority).map((r) => r.Name)).toEqual([
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesAmazonIpReputationList",
      "ApiRateLimitPerIp",
      "RateLimitPerIp",
    ]);
    expect(new Set(rules.map((r) => r.Priority)).size).toBe(rules.length);
  });

  it("counts per IP address every 5 minutes: 6,000 to mango-api and 20,000 in all", () => {
    expect([API_RATE_LIMIT, EDGE_RATE_LIMIT]).toEqual([6000, 20000]);
    const api = rule("ApiRateLimitPerIp").Statement.RateBasedStatement;
    expect(api).toMatchObject({ Limit: 6000, AggregateKeyType: "IP", EvaluationWindowSec: 300 });
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
    expect(Object.keys(template.findResources("AWS::CloudFront::Distribution"))).toHaveLength(1);
    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution")) as any[];
    expect(distribution.Properties.DistributionConfig.CacheBehaviors.map((b: any) => b.PathPattern)).toEqual(["/api/*"]);
    // The ceiling has no filter: nothing gets around it.
    const all = rule("RateLimitPerIp").Statement.RateBasedStatement;
    expect(all).toEqual({ Limit: 20000, AggregateKeyType: "IP", EvaluationWindowSec: 300 });
  });

  it("answers a block with 429 and a Retry-After of 3 minutes, not with the 403 page of CloudFront", () => {
    // A block lifts between 90 and 180 seconds after the traffic drops (measured, D72).
    expect(RATE_LIMITED_RETRY_SECONDS).toBe(180);
    const bodies = acl.Properties.CustomResponseBodies;
    expect(Object.keys(bodies).sort()).toEqual(["ApiRateLimited", "RateLimited"]);
    for (const [name, body] of [
      ["ApiRateLimitPerIp", "ApiRateLimited"],
      ["RateLimitPerIp", "RateLimited"],
    ] as const) {
      const response = rule(name).Action.Block.CustomResponse;
      expect(response.ResponseCode).toBe(429);
      expect(response.CustomResponseBodyKey).toBe(body);
      const headers = Object.fromEntries(response.ResponseHeaders.map((h: any) => [h.Name, h.Value]));
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
    for (const r of rules.filter((x) => x.Action?.Block)) {
      const names = r.Action.Block.CustomResponse.ResponseHeaders.map((h: any) => h.Name.toLowerCase());
      expect(names).not.toContain("content-security-policy");
    }
    const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    expect(Object.keys(policies)).toHaveLength(1);
    const [policyId, policy] = Object.entries(policies)[0] as [string, any];
    const csp = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy;
    expect(csp.Override).toBe(true);
    const directives = (csp.ContentSecurityPolicy as string).split("; ");
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"]) {
      expect(directives).toContain(directive);
    }
    expect(csp.ContentSecurityPolicy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution")) as any[];
    const config = distribution.Properties.DistributionConfig;
    for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
      expect(behavior.ResponseHeadersPolicyId).toEqual({ Ref: policyId });
    }
  });

  it("answers what reaches mango-api with the JSON error mango-api itself gives for a rate limit", () => {
    expect(acl.Properties.CustomResponseBodies.ApiRateLimited).toEqual({
      ContentType: "APPLICATION_JSON",
      Content: API_RATE_LIMITED_BODY,
    });
    const body = JSON.parse(API_RATE_LIMITED_BODY);
    expect(body).toEqual({ error: { code: "rate_limited", message: "too many requests; try again later" } });
    // The code and the message of `rate_limited()` in mango-api: the SPA reads one format.
    const web = readFileSync(resolve(import.meta.dirname, "../../apps/api/src/mango_api/web.py"), "utf8");
    expect(web).toContain(`"${body.error.code}"`);
    expect(web).toContain(`"${body.error.message}"`);
    expect(web).toContain('content={**(extra or {}), "error": {"code": code, "message": message}}');
  });

  it("answers a page load with a minimal page: no script, no style, nothing but ASCII", () => {
    expect(acl.Properties.CustomResponseBodies.RateLimited).toEqual({ ContentType: "TEXT_HTML", Content: RATE_LIMITED_PAGE });
    expect(RATE_LIMITED_PAGE).toMatch(/^<!doctype html><html lang="es">/);
    // The wait it names agrees with `Retry-After`: minutes, not «un minuto».
    expect(RATE_LIMITED_PAGE).toContain("Espera unos minutos");
    expect(RATE_LIMITED_PAGE).not.toMatch(/<script|<style|<link|<img|<a |<form|style=|href=|src=|\son[a-z]+=/i);
    // CloudFormation does not keep other characters of a template intact.
    expect(RATE_LIMITED_PAGE).toMatch(/^[\x20-\x7e]+$/);
    // A body of a web ACL holds at most 4 KB.
    expect(Buffer.byteLength(RATE_LIMITED_PAGE)).toBeLessThan(4096);
  });
});
