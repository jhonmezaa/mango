import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct, IDependable } from "constructs";
import { Installation } from "../config/schema.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Agents that ship with the release (D34). Their ids are slugs reserved for the release;
 * agents made in the app get random 16-character ids (D32).
 */
export const RELEASE_AGENT_IDS = ["finops"] as const;

/** When the agents of this list became data of the release; only a timestamp of the seed. */
const SEEDED_AT = "2026-10-01T00:00:00+00:00";

/** `agents/<id>/agent.json`: an `AgentDefinition` without models, with the prompt in lines. */
interface ReleaseAgentFile {
  id: string;
  definition: {
    name: string;
    description: string;
    category: string;
    icon: string;
    color: number;
    reports_to: string;
    role: string;
    system_prompt: string[];
    tools: string[];
    limits: {
      max_tokens: number;
      max_iterations: number;
      timeout_seconds: number;
      max_tokens_per_call: number;
      temperature: number;
    };
    groups: string[];
  };
}

export interface ReleaseAgent {
  readonly id: string;
  readonly name: string;
  /** The definition as it is stored: canonical JSON, the bytes `contentHash` covers. */
  readonly canonical: string;
  /** SHA-256 of `canonical`; the provisioner deploys by this hash (TM-M2, TM-M16). */
  readonly contentHash: string;
}

export function loadReleaseAgentFile(id: string): ReleaseAgentFile {
  const file = JSON.parse(readFileSync(resolve(REPO_ROOT, `agents/${id}/agent.json`), "utf8")) as ReleaseAgentFile;
  if (file.id !== id) throw new Error(`agents/${id}/agent.json declares another id`);
  return file;
}

/** Version of the release (`release.yaml`): it signs the approval of its agents. */
export function releaseVersion(): string {
  const match = /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(readFileSync(resolve(REPO_ROOT, "release.yaml"), "utf8"));
  if (!match?.[1]) throw new Error("release.yaml has no version");
  return match[1];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Same form as `mango_core.agents.dumps_definition`: sorted keys, no whitespace, UTF-8. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The definition a release agent is seeded with: `agents/<id>/agent.json` plus the model of
 * the installation (rule 7: models are configuration, the file names none). Every field of
 * `mango_core.agents.AgentDefinition` is written out, so the stored JSON is the one Python
 * would produce (a test on each side pins the same hash).
 */
export function releaseAgentDefinition(id: string, model: string): { name: string; canonical: string } {
  const d = loadReleaseAgentFile(id).definition;
  const definition = {
    name: d.name,
    description: d.description,
    category: d.category,
    icon: d.icon,
    color: d.color,
    reports_to: d.reports_to,
    role: d.role,
    model,
    allowed_models: [model],
    system_prompt: d.system_prompt.join("\n"),
    tools: sortedUnique(d.tools),
    approval_tools: [],
    limits: {
      max_tokens: d.limits.max_tokens,
      max_iterations: d.limits.max_iterations,
      timeout_seconds: d.limits.timeout_seconds,
      max_tokens_per_call: d.limits.max_tokens_per_call,
      temperature: d.limits.temperature,
    },
    groups: sortedUnique(d.groups),
    users: [],
  };
  return { name: d.name, canonical: canonicalJson(definition) };
}

export function releaseAgents(cfg: Installation): ReleaseAgent[] {
  return RELEASE_AGENT_IDS.map((id) => {
    const { name, canonical } = releaseAgentDefinition(id, cfg.models.agent);
    return { id, name, canonical, contentHash: createHash("sha256").update(canonical, "utf8").digest("hex") };
  });
}

export interface ReleaseAgentsProps {
  readonly agents: readonly ReleaseAgent[];
  readonly agentsTable: dynamodb.ITableV2;
  /** Key encrypting the Agents table. */
  readonly dataKey: kms.IKey;
  /** The agent provisioner; it publishes what is seeded here. */
  readonly stateMachine: sfn.IStateMachine;
  /** What must be deployed before a publication starts (the provisioner function). */
  readonly provisioner: IDependable;
}

/**
 * Seeds the agents of the release as data and asks the provisioner to publish them (D34).
 *
 * A release agent is not created in the app, so nobody reviews it there: the release itself
 * approves it. Its first version is written **already approved**, with
 * `approved_by: release@<version>`, and the provisioner publishes it like any other approved
 * version (role with boundary, harness, `live` endpoint), by content hash.
 *
 * Same accepted exception as the Settings seeds (TM-A6, TM-M16): the CDK singleton provider
 * role, which only CloudFormation invokes, may `PutItem` the partition of these agents and
 * nothing else of the table. The write is put-if-absent, so after the first deployment the
 * table is authoritative and every later change of the agent goes through review (D18). The
 * provisioner refuses a release approval for any id or content this stack does not ship
 * (`RELEASE_AGENTS`), so a row written by someone else cannot pass as one of these.
 */
export class ReleaseAgents extends Construct {
  /** Seeds of every release agent; depend on it to run only once the table has them. */
  readonly seeds: IDependable[] = [];

  constructor(scope: Construct, id: string, props: ReleaseAgentsProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const approver = `release@${releaseVersion()}`;
    const table = props.agentsTable.tableName;
    const at = { S: SEEDED_AT };
    const one = { N: "1" };

    for (const agent of props.agents) {
      const key = { S: `AGENT#${agent.id}` };
      const absent = "attribute_not_exists(PK)";
      // Item layout: `packages/py/mango-core/src/mango_core/agents_table.py`.
      const putIfAbsent: Omit<cr.AwsSdkCall, "physicalResourceId"> = {
        service: "DynamoDB",
        action: "transactWriteItems",
        parameters: {
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  PK: key,
                  SK: { S: "META" },
                  agent_id: { S: agent.id },
                  status: { S: "draft" },
                  version: one,
                  latest_version: one,
                  open_version: one,
                  created_by: { S: approver },
                  created_at: at,
                  updated_at: at,
                },
                ConditionExpression: absent,
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  PK: key,
                  SK: { S: "VERSION#000001" },
                  agent_id: { S: agent.id },
                  n: one,
                  status: { S: "approved" },
                  status_index: { S: "VERSION#approved" },
                  status_at: at,
                  revision: one,
                  definition: { S: agent.canonical },
                  content_hash: { S: agent.contentHash },
                  created_by: { S: approver },
                  editors: { SS: [approver] },
                  created_at: at,
                  updated_at: at,
                  submitted_by: { S: approver },
                  submitted_at: at,
                  approved_by: { S: approver },
                  approved_at: at,
                },
                ConditionExpression: absent,
              },
            },
          ],
        },
        // The agent already exists: the table is authoritative, nothing is overwritten.
        ignoreErrorCodesMatching: "TransactionCanceledException",
      };
      const seedCall: cr.AwsSdkCall = {
        ...putIfAbsent,
        physicalResourceId: cr.PhysicalResourceId.of(`agents-seed-${agent.id}`),
      };
      const seed = new cr.AwsCustomResource(this, `Seed-${agent.id}`, {
        onCreate: seedCall,
        onUpdate: seedCall,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["dynamodb:PutItem"],
            resources: [props.agentsTable.tableArn],
            conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`AGENT#${agent.id}`] } },
          }),
          new iam.PolicyStatement({
            actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
            resources: [props.dataKey.keyArn],
            // Only through DynamoDB, never direct use of the shared data key.
            conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
          }),
        ]),
        installLatestAwsSdk: false,
      });
      seed.node.addDependency(props.agentsTable);
      this.seeds.push(seed);

      // Publication: the same execution an approval starts, with identifiers and the hash
      // only. It runs on the first deployment. If a later release ships other content the
      // call repeats, but the seed above did not overwrite the agent, so the stored version
      // no longer matches and the provisioner changes nothing.
      const startCall: cr.AwsSdkCall = {
        service: "SFN",
        action: "startExecution",
        parameters: {
          stateMachineArn: props.stateMachine.stateMachineArn,
          input: JSON.stringify({ agent_id: agent.id, content_hash: agent.contentHash, version: 1 }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`agents-publish-${agent.id}`),
      };
      const publish = new cr.AwsCustomResource(this, `Publish-${agent.id}`, {
        onCreate: startCall,
        onUpdate: startCall,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["states:StartExecution"],
            resources: [props.stateMachine.stateMachineArn],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      publish.node.addDependency(seed, props.stateMachine, props.provisioner);
    }
  }
}
