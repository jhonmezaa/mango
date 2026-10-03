import { Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { packNames, roleArn, roleNames, SESSION_TAG_KEYS } from "../names.js";
import { acknowledge } from "../nag.js";

export interface MemberAccessProps {
  readonly installation: Installation;
  /** Read-only AdminProbe (D17): checks the chain to a member account for an administrator. */
  readonly adminProbe: lambda.Function;
  /**
   * Packs of the release that read the member accounts as the calling user (`central_only`,
   * `identity.chain: member`, D51): their roles, created later by the pack provisioner, may
   * use the broker.
   */
  readonly memberChainPacks: string[];
}

/**
 * Access to the member accounts (§4.10, D10): `Mango-<ns>-ReadBroker`, the only role of the
 * Mango account the spoke role of each member account (`Mango-<ns>-ReadOnly`, stack
 * `Mango-<ns>-Member`) trusts. It holds no data permission: it can only assume that role.
 * Adding or removing who may use it never touches the StackSet.
 */
export class MemberAccess extends Construct {
  /** Broker and the name of the role behind it in each member account. */
  readonly readBrokerArn: string;
  readonly memberRoleName: string;

  constructor(scope: Construct, id: string, props: MemberAccessProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const account = Stack.of(this).account;
    const principal = new iam.AccountPrincipal(account);
    this.memberRoleName = roleNames.memberReadOnly(ns);
    this.readBrokerArn = roleArn(account, roleNames.readBroker(ns));

    // Exactly these roles may use the broker (no wildcards): the AdminProbe and the role of
    // each pack of the release's member chain (D49, D51). A pack role does not exist until an
    // administrator enables the pack; it is named by its exact ARN, in a condition, so the
    // trust does not depend on it existing.
    const probeRole = props.adminProbe.role!;
    const packRoles = props.memberChainPacks.map((id) => roleArn(account, `${packNames.rolePrefix(ns)}${id}`));
    const fromCallers = {
      ArnEquals: { "aws:PrincipalArn": [probeRole.roleArn, ...packRoles] },
      StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
    };

    const broker = new iam.Role(this, "ReadBroker", {
      roleName: roleNames.readBroker(ns),
      description: "Broker to the ReadOnly role of the member accounts; only the roles its trust names may use it",
      // AssumeRole itself requires a SourceIdentity: every call through the broker is
      // attributable to a person, and the spoke demands it again.
      assumedBy: principal.withConditions({ ...fromCallers, Null: { "sts:SourceIdentity": "false" } }),
      maxSessionDuration: Duration.hours(1),
    });
    broker.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [principal],
        conditions: { ...fromCallers, StringLike: { "sts:SourceIdentity": "*" } },
      }),
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [principal],
        conditions: { ...fromCallers, "ForAllValues:StringEquals": { "aws:TagKeys": SESSION_TAG_KEYS } },
      }),
    );

    // The spoke role exists in accounts this stack cannot know (they join and leave the
    // target OUs), so the account is a wildcard: the role name and the organization are the
    // scope. A role of that name outside the organization cannot be assumed.
    const memberRoles = `arn:aws:iam::*:role/${this.memberRoleName}`;
    broker.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeMemberReadOnly",
        actions: ["sts:AssumeRole"],
        resources: [memberRoles],
        conditions: { StringEquals: { "aws:ResourceOrgID": cfg.organizationId } },
      }),
    );
    broker.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassIdentityToMemberReadOnly",
        actions: ["sts:SetSourceIdentity", "sts:TagSession"],
        resources: [memberRoles],
      }),
    );

    acknowledge(broker, {
      id: `AwsSolutions-IAM5[Resource::${memberRoles}]`,
      reason:
        "Member accounts join and leave the StackSet targets without a Core deployment (§4.10): the account " +
        "is a wildcard, the exact role name and aws:ResourceOrgID are the scope. Agreed on 2026-10-01.",
    });

    props.adminProbe.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AssumeReadBroker",
        actions: ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
        resources: [this.readBrokerArn],
      }),
    );
    props.adminProbe.addEnvironment("READ_BROKER_ROLE_ARN", this.readBrokerArn);
    props.adminProbe.addEnvironment("MEMBER_READ_ROLE_NAME", this.memberRoleName);
  }
}
