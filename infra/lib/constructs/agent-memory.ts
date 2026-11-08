import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, memoryName } from "../names.js";

/**
 * Whether the agents of the installation remember their people (D122). **Off** until the M0
 * test in AWS confirms the isolation between actors and what the harness stores (D122 (2), (8)),
 * which the owner authorizes. Off, the memory exists but nothing reaches it: no harness gets its
 * ARN, no role gets a permission on it and mango-api answers that nothing is remembered. Turning
 * it on is a change of this constant in a release, never a parameter of one customer.
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

/** What the harness of an agent with memory does with it: store events and recall records. */
export const AGENT_MEMORY_ACTIONS = [
  "bedrock-agentcore:CreateEvent",
  "bedrock-agentcore:GetEvent",
  "bedrock-agentcore:ListEvents",
  "bedrock-agentcore:RetrieveMemoryRecords",
];

/** What mango-api does: the person's own «Memoria» and the purge of a person (TM-ME3, TM-ME5). */
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
 * - One memory for every agent, referenced by ARN from the harness of each agent with memory and
 *   never the managed memory a harness creates when nothing is said (TM-ME8).
 * - The `actorId` of each invocation separates the people (TM-ME1): IAM does not narrow the
 *   actions of a role to an actor until M0 says otherwise (M-b), so a role gets only what it needs.
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
   * The ceiling of an agent role (the boundary, TM-M1): the memory's events and recall, never a
   * deletion. Nothing while memory is off.
   */
  agentStatements(): iam.PolicyStatement[] {
    if (!this.enabled) return [];
    return [
      new iam.PolicyStatement({ sid: "AgentMemory", actions: AGENT_MEMORY_ACTIONS, resources: [this.memory.attrMemoryArn] }),
      this.keyStatement("AgentMemoryKey"),
    ];
  }

  /** mango-api: «Memoria» of the person and the purge. Nothing while memory is off. */
  grantApi(role: iam.IRole): void {
    if (!this.enabled) return;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({ sid: "ApiMemory", actions: API_MEMORY_ACTIONS, resources: [this.memory.attrMemoryArn] }),
    );
    role.addToPrincipalPolicy(this.keyStatement("ApiMemoryKey"));
  }

  /** The provisioner names the memory in a harness: it reads it. Nothing while memory is off. */
  grantProvisioner(role: iam.IRole): void {
    if (!this.enabled) return;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentMemory",
        actions: ["bedrock-agentcore:GetMemory"],
        resources: [this.memory.attrMemoryArn],
      }),
    );
  }
}
