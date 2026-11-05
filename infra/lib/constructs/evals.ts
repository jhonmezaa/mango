import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";

export interface EvalsProps {
  readonly installation: Installation;
  /** Key of the installation's tables. */
  readonly dataKey: kms.IKey;
}

/**
 * Evals (D110, D111; threat model `evals-threat-model.md`).
 *
 * Table `Mango-<ns>-Evals`: the suites, their cases (content, D26: kept with their suite and
 * deleted with it), the runs and their result per case (verdicts and fixed reason codes, never
 * an answer of the agent), and the requests to stop requiring a suite (two people). It holds
 * data, so it lives in Core (D99 (2)): retained, with PITR and deletion protection. Only
 * mango-api reads and writes it.
 */
export class Evals extends Construct {
  readonly table: dynamodb.TableV2;
  /** Environment mango-api needs. */
  readonly apiEnvironment: Record<string, string>;
  private readonly namespace: string;
  private readonly dataKey: kms.IKey;

  constructor(scope: Construct, id: string, props: EvalsProps) {
    super(scope, id);
    const cfg = props.installation;
    this.namespace = cfg.namespace;
    this.dataKey = props.dataKey;
    // Its id names its throttling alarm (D71).
    this.table = new dynamodb.TableV2(this, "Evals", {
      tableName: mangoName(cfg.namespace, "Evals"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // Runs (180 days) and closed requests (90 days); suites and their cases never.
      timeToLiveAttribute: "ttl",
    });
    this.apiEnvironment = { EVALS_TABLE: this.table.tableName };
  }

  /** mango-api: the suites, cases, runs and requests (only it writes the table). */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiEvals"),
      description: "mango-api: eval suites, cases, runs and requests (D110, D111)",
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "EvalsTable",
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:ConditionCheckItem",
          ],
          resources: [this.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "EvalsTableKey",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [this.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
      ],
    });
  }
}
