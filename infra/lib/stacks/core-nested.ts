import { CfnParameter, NestedStack, Token } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as avp from "aws-cdk-lib/aws-verifiedpermissions";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { CurReconciler, CurReconcilerProps } from "../constructs/cur-reconciler.js";
import { EvalJudge, EvalJudgeProps } from "../constructs/eval-judge.js";
import { platformPolicies } from "../constructs/governance.js";
import { OperationalAlarms, OperationalAlarmsProps } from "../constructs/operational-alarms.js";
import { RemoteMcpApi } from "../constructs/remote-mcp-api.js";
import { RemoteRelease } from "../constructs/remote-release.js";
import { TraceReader, TraceReaderProps } from "../constructs/trace-reader.js";
import { TurnWorker, TurnWorkerProps } from "../constructs/turn-worker.js";

/**
 * Stacks nested in Core (D99). CloudFormation counts at most 500 resources per template, and a
 * nested stack is one resource of Core however much it holds. Their templates are part of the
 * release (D25): pre-synthesized, published as content-named assets beside the Lambda code and
 * listed in the signed manifest. The operator installs and updates Core as before; CloudFormation
 * creates, updates and deletes the nested stacks with it, under names that start with Core's
 * (`Mango-<ns>-Core-…`).
 *
 * What goes in one has no data: a nested stack whose content changes is updated in place, but a
 * resource that moves between stacks is created again in its new stack before the old one is
 * deleted. That is also why a resource moved with a fixed name gets a new one (D99).
 *
 * Each is a leaf: it reads Core's resources (CDK passes them as parameters of the nested
 * template) and Core reads none of its outputs, so no change of a nested stack updates Core.
 */
abstract class CoreNestedStack extends NestedStack {
  constructor(scope: Construct, id: string, what: string) {
    // No label in the description (D69): a release that does not change the stack does not
    // change its template.
    super(scope, id, { description: `(Mango) mango-hub core: ${what}` });
  }

  /**
   * The namespace as this stack names it. In a release it is Core's parameter, passed to a
   * `Namespace` parameter of the nested template: names and cdk-nag findings then read the
   * same as in Core (`<Namespace>`).
   */
  protected namespaceOf(installation: Installation): Installation {
    if (!Token.isUnresolved(installation.namespace)) return installation;
    const parameter = new CfnParameter(this, "Namespace", { type: "String", description: "Namespace of Core" });
    this.setParameter("Namespace", installation.namespace);
    return { ...installation, namespace: parameter.valueAsString };
  }
}

/** The operational alarms and the dashboard of the installation (D71), `Mango-<ns>-ops-…`. */
export class OperationsStack extends CoreNestedStack {
  readonly alarms: OperationalAlarms;

  constructor(scope: Construct, id: string, props: OperationalAlarmsProps) {
    super(scope, id, "operational alarms");
    this.alarms = new OperationalAlarms(this, "OperationalAlarms", {
      ...props,
      installation: this.namespaceOf(props.installation),
    });
  }
}

export interface AuthorizationStackProps {
  /** The Verified Permissions store of the platform (L1): it stays in Core with its schema. */
  readonly policyStoreId: string;
}

/** The Cedar policies of the platform's policy store (L1). */
export class AuthorizationStack extends CoreNestedStack {
  readonly policies: avp.CfnPolicy[];

  constructor(scope: Construct, id: string, props: AuthorizationStackProps) {
    super(scope, id, "platform authorization policies");
    this.policies = platformPolicies(this, props.policyStoreId);
  }
}

export interface RemoteMcpStackProps {
  readonly installation: Installation;
  /** The task role of mango-api, in Core: the policy of its remote MCP domain is attached to it. */
  readonly apiTaskRole: iam.Role;
  readonly settingsTable: dynamodb.ITable;
  /** The signed remote profiles of the release, deployed by Core to its packs bucket. */
  readonly release: RemoteRelease;
}

/**
 * Remote MCP servers of third parties (D93, D98): the place of what the remote MCP build adds
 * to Core: what mango-api needs for the registrations (`Mango-<ns>-ApiRemoteMcp`) and the remote
 * provisioner (`Mango-<ns>-RemoteMcpProvisioner`, D98 (13)). A construct goes here by taking this stack as its scope,
 * `new RemoteMcpProvisioner(remoteMcp, "Provisioner", { … })`; the Core resources it names
 * (Gateway, policy engine, tables, keys) reach it as parameters.
 *
 * Kept in Core, because Core reads them and this stack reads Core: the Gateway's own pieces
 * (its RESPONSE interceptor, the key that signs the catalog of remote targets, which the Gateway
 * and its REQUEST interceptor read) and the deployment of the signed profiles to the packs
 * bucket, which shares Core's copy function with the packs. What mango-api reads from here is
 * made of names, never of this stack's outputs.
 */
export class RemoteMcpStack extends CoreNestedStack {
  /** The installation as this stack names it: what a construct of it takes (`namespaceOf`). */
  readonly installation: Installation;
  readonly api: RemoteMcpApi;

  constructor(scope: Construct, id: string, props: RemoteMcpStackProps) {
    super(scope, id, "remote MCP servers");
    this.installation = this.namespaceOf(props.installation);
    this.api = new RemoteMcpApi(this, "RemoteMcpApi", {
      namespace: this.installation.namespace,
      coreNamespace: props.installation.namespace,
      role: props.apiTaskRole,
      settingsTable: props.settingsTable,
      release: props.release,
    });
  }
}

/**
 * The reconciliation of Bedrock spend against the bill (D104 (6), (7)): the Glue table over the
 * export, the Athena workgroup `Mango-<ns>-cur`, the function `Mango-<ns>-CurReconciler`, its
 * schedule, its dead-letter queue and its alarms. Nothing here holds data: the export's bucket,
 * which does, stays in Core (`CurExportBucket`, D99 (2)) and reaches this stack as a parameter.
 * Its alarms are on the Operations dashboard by name (`CUR_RECONCILER_ALARMS`): this stack is a
 * leaf, and Operations reads none of it.
 */
export class CurReconciliationStack extends CoreNestedStack {
  readonly reconciler: CurReconciler;

  constructor(scope: Construct, id: string, props: CurReconcilerProps) {
    super(scope, id, "reconciliation against the bill");
    this.reconciler = new CurReconciler(this, "CurReconciler", {
      ...props,
      installation: this.namespaceOf(props.installation),
      catalogGovernedByLakeFormation: this.governedOf(props.catalogGovernedByLakeFormation),
    });
  }

  /** Core's `CatalogGovernedByLakeFormation`, passed to a parameter of the same name. */
  private governedOf(value: string): string {
    if (!Token.isUnresolved(value)) return value;
    const parameter = new CfnParameter(this, "CatalogGovernedByLakeFormation", {
      type: "String",
      allowedValues: ["false", "true"],
      description: "CatalogGovernedByLakeFormation of Core",
    });
    this.setParameter("CatalogGovernedByLakeFormation", value);
    return parameter.valueAsString;
  }
}

/**
 * The trace reader of the Observability view (D108 (b)): the function `Mango-<ns>-TraceReader`,
 * its role and mango-api's policy to invoke it (`Mango-<ns>-ApiObservability`). Nothing here holds
 * data. mango-api reads the function by its name, never by an output of this stack.
 */
export class ObservabilityStack extends CoreNestedStack {
  readonly reader: TraceReader;

  constructor(scope: Construct, id: string, props: TraceReaderProps) {
    super(scope, id, "observability traces");
    this.reader = new TraceReader(this, "TraceReader", {
      ...props,
      installation: this.namespaceOf(props.installation),
      coreNamespace: props.installation.namespace,
    });
  }
}

/**
 * The evaluator of the evals (D110): `Mango-<ns>-EvalJudge`, the custom evaluators of AgentCore
 * Evaluations, its alarms and the execution of the provisioner that keeps the evals harness.
 * Nothing here holds data: the Evals table and the key of the evals log groups stay in Core
 * (`Evals`, `EvalsCapture`), which name this stack's function and role by their fixed names. Its
 * alarms are on the Operations dashboard by name (`EVAL_JUDGE_ALARMS`).
 */
export class EvalsStack extends CoreNestedStack {
  readonly judge: EvalJudge;

  constructor(scope: Construct, id: string, props: EvalJudgeProps) {
    super(scope, id, "evals evaluator");
    this.judge = new EvalJudge(this, "EvalJudge", {
      ...props,
      installation: this.namespaceOf(props.installation),
    });
  }
}

/**
 * The turn worker (D121 (3)): the service `Mango-<ns>-turn-worker`, its task definition, its log
 * group, its security group and its task role `Mango-<ns>-TurnWorker` (decided 2026-11-07, by
 * menu, to keep Core under its budget of resources). Nothing here holds data: the queue of chat
 * turns, its dead-letter queue and its key stay in Core (`ChatTurnQueue`, D99 (2)), which names
 * the role by its fixed name, and the alarms of the worker are in Operations, by names.
 */
export class TurnWorkerStack extends CoreNestedStack {
  readonly worker: TurnWorker;

  constructor(scope: Construct, id: string, props: TurnWorkerProps) {
    super(scope, id, "turn worker");
    this.worker = new TurnWorker(this, "TurnWorker", {
      ...props,
      installation: this.namespaceOf(props.installation),
    });
  }
}
