import { Aws, Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { acknowledge } from "../nag.js";
import {
  assertNotTheMangoAccount,
  mangoAccountIdParameter,
  namespaceParameter,
  organizationIdParameter,
  tagNamespace,
} from "../params.js";
import { noBootstrapSynthesizer } from "./member-stack.js";
import {
  OPERATE_SESSION_TAG_KEYS,
  roleArn,
  roleNames,
  SESSION_TAG_KEYS,
  writeResourcePrefix,
} from "../names.js";

/**
 * Cost Explorer reads of the payer account. The organization's cost data is not a resource
 * with an ARN: these actions only work on `*` (documented exception).
 */
const COST_EXPLORER_ACTIONS = [
  "ce:GetCostAndUsage",
  "ce:GetCostForecast",
  "ce:GetAnomalies",
  "ce:GetSavingsPlansCoverage",
  "ce:GetSavingsPlansUtilization",
  "ce:GetSavingsPlansPurchaseRecommendation",
  // Since C3b (2026-10-01): the rest of what the Billing pack's Cost Explorer tools read.
  "ce:GetDimensionValues",
  "ce:GetTags",
  "ce:GetCostCategories",
  "ce:GetUsageForecast",
  "ce:GetCostAndUsageWithResources",
  "ce:GetSavingsPlansUtilizationDetails",
  "ce:GetReservationCoverage",
  "ce:GetReservationUtilization",
  "ce:GetCostAndUsageComparisons",
  "ce:GetCostComparisonDrivers",
];

/**
 * Recommendations of Compute Optimizer and Cost Optimization Hub. Neither service defines
 * resource types, so these only work on `*`. Reading them needs the service enrolled in the
 * payer account; Mango never enrolls it (the `Update*` actions are not here).
 */
const OPTIMIZATION_ACTIONS = [
  "compute-optimizer:GetEnrollmentStatus",
  "compute-optimizer:GetEC2InstanceRecommendations",
  "compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetEBSVolumeRecommendations",
  "compute-optimizer:GetLambdaFunctionRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations",
  "compute-optimizer:GetECSServiceRecommendations",
  "compute-optimizer:GetIdleRecommendations",
  "cost-optimization-hub:ListRecommendations",
  "cost-optimization-hub:GetRecommendation",
  "cost-optimization-hub:ListRecommendationSummaries",
  "cost-optimization-hub:ListEfficiencyMetrics",
];

/**
 * What Compute Optimizer asks for besides its own action: to return the recommendations of a
 * kind of resource, it also authorizes the caller against the action that lists that kind of
 * resource in the service that owns it (IAM service reference, `AuthorizedActions` of each
 * `Get*Recommendations`). They list resources of the payer account and their configuration
 * (inventory); none reads the content of data. `*` because they list every resource of a
 * kind: the same reach an account-wide ARN pattern would have. User decision of 2026-10-01.
 *
 * `lambda:ListFunctions` is left out on purpose (same decision): it returns the environment
 * variables of every function of the payer account, where secrets sometimes live. Without
 * it, the Lambda recommendations of Compute Optimizer may answer AccessDenied (TM-BL11).
 */
const COMPUTE_OPTIMIZER_INVENTORY_ACTIONS = [
  "ec2:DescribeInstances",
  "ec2:DescribeVolumes",
  "autoscaling:DescribeAutoScalingGroups",
  "lambda:ListProvisionedConcurrencyConfigs",
  "rds:DescribeDBInstances",
  "rds:DescribeDBClusters",
  "ecs:ListClusters",
  "ecs:ListServices",
];

/** Budgets of the payer account and their alert thresholds. Scoped to its own budgets. */
const BUDGETS_ACTIONS = ["budgets:ViewBudget"];

/**
 * Data actions of `Mango-<ns>-BillingReader`: exact names, all read-only (none creates,
 * changes or starts anything). Billing data, plus the inventory listing Compute Optimizer
 * needs. It is also the ceiling of what an MCP pack over account data may ask for in its
 * manifest (D37): a session assumed through the Billing broker can never do more than this
 * role. The Cost Explorer connector and the admin probe use the same role, each with its
 * own session policy (docs/security/threat-models/aws-billing-pack-threat-model.md,
 * TM-BL11).
 */
export const BILLING_READER_DATA_ACTIONS = [
  ...COST_EXPLORER_ACTIONS,
  ...OPTIMIZATION_ACTIONS,
  ...COMPUTE_OPTIMIZER_INVENTORY_ACTIONS,
  ...BUDGETS_ACTIONS,
];

/** What the roles of the payer account are built from: the stack parameters (D58). */
interface PayerSettings {
  readonly namespace: string;
  readonly mangoAccountId: string;
  readonly organizationId: string;
  /** The account this stack is deployed in. */
  readonly managementAccountId: string;
}

/**
 * What `Mango-<ns>-BudgetsOperator` may do: the IAM action of `CreateBudget`. It also covers
 * updating and deleting a budget (IAM has no finer action), which is why the role is scoped to
 * budgets named with the installation prefix and each call to the one budget it creates.
 */
export const BUDGETS_OPERATOR_ACTIONS = ["budgets:ModifyBudget"];

/**
 * `Mango-<ns>-Payer`, deployed in the organization management (payer) account.
 *
 * - `Mango-<ns>-BillingReader`: read-only billing and organization metadata, assumable
 *   exclusively by the Billing broker in the Mango account (D10, TM-C4).
 * - `Mango-<ns>-BudgetsOperator`: the write role of the first write tool (D27). It can only
 *   touch budgets named `Mango-<ns>-*`, and only the operate broker of the Mango account may
 *   assume it, which in turn only the approval executor can use, for one approved call.
 */
export class PayerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    // No assets: the management account needs no CDK bootstrap.
    super(scope, id, { ...props, synthesizer: noBootstrapSynthesizer() });
    const cfg: PayerSettings = {
      namespace: namespaceParameter(this),
      mangoAccountId: mangoAccountIdParameter(this),
      organizationId: organizationIdParameter(this),
      managementAccountId: Aws.ACCOUNT_ID,
    };
    assertNotTheMangoAccount(this, cfg.mangoAccountId);
    tagNamespace(this, cfg.namespace);
    const brokerArn = roleArn(cfg.mangoAccountId, roleNames.billingBroker(cfg.namespace));

    const reader = new iam.Role(this, "BillingReader", {
      roleName: roleNames.billingReader(cfg.namespace),
      description: "Mango read-only access to billing and organization metadata",
      // Trust the Mango account, restricted by condition to the broker role. The condition
      // (not a principal ARN) keeps this stack independent of deployment order.
      // SourceIdentity is mandatory on AssumeRole (AGENTS.md, review ADM-04).
      assumedBy: new iam.AccountPrincipal(cfg.mangoAccountId).withConditions({
        ArnEquals: { "aws:PrincipalArn": brokerArn },
        StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
        Null: { "sts:SourceIdentity": "false" },
      }),
    });
    // Callers must set SourceIdentity and may pass session tags.
    reader.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [new iam.AccountPrincipal(cfg.mangoAccountId)],
        conditions: {
          ArnEquals: { "aws:PrincipalArn": brokerArn },
          StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
          StringLike: { "sts:SourceIdentity": "*" },
        },
      }),
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [new iam.AccountPrincipal(cfg.mangoAccountId)],
        conditions: {
          ArnEquals: { "aws:PrincipalArn": brokerArn },
          StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
          "ForAllValues:StringEquals": { "aws:TagKeys": SESSION_TAG_KEYS },
        },
      }),
    );

    reader.addToPolicy(
      new iam.PolicyStatement({
        sid: "CostExplorerRead",
        actions: COST_EXPLORER_ACTIONS,
        resources: ["*"],
      }),
    );
    reader.addToPolicy(
      new iam.PolicyStatement({
        sid: "OptimizationRead",
        actions: OPTIMIZATION_ACTIONS,
        resources: ["*"],
      }),
    );
    reader.addToPolicy(
      new iam.PolicyStatement({
        sid: "ComputeOptimizerInventoryRead",
        actions: COMPUTE_OPTIMIZER_INVENTORY_ACTIONS,
        resources: ["*"],
      }),
    );
    const budgets = `arn:aws:budgets::${cfg.managementAccountId}:budget/*`;
    reader.addToPolicy(
      new iam.PolicyStatement({ sid: "BudgetsRead", actions: BUDGETS_ACTIONS, resources: [budgets] }),
    );
    reader.addToPolicy(
      new iam.PolicyStatement({
        sid: "OrganizationInventoryRead",
        actions: [
          "organizations:ListRoots",
          "organizations:ListChildren",
          "organizations:ListAccounts",
          "organizations:ListOrganizationalUnitsForParent",
        ],
        resources: ["*"],
      }),
    );
    this.budgetsOperator(cfg);
    acknowledge(
      reader,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "Cost Explorer, Compute Optimizer, Cost Optimization Hub and Organizations list APIs " +
          "do not support resource-level permissions, and the inventory actions Compute " +
          "Optimizer depends on list every resource of a kind; actions are an explicit " +
          "read-only list.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${budgets}]`,
        reason: "Every budget of the payer account, read-only: budget names are not known in advance.",
      },
    );
  }
  /** Write role of the first write tool: budgets named with the installation prefix (D27). */
  private budgetsOperator(cfg: PayerSettings): void {
    const brokerArn = roleArn(cfg.mangoAccountId, roleNames.operateBroker(cfg.namespace));
    const fromTheBroker = {
      ArnEquals: { "aws:PrincipalArn": brokerArn },
      StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
    };
    const operator = new iam.Role(this, "BudgetsOperator", {
      roleName: roleNames.budgetsOperator(cfg.namespace),
      description: "Mango creates budgets named with its prefix, only for an approved tool call",
      // Same trust as the reader: the Mango account, restricted by condition to its broker,
      // inside the organization, and never without a SourceIdentity (the person who asked).
      assumedBy: new iam.AccountPrincipal(cfg.mangoAccountId).withConditions({
        ...fromTheBroker,
        Null: { "sts:SourceIdentity": "false" },
      }),
    });
    operator.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [new iam.AccountPrincipal(cfg.mangoAccountId)],
        conditions: { ...fromTheBroker, StringLike: { "sts:SourceIdentity": "*" } },
      }),
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [new iam.AccountPrincipal(cfg.mangoAccountId)],
        conditions: {
          ArnEquals: fromTheBroker.ArnEquals,
          StringEquals: fromTheBroker.StringEquals,
          "ForAllValues:StringEquals": { "aws:TagKeys": OPERATE_SESSION_TAG_KEYS },
        },
      }),
    );
    const ownBudgets = `arn:aws:budgets::${cfg.managementAccountId}:budget/${writeResourcePrefix(cfg.namespace)}*`;
    operator.addToPolicy(
      new iam.PolicyStatement({ sid: "OwnBudgets", actions: BUDGETS_OPERATOR_ACTIONS, resources: [ownBudgets] }),
    );
    acknowledge(operator, {
      id: `AwsSolutions-IAM5[Resource::${ownBudgets}]`,
      reason:
        "Budgets are created at runtime by an approved tool call: the installation name prefix is the scope " +
        "(user decision of 2026-10-02), and the session policy of each call names the one budget it creates.",
    });
  }
}
