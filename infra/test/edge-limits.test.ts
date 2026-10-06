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
    // Only what CloudFront sends to mango-api; a path written another way still counts.
    expect(api.ScopeDownStatement).toEqual({
      ByteMatchStatement: {
        FieldToMatch: { UriPath: {} },
        PositionalConstraint: "STARTS_WITH",
        SearchString: "/api/",
        TextTransformations: [
          { Priority: 0, Type: "URL_DECODE" },
          { Priority: 1, Type: "NORMALIZE_PATH" },
          { Priority: 2, Type: "LOWERCASE" },
        ],
      },
    });
    expect(Object.keys(template.findResources("AWS::CloudFront::Distribution"))).toHaveLength(1);
    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution")) as any[];
    expect(distribution.Properties.DistributionConfig.CacheBehaviors.map((b: any) => b.PathPattern)).toEqual(["/api/*"]);
    // The ceiling has no filter: nothing gets around it.
    const all = rule("RateLimitPerIp").Statement.RateBasedStatement;
    expect(all).toEqual({ Limit: 20000, AggregateKeyType: "IP", EvaluationWindowSec: 300 });
  });

  it("answers a block with 429 and Retry-After, not with the 403 page of CloudFront", () => {
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
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      });
      // Whole seconds, at least 1, as every 429 of mango-api.
      expect(headers["Retry-After"]).toMatch(/^[1-9][0-9]*$/);
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
    expect(RATE_LIMITED_PAGE).not.toMatch(/<script|<style|<link|<img|<a |<form|style=|href=|src=|\son[a-z]+=/i);
    // CloudFormation does not keep other characters of a template intact.
    expect(RATE_LIMITED_PAGE).toMatch(/^[\x20-\x7e]+$/);
    // A body of a web ACL holds at most 4 KB.
    expect(Buffer.byteLength(RATE_LIMITED_PAGE)).toBeLessThan(4096);
  });
});
