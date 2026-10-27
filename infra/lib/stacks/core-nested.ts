import { CfnParameter, NestedStack, Token } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as avp from "aws-cdk-lib/aws-verifiedpermissions";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { platformPolicies } from "../constructs/governance.js";
import { OperationalAlarms, OperationalAlarmsProps } from "../constructs/operational-alarms.js";
import { RemoteMcpApi } from "../constructs/remote-mcp-api.js";
import { RemoteRelease } from "../constructs/remote-release.js";

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
 * to Core. It starts with what mango-api needs for the registrations (`Mango-<ns>-ApiRemoteMcp`);
 * the remote provisioner comes next. A construct goes here by taking this stack as its scope,
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
  readonly api: RemoteMcpApi;

  constructor(scope: Construct, id: string, props: RemoteMcpStackProps) {
    super(scope, id, "remote MCP servers");
    this.api = new RemoteMcpApi(this, "RemoteMcpApi", {
      namespace: this.namespaceOf(props.installation).namespace,
      coreNamespace: props.installation.namespace,
      role: props.apiTaskRole,
      settingsTable: props.settingsTable,
      release: props.release,
    });
  }
}
