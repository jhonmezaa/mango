import { RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";

/** Index names of the Tickets table; keep in sync with `mango_core.tickets`. */
export const TICKETS_BY_UPDATED = "ByUpdated";
export const TICKETS_BY_CREATOR = "ByCreator";
export const TICKETS_BY_ASSIGNEE = "ByAssignee";
const INDEX_KEYS: Record<string, string> = {
  [TICKETS_BY_UPDATED]: "all_pk",
  [TICKETS_BY_CREATOR]: "creator_id",
  [TICKETS_BY_ASSIGNEE]: "assignee_id",
};

export interface TicketsProps {
  readonly installation: Installation;
  /** Key of the installation's tables. */
  readonly dataKey: kms.IKey;
}

/**
 * Tickets of Mango (D112; threat model `tickets-threat-model.md`).
 *
 * Table `Mango-<ns>-Tickets`: tickets, their comments and their history, with production data:
 * the installation's key, PITR, deletion protection and `RETAIN`, like every table with data.
 * No TTL: a ticket and what was said on it stay. Two resources in Core (the table and the
 * policy of mango-api); its indexes are part of the table.
 */
export class Tickets extends Construct {
  readonly table: dynamodb.TableV2;
  /** Environment mango-api needs. */
  readonly apiEnvironment: Record<string, string>;
  private readonly namespace: string;
  private readonly dataKey: kms.IKey;

  constructor(scope: Construct, id: string, props: TicketsProps) {
    super(scope, id);
    const cfg = props.installation;
    this.namespace = cfg.namespace;
    this.dataKey = props.dataKey;

    // Its id names its throttling alarm, as for every table: `ops-Table-Tickets-throttled` (D71, D99).
    this.table = new dynamodb.TableV2(this, "Tickets", {
      tableName: mangoName(cfg.namespace, "Tickets"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      globalSecondaryIndexes: Object.entries(INDEX_KEYS).map(([indexName, key]) => ({
        indexName,
        partitionKey: { name: key, type: dynamodb.AttributeType.STRING },
        sortKey: { name: "updated_at", type: dynamodb.AttributeType.STRING },
      })),
    });

    this.apiEnvironment = { TICKETS_TABLE: this.table.tableName };
  }

  /** The table's ARN and the ARNs of its indexes. */
  get resourceArns(): string[] {
    return [this.table.tableArn, ...Object.keys(INDEX_KEYS).map((index) => `${this.table.tableArn}/index/${index}`)];
  }

  /** mango-api: read and write tickets (no `Scan`, no `DeleteItem`: nothing deletes a ticket). */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    // A managed policy of its own: the inline policies of a role share one size limit, and the
    // task role of mango-api is close to it.
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiTickets"),
      description: "mango-api: tickets of Mango (D112)",
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "TicketsTable",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
          resources: this.resourceArns,
        }),
        new iam.PolicyStatement({
          sid: "TicketsTableKey",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [this.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
      ],
    });
  }
}
