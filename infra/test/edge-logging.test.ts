import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { ACCESS_LOG_FIELDS, ACCESS_LOG_PREFIX } from "../lib/constructs/edge.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* Access logs of the distribution without the query string (D98 (9), TM-016): the return from
   Microsoft carries the Identity session_id in the query of /conexiones/vuelta. */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const only = (type: string): any => {
  const found = Object.values(template.findResources(type));
  expect(found).toHaveLength(1);
  return found[0];
};

describe("access logs of the distribution", () => {
  it("drops the legacy log, which always writes the query string", () => {
    const distribution = only("AWS::CloudFront::Distribution");
    expect(distribution.Properties.DistributionConfig.Logging).toBeUndefined();
  });

  it("delivers v2 logs of the distribution to the access-logs bucket", () => {
    const source = only("AWS::Logs::DeliverySource");
    expect(source.Properties.Name).toBe(`Mango-${ns}-cloudfront-access`);
    expect(source.Properties.LogType).toBe("ACCESS_LOGS");
    expect(JSON.stringify(source.Properties.ResourceArn)).toContain(":distribution/");
    const destination = only("AWS::Logs::DeliveryDestination");
    expect(JSON.stringify(destination.Properties.DestinationResourceArn)).toContain(`/${ACCESS_LOG_PREFIX}`);
    const delivery = only("AWS::Logs::Delivery");
    expect(delivery.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/AccessLogSource/)]));
  });

  it("never writes the query string nor the cookies", () => {
    const fields: string[] = only("AWS::Logs::Delivery").Properties.RecordFields;
    expect(fields).toEqual([...ACCESS_LOG_FIELDS]);
    expect(fields).not.toContain("cs-uri-query");
    expect(fields).not.toContain("cs(Cookie)");
    // What the legacy log had for diagnosis stays.
    for (const kept of ["date", "time", "c-ip", "cs-uri-stem", "sc-status", "x-edge-request-id"]) {
      expect(fields).toContain(kept);
    }
  });

  it("lets only the log delivery of this account write under the prefix", () => {
    const policies = Object.values(template.findResources("AWS::S3::BucketPolicy"));
    const statements = policies.flatMap(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.Properties.PolicyDocument.Statement as any[],
    );
    const delivery = statements.filter((s) => s.Sid === "CloudFrontAccessLogDelivery");
    expect(delivery).toHaveLength(1);
    expect(delivery[0].Principal).toEqual({ Service: "delivery.logs.amazonaws.com" });
    expect(delivery[0].Action).toBe("s3:PutObject");
    expect(JSON.stringify(delivery[0].Resource)).toContain(`/${ACCESS_LOG_PREFIX}/*`);
    expect(delivery[0].Condition.StringEquals["aws:SourceAccount"]).toBeDefined();
    expect(JSON.stringify(delivery[0].Condition.ArnLike["aws:SourceArn"])).toContain("delivery-source:*");
  });
});
