import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, memoryName } from "../names.js";

/**
 * Whether the agents of the installation remember their people (D122). **Off** until a release
 * turns it on, once «Memoria» is in the web (M3). Off, the memory exists but nothing reaches it:
 * no role gets a permission on it, the turn worker neither recalls nor writes and mango-api
 * answers that nothing is remembered. Turning it on is a change of this constant in a release,
 * never a parameter of one customer.
 */
export const AGENT_MEMORY_ENABLED = false;

/** Days a short-term event lives (TM-ME5): a copy of the turn that must not outlive its need. */
export const MEMORY_EVENT_EXPIRY_DAYS = 7;

/**
 * Where each strategy writes (D122 (8)). Every namespace starts with the actor, which mango-api
 * builds from the verified `sub` and the agent (TM-ME1); `NAMESPACE_TEMPLATES` of
 * `mango_core/memory.py` says the same, and a test keeps them equal.
 */
export const MEMORY_STRATEGIES = {
  preferences: "/mango/{actorId}/preferences/",
  facts: "/mango/{actorId}/facts/",
  summaries: "/mango/{actorId}/summaries/{sessionId}/",
} as const;

/**
 * Least score of a record the turn worker recalls (`AGENT_MEMORY_MIN_SCORE`). M0 measured 0.35 to
 * 0.57 for what a person asked, and 0.5 recalled nothing (2026-11-08): `RETRIEVAL_MIN_SCORE` of
 * `mango_core/memory.py` is the same default, and a test keeps them equal.
 */
export const MEMORY_MIN_SCORE = 0.3;

/**
 * What the turn worker does with the memory (D122 (8), precised 2026-11-08): recall the person's
 * preferences and facts before the harness is invoked and write one event with what the person
 * said. Nothing else: no listing, no reading of events, no deletion. The harness of an agent has
 * no memory, and neither its role nor the boundary of agent roles reach it.
 */
export const WORKER_MEMORY_ACTIONS = ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:RetrieveMemoryRecords"];

/**
 * The actors and namespaces the worker may name: those of a person (`m1:<agent>:<sub>`, built by
 * `mango_core.memory.actor_id`), never the sentinel, and only the namespaces a turn recalls. IAM
 * cannot narrow it to the person of each turn: the role is one for every person, and the actor
 * the worker builds from the verified `sub` is what separates them (TM-ME1).
 */
export const WORKER_MEMORY_ACTORS = "m1:*";
export const WORKER_RECALLED_NAMESPACES = ["/mango/m1:*/preferences/", "/mango/m1:*/facts/"];

/**
 * What mango-api does: the person's own «Memoria» and the purge of a person (TM-ME3, TM-ME5).
 * Without a condition on the namespace: it would deny every call by record id (`GetMemoryRecord`,
 * `DeleteMemoryRecord`, `BatchDeleteMemoryRecords`), even on one's own, because those calls carry
 * no namespace (M0). mango-api checks the namespace of each record in its code before deleting it.
 */
export const API_MEMORY_ACTIONS = [
  "bedrock-agentcore:ListActors",
  "bedrock-agentcore:ListSessions",
  "bedrock-agentcore:ListEvents",
  "bedrock-agentcore:DeleteEvent",
  "bedrock-agentcore:ListMemoryRecords",
  "bedrock-agentcore:GetMemoryRecord",
  "bedrock-agentcore:DeleteMemoryRecord",
  "bedrock-agentcore:BatchDeleteMemoryRecords",
];

export interface AgentMemoryProps {
  readonly installation: Installation;
  /** Tests only: the release decides with `AGENT_MEMORY_ENABLED`. */
  readonly enabled?: boolean;
}

/**
 * The AgentCore Memory of the installation (D122, `memory-threat-model.md`): `Mango_<ns>_memory`,
 * with a key of its own, events for 7 days and three strategies (preferences, facts and summaries).
 * It holds data of the people: it is in Core, never in a nested stack (D99 (2)), and is retained
 * with the data of a customer installation.
 *
 * - One memory for every agent, read and written by the turn worker only (D122 (8)): the harness of
 *   an agent has none, never the managed memory a harness creates when nothing is said (TM-ME8),
 *   and the worker writes only what the person said (TM-ME2).
 * - The `actorId` the worker names separates the people (TM-ME1): IAM narrows the worker to the
 *   actors of people and to the namespaces a turn recalls, never to one person (M0, M-b).
 * - The strategies extract with the model of the service, outside the turn's reservation
 *   (TM-ME7): their cost is reconciled by the tags of the resource.
 */
export class AgentMemory extends Construct {
  readonly enabled: boolean;
  readonly key: kms.Key;
  readonly memory: agentcore.CfnMemory;
  /** What mango-api and the provisioner read: whether memory is on, the memory and its key. */
  readonly environment: Record<string, string>;

  constructor(scope: Construct, id: string, props: AgentMemoryProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    this.enabled = props.enabled ?? AGENT_MEMORY_ENABLED;
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY;

    this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(ns, "memory")}`,
      description: "Encrypts the AgentCore Memory of Mango agents: what they remember of each person (D122)",
      enableKeyRotation: true,
      removalPolicy,
    });

    this.memory = new agentcore.CfnMemory(this, "Memory", {
      name: memoryName(ns),
      description: "Mango agents: what each agent remembers of each person (D122)",
      encryptionKeyArn: this.key.keyArn,
      eventExpiryDuration: MEMORY_EVENT_EXPIRY_DAYS,
      memoryStrategies: [
        {
          userPreferenceMemoryStrategy: {
            name: "preferences",
            description: "Preferences the person stated",
            namespaceTemplates: [MEMORY_STRATEGIES.preferences],
          },
        },
        {
          semanticMemoryStrategy: {
            name: "facts",
            description: "Facts about the person and their work",
            namespaceTemplates: [MEMORY_STRATEGIES.facts],
          },
        },
        {
          summaryMemoryStrategy: {
            name: "summaries",
            description: "Summary of each conversation",
            namespaceTemplates: [MEMORY_STRATEGIES.summaries],
          },
        },
      ],
    });
    this.memory.applyRemovalPolicy(removalPolicy);

    this.environment = {
      AGENT_MEMORY_ENABLED: String(this.enabled),
      AGENT_MEMORY_ARN: this.memory.attrMemoryArn,
      AGENT_MEMORY_KEY_ARN: this.key.keyArn,
      AGENT_MEMORY_MIN_SCORE: String(MEMORY_MIN_SCORE),
    };
  }

  /** The key through the service only: callers never decrypt the memory themselves. */
  private keyStatement(sid: string): iam.PolicyStatement {
    return new iam.PolicyStatement({
      sid,
      actions: ["kms:Decrypt", "kms:GenerateDataKey"],
      resources: [this.key.keyArn],
      conditions: { StringEquals: { "kms:ViaService": `bedrock-agentcore.${Stack.of(this).region}.amazonaws.com` } },
    });
  }

  /**
   * The turn worker (D122 (8)): recall the preferences and facts of a person's actor and write
   * the events of what the person said. Nothing while memory is off.
   */
  grantWorker(role: iam.IRole): void {
    if (!this.enabled) return;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "WorkerMemoryEvents",
        actions: ["bedrock-agentcore:CreateEvent"],
        resources: [this.memory.attrMemoryArn],
        conditions: { StringLike: { "bedrock-agentcore:actorId": WORKER_MEMORY_ACTORS } },
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "WorkerMemoryRecall",
        actions: ["bedrock-agentcore:RetrieveMemoryRecords"],
        resources: [this.memory.attrMemoryArn],
        conditions: { StringLike: { "bedrock-agentcore:namespace": WORKER_RECALLED_NAMESPACES } },
      }),
    );
    role.addToPrincipalPolicy(this.keyStatement("WorkerMemoryKey"));
  }

  /** mango-api: «Memoria» of the person and the purge. Nothing while memory is off. */
  grantApi(role: iam.IRole): void {
    if (!this.enabled) return;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({ sid: "ApiMemory", actions: API_MEMORY_ACTIONS, resources: [this.memory.attrMemoryArn] }),
    );
    role.addToPrincipalPolicy(this.keyStatement("ApiMemoryKey"));
  }
}
