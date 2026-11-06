import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { agentNames, mangoName, roleNames } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { PythonFunction } from "./python-function.js";
import { SPANS_LOG_GROUP } from "./budget-reconciler.js";

/** Log groups of the AgentCore runtimes, before the runtime's name. */
export const RUNTIME_LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/";

/** The evals harness (`Mango_<ns>_a_evals`, D110 (3)): the only one with content. */
export const EVALS_ID = "evals";

/** Most of what mango-api waits for one reading: above the function's own budget (20 s). */
export const TRACE_READER_TIMEOUT_SECONDS = 30;

export interface TraceReaderProps {
  readonly installation: Installation;
  /**
   * The namespace as Core names it, for what Core's resources read (mango-api's environment),
   * when this construct lives in a stack nested in Core with a namespace parameter of its own.
   */
  readonly coreNamespace?: string;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** The task role of mango-api, the only caller. */
  readonly apiTaskRole: iam.IRole;
}

/**
 * The trace reader of the Observability view (D108 (b); threat model
 * `observability-threat-model.md`): a function mango-api invokes synchronously, which reads the
 * metadata of the spans of the installation's harnesses from the two places AgentCore may write
 * them: `aws/spans` (Transaction Search, D16) and the `spans` stream of each runtime's log group
 * (unified telemetry). It writes nothing and returns metadata only.
 *
 * Its role may filter those log groups and list the runtimes' log groups, and nothing else. Only
 * mango-api's role may invoke it, from a managed policy of its own (`Mango-<ns>-ApiObservability`):
 * the inline policy of that role is full. Synchronous, so no dead-letter queue (CKV_AWS_116).
 */
export class TraceReader extends Construct {
  readonly function: lambda.Function;
  /** What mango-api reads: the function's name, as Core names it. */
  readonly apiEnvironment: Record<string, string>;

  constructor(scope: Construct, id: string, props: TraceReaderProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    const stack = Stack.of(this);
    const logGroups = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:`;
    // IAM names a log group with the `:*` suffix for every action but tagging.
    const spans = `${logGroups}${SPANS_LOG_GROUP}:*`;
    const spansGroup = `${logGroups}${SPANS_LOG_GROUP}`;
    const runtimes = `${logGroups}${RUNTIME_LOG_GROUP_PREFIX}${agentNames.runtimePrefix(ns)}*`;
    const evals = `${logGroups}${RUNTIME_LOG_GROUP_PREFIX}${agentNames.runtimePrefix(ns)}${EVALS_ID}-*`;
    const name = roleNames.traceReader(ns);

    const role = new iam.Role(this, "Role", {
      roleName: name,
      description: "Observability: reads the metadata of the AgentCore spans of the installation's harnesses",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentSpans",
        // `aws/spans` holds the spans of the whole account: IAM cannot narrow it to Mango's. The
        // function filters by the installation's harnesses and keeps a closed list of fields.
        // The runtimes' log groups are only the installation's harnesses'. Logs Insights reads
        // first (`QueryAgentSpans`); `FilterLogEvents` only if it fails (D113).
        actions: ["logs:FilterLogEvents"],
        resources: [spans, runtimes],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "QueryAgentSpans",
        // Logs Insights over the same log groups (D113). `aws/spans` named both with and without
        // `:*`: the ARN `StartQuery` is checked against is not checked in an installation yet,
        // and both name that one log group. The runtimes' prefix already ends in `*`.
        actions: ["logs:StartQuery"],
        resources: [spansGroup, spans, runtimes],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOwnQueries",
        // `GetQueryResults` and `StopQuery` take no resource (Service Authorization Reference):
        // they name a query by its id. The function only asks for the ids `StartQuery` gave it
        // in the same reading, and it may not list queries (`DescribeQueries`), so it cannot
        // learn the id of another's query (D113, TM-OB8).
        actions: ["logs:GetQueryResults", "logs:StopQuery"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "NeverTheEvalsHarness",
        // The evals harness is the only one that captures content (D110 (3)): only the
        // evaluator's role reads it. The function also skips it; this makes it a rule.
        effect: iam.Effect.DENY,
        actions: ["logs:*"],
        resources: [evals],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "FindRuntimeLogGroups",
        // Names only. DescribeLogGroups has no resource scope.
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-trace-reader",
      packagePath: "functions/trace-reader",
      // A fixed name: a log group retained by a rolled-back create would make the retry fail
      // ("already exists"). RetainExceptOnCreate deletes it only then; otherwise it is retained (D58 (27)).
      logsRemovalPolicy: props.installation.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
      handler: "mango_trace_reader.handler.lambda_handler",
      functionName: name,
      description: "Reads the metadata of the AgentCore spans of the installation for the Observability view",
      role,
      timeout: Duration.seconds(TRACE_READER_TIMEOUT_SECONDS - 5),
      memorySize: 512,
      environment: { MANGO_NAMESPACE: ns },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          `${REASONS.xray} logs:DescribeLogGroups, logs:GetQueryResults and logs:StopQuery have no resource scope; ` +
          "the function only reads the queries it started itself and cannot list others' (D113, TM-OB8).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${spans}]`,
        reason:
          "Not a wildcard over resources: `:*` is how IAM names one log group for logs:FilterLogEvents and logs:StartQuery. " +
          "Read-only, on the single log group Transaction Search writes the spans to (D108).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${runtimes}]`,
        reason:
          "Read-only, on the log groups of the runtimes of this installation's harnesses (`harness_Mango_<ns>_a_*`): " +
          "their names end in an id AgentCore assigns (D108).",
      },
    );

    // mango-api: invoke the function by its ARN, built from names (this stack is a leaf of Core).
    const coreNs = props.coreNamespace ?? ns;
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(ns, "ApiObservability"),
      description: "mango-api: the traces of the Observability view (D108)",
      roles: [props.apiTaskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "ReadTraces",
          actions: ["lambda:InvokeFunction"],
          resources: [this.function.functionArn],
        }),
      ],
    });
    this.apiEnvironment = { TRACE_READER_FUNCTION: roleNames.traceReader(coreNs) };
  }
}
