import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadReleaseDefaults } from "../lib/config/release.js";
import { AGENTCORE_VPC_ZONE_IDS, loadInstallation } from "../lib/config/schema.js";
import { CHAT_FILES_LINK_MS, SCAN_CLEAN, SCAN_TAG } from "../lib/constructs/chat-files.js";
import { codeInterpreterPrices, SANDBOX_VPC_CIDR } from "../lib/constructs/code-sandbox.js";
import { releaseSynthesizer, UNPUBLISHED_TARGET } from "../lib/release-target.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

/* The code sandbox (D114) and the files of the chat (D116); threat models
 * code-interpreter-threat-model.md (TM-CI3) and chat-files-threat-model.md (TM-CF3, CF5). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; DependsOn?: string[]; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
  installation: cfg,
  env: { account: cfg.mangoAccountId, region: cfg.region },
});
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;
const sandboxStack = nestedStacks(core).find((stack) => stack.node.id === "Sandbox")!;
const sandboxResources = nestedTemplate(sandboxStack).Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
function only(type: string, props: Record<string, unknown>): [string, Resource] {
  const found = Object.entries(template.findResources(type, { Properties: props }));
  expect(found).toHaveLength(1);
  return found[0] as [string, Resource];
}
function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === roleId),
    )
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}

const [ciId, ci] = only("AWS::BedrockAgentCore::CodeInterpreterCustom", { Name: `Mango_${ns}_sandbox` });
const [vpcId, vpc] = only("AWS::EC2::VPC", { CidrBlock: SANDBOX_VPC_CIDR });
const [sgId, sg] = only("AWS::EC2::SecurityGroup", { GroupName: `Mango-${ns}-sandbox` });
const subnets = ofType("AWS::EC2::Subnet").filter(([, r]) => JSON.stringify(r.Properties.VpcId) === JSON.stringify({ Ref: vpcId }));
const [, alias] = only("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-chat-files` });
const keyId = (alias.Properties.TargetKeyId as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const [bucketId, bucket] = ofType("AWS::S3::Bucket").find(([, r]) =>
  JSON.stringify(r.Properties.BucketEncryption ?? {}).includes(keyId),
)!;
const [, bucketPolicy] = ofType("AWS::S3::BucketPolicy").find(
  ([, r]) => JSON.stringify(r.Properties.Bucket) === JSON.stringify({ Ref: bucketId }),
)!;
const bucketStatements = bucketPolicy.Properties.PolicyDocument.Statement as Statement[];
const bySid = (sid: string) => bucketStatements.find((s) => s.Sid === sid)!;
const [scannerId, scanner] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-ChatFilesScan` });
const scannerArn = {
  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:iam::${cfg.mangoAccountId}:role/Mango-${ns}-ChatFilesScan`]],
};

describe("code sandbox (D114)", () => {
  it("is the Code Interpreter Mango_<ns>_sandbox, in VPC mode, without an execution role", () => {
    expect(ci.Properties.ExecutionRoleArn).toBeUndefined();
    expect(ci.Properties.NetworkConfiguration.NetworkMode).toBe("VPC");
    const config = ci.Properties.NetworkConfiguration.VpcConfig;
    expect(config.SecurityGroups).toEqual([{ "Fn::GetAtt": [sgId, "GroupId"] }]);
    expect(config.Subnets.sort()).toEqual(subnets.map(([id]) => ({ Ref: id })).sort());
    // In the nested stack, never in Core (D99): it holds no data.
    expect(Object.keys(sandboxResources)).toContain(ciId);
  });

  it("carries the tags of the stack, in an installation and in a release (D77)", () => {
    // An installation tags its stacks when it deploys them, and CloudFormation passes them on;
    // a release has no namespace before it deploys, and tags each resource with the parameter.
    const release = new CoreStack(new App({ context: { packsDir: mkdtempSync(join(tmpdir(), "c1-no-packs-")) } }), "Core", {
      env: { region: "us-east-1" },
      synthesizer: releaseSynthesizer(UNPUBLISHED_TARGET),
      release: UNPUBLISHED_TARGET,
    });
    const nested = nestedTemplate(nestedStacks(release).find((stack) => stack.node.id === "Sandbox")!);
    const [releaseCi] = Object.values(nested.Resources as Record<string, Resource>).filter(
      (r) => r.Type === "AWS::BedrockAgentCore::CodeInterpreterCustom",
    );
    expect(Object.keys(releaseCi!.Properties.Tags)).toContain("mango:namespace");
    expect(ci.Properties.Tags).toBeUndefined();
  }, 120_000);

  it("no role of the installation is one AgentCore could give the sandbox", () => {
    for (const [, role] of ofType("AWS::IAM::Role")) {
      const text = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
      expect(text).not.toContain("code-interpreter");
    }
    expect(JSON.stringify(sandboxResources)).not.toContain("ExecutionRoleArn");
  });

  it("has two isolated subnets of its own VPC, in zones where AgentCore supports VPC mode", () => {
    expect(subnets).toHaveLength(2);
    for (const [id, subnet] of subnets) {
      expect(AGENTCORE_VPC_ZONE_IDS).toContain(subnet.Properties.AvailabilityZoneId);
      expect(subnet.Properties.AvailabilityZone).toBeUndefined();
      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
      expect(Object.keys(sandboxResources)).toContain(id);
    }
    expect(subnets.map(([, s]) => s.Properties.AvailabilityZoneId)).toEqual(cfg.availabilityZoneIds);
    // A route table each, with no route but the local one.
    const tables = ofType("AWS::EC2::SubnetRouteTableAssociation")
      .filter(([, a]) => subnets.some(([id]) => a.Properties.SubnetId.Ref === id))
      .map(([, a]) => a.Properties.RouteTableId.Ref as string);
    expect(tables).toHaveLength(2);
    const routes = ofType("AWS::EC2::Route").filter(([, r]) => tables.includes(r.Properties.RouteTableId.Ref));
    expect(routes).toEqual([]);
  });

  it("lives in a VPC with no way out: no gateway, NAT, endpoint or peering, and no DNS (T5, TM-CI3)", () => {
    expect(vpc.Properties.EnableDnsSupport).toBe(false);
    expect(vpc.Properties.EnableDnsHostnames).toBe(false);
    const touchesVpc = (r: Resource) => JSON.stringify(r.Properties ?? {}).includes(`{"Ref":"${vpcId}"}`);
    for (const type of [
      "AWS::EC2::InternetGateway",
      "AWS::EC2::VPCGatewayAttachment",
      "AWS::EC2::NatGateway",
      "AWS::EC2::VPCEndpoint",
      "AWS::EC2::VPCPeeringConnection",
      "AWS::EC2::TransitGatewayAttachment",
      "AWS::EC2::EgressOnlyInternetGateway",
      "AWS::EC2::VPCCidrBlock",
    ]) {
      expect(ofType(type).filter(([, r]) => touchesVpc(r)), type).toEqual([]);
    }
    // What the code tries to reach and cannot is logged.
    const [, flowLog] = ofType("AWS::EC2::FlowLog").find(([, r]) => r.Properties.ResourceId?.Ref === vpcId)!;
    expect(flowLog.Properties.TrafficType).toBe("REJECT");
    expect(flowLog.Properties.LogDestinationType).toBe("s3");
    // Its delivery may write there, from this account only, in the policy CloudFormation owns.
    const logsPolicy = ofType("AWS::S3::BucketPolicy")
      .flatMap(([, r]) => r.Properties.PolicyDocument.Statement as Statement[])
      .find((st) => st.Sid === "SandboxFlowLogsWrite")!;
    expect(logsPolicy.Principal).toEqual({ Service: "delivery.logs.amazonaws.com" });
    expect(JSON.stringify(logsPolicy.Resource)).toContain(`/sandbox-flow-logs/AWSLogs/${cfg.mangoAccountId}/*`);
    expect(logsPolicy.Condition!.StringEquals).toEqual({
      "aws:SourceAccount": cfg.mangoAccountId,
      "s3:x-amz-acl": "bucket-owner-full-control",
    });
    // The stack tagger tags its defaults (D77).
    const [, tagger] = ofType("Custom::MangoStackTags")[0]!;
    expect(tagger.Properties.VpcIds).toContainEqual({ Ref: vpcId });
  });

  it("has a security group that lets nothing in or out", () => {
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    // CDK's rule that matches no traffic: without it CloudFormation would allow all egress.
    expect(sg.Properties.SecurityGroupEgress).toEqual([
      { CidrIp: "255.255.255.255/32", Description: "Disallow all traffic", FromPort: 252, IpProtocol: "icmp", ToPort: 86 },
    ]);
    const rules = [...ofType("AWS::EC2::SecurityGroupEgress"), ...ofType("AWS::EC2::SecurityGroupIngress")];
    expect(rules.filter(([, r]) => JSON.stringify(r.Properties).includes(sgId))).toEqual([]);
  });

  it("prices its seconds from the configuration (D115 (2), rule 7)", () => {
    expect(codeInterpreterPrices(cfg)).toEqual(cfg.codeInterpreterPrices ?? loadReleaseDefaults().codeInterpreterPrices);
    expect(codeInterpreterPrices({ ...cfg, codeInterpreterPrices: { vcpuHour: 1, gbHour: 2 } })).toEqual({
      vcpuHour: 1,
      gbHour: 2,
    });
    const { vcpuHour, gbHour } = loadReleaseDefaults().codeInterpreterPrices;
    expect(vcpuHour).toBeGreaterThan(0);
    expect(gbHour).toBeGreaterThan(0);
  });
});

describe("chat files (D116)", () => {
  it("keeps them in a bucket of their own: its key, TLS only, no public access, versioned, retained", () => {
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.OwnershipControls.Rules).toEqual([{ ObjectOwnership: "BucketOwnerEnforced" }]);
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(bucket.Properties.LoggingConfiguration.LogFilePrefix).toBe("chat-files/");
    expect(JSON.stringify(bucket.Properties.BucketEncryption)).toContain("aws:kms");
    // Retained except when the create that made them rolls back (D58 (27)).
    expect(bucket.DeletionPolicy).toBe(cfg.retainData ? "RetainExceptOnCreate" : "Delete");
    expect(resources[keyId]!.DeletionPolicy).toBe(cfg.retainData ? "RetainExceptOnCreate" : "Delete");
    expect(resources[keyId]!.Properties.EnableKeyRotation).toBe(true);
    const tls = bucketStatements.find((s) => JSON.stringify(s.Condition ?? {}).includes("aws:SecureTransport"));
    expect(tls?.Effect).toBe("Deny");
    // It holds data: in Core, never in a nested stack (D99 (2)).
    expect(Object.keys(sandboxResources)).not.toContain(bucketId);
    expect(Object.keys(sandboxResources)).not.toContain(keyId);
  });

  it("forgets uploads after a day, infected files after a day, and the rest after 90 days", () => {
    const rules = bucket.Properties.LifecycleConfiguration.Rules as Record<string, unknown>[];
    expect(rules).toContainEqual(expect.objectContaining({ Prefix: "uploads/", ExpirationInDays: 1 }));
    expect(rules).toContainEqual(
      expect.objectContaining({ TagFilters: [{ Key: SCAN_TAG, Value: "THREATS_FOUND" }], ExpirationInDays: 1 }),
    );
    expect(rules).toContainEqual(
      expect.objectContaining({
        ExpirationInDays: 90,
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      }),
    );
  });

  it("lets nobody but the scanner read an object its scan did not clear (TBAC, TM-CF3)", () => {
    const deny = bySid("ReadOnlyWhatTheScanCleared");
    expect(deny.Effect).toBe("Deny");
    expect(deny.Principal).toEqual({ AWS: "*" });
    expect(actions(deny).sort()).toEqual(["s3:GetObject", "s3:GetObjectVersion"]);
    // StringNotEquals also matches an object without the tag.
    expect(deny.Condition).toEqual({
      StringNotEquals: { [`s3:ExistingObjectTag/${SCAN_TAG}`]: SCAN_CLEAN },
      ArnNotEquals: { "aws:PrincipalArn": scannerArn },
    });
  });

  it("lets nobody but the scanner set or remove the scan tag, nor upload an object that brings it", () => {
    const tags = bySid("OnlyTheScannerTags");
    expect(tags.Effect).toBe("Deny");
    expect(actions(tags).sort()).toEqual([
      "s3:DeleteObjectTagging",
      "s3:DeleteObjectVersionTagging",
      "s3:PutObjectTagging",
      "s3:PutObjectVersionTagging",
    ]);
    expect(tags.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": scannerArn } });
    const uploads = bySid("NoUploadBringsTheScanTag");
    expect(actions(uploads)).toEqual(["s3:PutObject"]);
    expect(uploads.Condition!["ForAnyValue:StringEquals"]).toEqual({ "s3:RequestObjectTagKeys": [SCAN_TAG] });
  });

  it("refuses a download signature older than the 5 minutes of a link (TM-CF5)", () => {
    const links = bySid("LinksLiveFiveMinutes");
    expect(links.Effect).toBe("Deny");
    expect(actions(links)).toEqual(["s3:GetObject"]);
    expect(links.Condition).toEqual({ NumericGreaterThan: { "s3:signatureAge": CHAT_FILES_LINK_MS } });
    expect(CHAT_FILES_LINK_MS).toBe(300_000);
  });

  it("is scanned by GuardDuty Malware Protection with tagging, through a role of its own (D116 (2))", () => {
    const [planId, plan] = only("AWS::GuardDuty::MalwareProtectionPlan", {});
    expect(Object.keys(sandboxResources)).toContain(planId);
    expect(plan.Properties.ProtectedResource).toEqual({ S3Bucket: { BucketName: { Ref: bucketId } } });
    expect(plan.Properties.Actions).toEqual({ Tagging: { Status: "ENABLED" } });
    expect(plan.Properties.Role).toEqual({ "Fn::GetAtt": [scannerId, "Arn"] });
    // GuardDuty checks the role when the plan is created: its policy first.
    const policyId = Object.entries(resources).find(
      ([, r]) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles?.some((x: { Ref: string }) => x.Ref === scannerId),
    )![0];
    expect(plan.DependsOn).toContain(policyId);
    expect(scanner.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: "malware-protection-plan.guardduty.amazonaws.com" },
      },
    ]);
  });

  it("gives the scanner what AWS documents, on this bucket and its key only", () => {
    const statements = statementsOf(scannerId);
    expect(statements.map((s) => s.Sid).sort()).toEqual([
      "BucketEventsToEventBridge",
      "ChatFilesKey",
      "CheckBucketOwnership",
      "ManagedRuleForS3Events",
      "PutValidationObject",
      "ReadToScan",
      "TagScannedObjects",
      "WatchManagedRule",
    ]);
    for (const statement of statements) {
      expect(statement.Effect).toBe("Allow");
      expect(actions(statement).some((a) => a.includes("*"))).toBe(false);
      const text = JSON.stringify(statement.Resource);
      expect(text).not.toBe('"*"');
      expect(
        text.includes(bucketId) || text.includes(keyId) || text.includes("DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3"),
      ).toBe(true);
    }
    const key = statements.find((s) => s.Sid === "ChatFilesKey")!;
    expect(key.Condition).toEqual({ StringEquals: { "kms:ViaService": `s3.${cfg.region}.amazonaws.com` } });
    const managed = statements.find((s) => s.Sid === "ManagedRuleForS3Events")!;
    expect(managed.Condition).toEqual({
      StringLike: { "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com" },
    });
  });

  it("is signed for the browser by the presign role: uploads under uploads/, downloads under owner/", () => {
    const [presignId] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-Presign` });
    const statements = statementsOf(presignId);
    const sid = (name: string) => statements.find((s) => s.Sid === name)!;
    expect(actions(sid("UploadChatFiles"))).toEqual(["s3:PutObject"]);
    expect(JSON.stringify(sid("UploadChatFiles").Resource)).toContain(`${bucketId}`);
    expect(JSON.stringify(sid("UploadChatFiles").Resource)).toContain("/uploads/*");
    expect(actions(sid("DownloadChatFiles"))).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(sid("DownloadChatFiles").Resource)).toContain("/owner/*");
    expect(actions(sid("ChatFilesKey")).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(sid("ChatFilesKey").Resource).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
  });

  it("is reached by no role of mango-api's task yet: nothing uses the sandbox or the files (C1)", () => {
    const [apiRoleId] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
    const api = JSON.stringify(statementsOf(apiRoleId));
    expect(api).not.toContain(bucketId);
    expect(api).not.toContain(ciId);
  });
});
