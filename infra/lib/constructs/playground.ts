import * as iam from "aws-cdk-lib/aws-iam";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct, IDependable } from "constructs";

/**
 * Partition of the Settings table that says which harness the Playground invokes (D91,
 * `mango_core.playground`). Only the provisioner writes it; mango-api is denied.
 */
export const PLAYGROUND_PARTITION = "PLAYGROUND";

export interface PlaygroundHarnessProps {
  /** The agent provisioner: the same state machine keeps the test harness. */
  readonly stateMachine: sfn.IStateMachine;
  /** What must be deployed before an execution starts (the provisioner function). */
  readonly provisioner: IDependable;
  /** Label of the release being deployed: a new one starts a new execution. */
  readonly release: string;
}

/**
 * The Playground's shared test harness (D91): `Mango_<ns>_a_playground`, with its role under
 * the agent boundary. Like the agents, it is created by SDK by the provisioner, never by this
 * stack (D25). Every deployment of a release asks the provisioner to bring it up to date with
 * `{"playground": "ensure", "release": <label>}`; mango-api asks again when the enabled
 * models change. The input carries no configuration: the provisioner's code and the model
 * catalog decide it.
 */
export class PlaygroundHarness extends Construct {
  constructor(scope: Construct, id: string, props: PlaygroundHarnessProps) {
    super(scope, id);
    const startCall: cr.AwsSdkCall = {
      service: "SFN",
      action: "startExecution",
      parameters: {
        stateMachineArn: props.stateMachine.stateMachineArn,
        input: JSON.stringify({ playground: "ensure", release: props.release }),
      },
      physicalResourceId: cr.PhysicalResourceId.of("playground-harness"),
    };
    const start = new cr.AwsCustomResource(this, "Ensure", {
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
    start.node.addDependency(props.stateMachine, props.provisioner);
  }
}
