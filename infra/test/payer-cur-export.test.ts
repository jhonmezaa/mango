import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadReleaseDefaults } from "../lib/config/release.js";
import { loadInstallation } from "../lib/config/schema.js";
import {
  CUR_COLUMNS,
  CUR_EXPORT,
  CUR_TABLE_CONFIGURATION,
  curExportQuery,
} from "../lib/constructs/cur-export.js";
import { PayerStack } from "../lib/stacks/payer-stack.js";
import { payerTemplate } from "./parameters.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const bucket = `mango-${ns}-core-curexportbucket1a2b3c4d-abcdefghijkl`;
type Resource = { Type: string; Properties: any; Condition?: string; DeletionPolicy?: string };

const raw = Template.fromStack(new PayerStack(new App(), "Payer")).toJSON() as {
  Parameters: Record<string, any>;
  Conditions: Record<string, any>;
  Rules: Record<string, any>;
  Resources: Record<string, Resource>;
};
const installed = payerTemplate({ ...cfg, curExportBucket: bucket }).toJSON() as typeof raw;
const exports = Object.values(installed.Resources).filter((r) => r.Type === "AWS::BCMDataExports::Export");
const theExport = exports[0]!;
const props = theExport.Properties.Export;
const codes = loadReleaseDefaults().curReconciliation.bedrockProductCodes;

describe("the CUR 2.0 export of the Payer stack (D104 (4), precision of 2026-11-05)", () => {
  it("is one export, named with the namespace, where the Glue table of Core reads", () => {
    expect(exports).toHaveLength(1);
    expect(props.Name).toBe(`mango-${ns}-bedrock`);
    expect(props.Name).toBe(CUR_EXPORT.exportName(ns));
  });

  it("only exists once CurExportBucket names the bucket: empty by default, so Payer installs before Core", () => {
    const parameter = raw.Parameters.CurExportBucket;
    expect(parameter.Default).toBe("");
    const pattern = new RegExp(parameter.AllowedPattern);
    expect(pattern.test("")).toBe(true);
    expect(pattern.test(bucket)).toBe(true);
    for (const wrong of ["some-other-bucket", "mango-poc-core-packsbucket1234-abcd", "Mango-poc-core-curexportbucket1"]) {
      expect(pattern.test(wrong), wrong).toBe(false);
    }
    expect(theExport.Condition).toBe("HasCurExport");
    expect(raw.Conditions.HasCurExport).toEqual({ "Fn::Not": [{ "Fn::Equals": [{ Ref: "CurExportBucket" }, ""] }] });
  });

  it("cuts the rows down to Bedrock of the Mango account, with the product codes of the release (TM-CUR1)", () => {
    const query: string = props.DataQuery.QueryStatement;
    expect(query).toBe(curExportQuery(cfg.mangoAccountId, codes));
    const where = query.slice(query.indexOf(" WHERE "));
    expect(where).toBe(
      ` WHERE line_item_usage_account_id = '${cfg.mangoAccountId}' AND line_item_product_code IN (` +
        codes.map((c) => `'${c}'`).join(", ") +
        ")",
    );
    expect(query.startsWith(`SELECT ${CUR_COLUMNS.map((c) => c.name).join(", ")} FROM COST_AND_USAGE_REPORT`)).toBe(true);
  });

  it("refuses a product code that could break out of the quotes", () => {
    expect(() => curExportQuery("111122223333", ["AmazonBedrock') OR ('1'='1"])).toThrow();
    expect(() => curExportQuery("111122223333", [])).toThrow();
  });

  it("asks for the caller's identity, daily", () => {
    expect(props.DataQuery.TableConfigurations).toEqual({ COST_AND_USAGE_REPORT: CUR_TABLE_CONFIGURATION });
    expect(CUR_TABLE_CONFIGURATION.INCLUDE_IAM_PRINCIPAL_DATA).toBe("TRUE");
    expect(CUR_TABLE_CONFIGURATION.TIME_GRANULARITY).toBe("DAILY");
    expect(props.RefreshCadence).toEqual({ Frequency: "SYNCHRONOUS" });
  });

  it("delivers Parquet, overwritten, to the bucket of the Mango account under cur/", () => {
    expect(props.DestinationConfigurations.S3Destination).toEqual({
      S3Bucket: bucket,
      S3BucketOwner: cfg.mangoAccountId,
      S3Prefix: CUR_EXPORT.prefix,
      S3Region: "us-east-1",
      S3OutputConfigurations: {
        OutputType: "CUSTOM",
        Format: "PARQUET",
        Compression: "PARQUET",
        Overwrite: "OVERWRITE_REPORT",
      },
    });
  });

  it("goes with the stack and carries the namespace tag", () => {
    expect(theExport.DeletionPolicy).toBe("Delete");
    expect(theExport.Properties.Tags).toContainEqual({ Key: "mango:namespace", Value: ns });
  });

  it("is only created from us-east-1, the Region of Data Exports", () => {
    const rule = raw.Rules.CurExportInDataExportsRegion;
    expect(rule.RuleCondition).toEqual(raw.Conditions.HasCurExport);
    expect(JSON.stringify(rule.Assertions)).toContain('"us-east-1"');
  });

  it("adds no IAM role or policy: tag activation stays a manual step", () => {
    const iam = Object.values(raw.Resources).filter((r) => r.Type.startsWith("AWS::IAM::"));
    const text = JSON.stringify(iam);
    for (const action of ["bcm-data-exports:", "cur:", "ce:UpdateCostAllocationTagsStatus"]) {
      expect(text).not.toContain(action);
    }
  });

  it("the runbook gives the same query and table configuration for the API fallback", () => {
    const runbook = readFileSync(resolve(import.meta.dirname, "../../docs/runbooks/install.md"), "utf8");
    expect(runbook).toContain(curExportQuery("111122223333", codes));
    for (const [key, value] of Object.entries(CUR_TABLE_CONFIGURATION)) {
      expect(runbook).toContain(`"${key}": "${value}"`);
    }
    expect(runbook).toContain("CurExportBucket");
  });
});
