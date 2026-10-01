import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { acknowledge } from '../nag';
import { Construct } from 'constructs';

export interface TransferConnectorReference {
  readonly connectorId: string;
  readonly connectorArn: string;
}

export interface RetrieveFileStateMachineProps {
  readonly stateMachineName: string;
  readonly connector: TransferConnectorReference;
  /** "/<bucket>/<prefix>" with no trailing slash. */
  readonly localDirectoryPath: string;
  /** Transfer Family FailureCode that means the remote file does not exist yet. */
  readonly fileNotFoundFailureCode: string;
  readonly logRetention: logs.RetentionDays;
  /** @default 30 seconds */
  readonly pollInterval?: Duration;
  /** @default 15 minutes */
  readonly timeout?: Duration;
}

/**
 * Retrieves one remote file through a Transfer Family SFTP connector and waits for the result.
 *
 * Input: `{ "remoteFilePaths": ["/remote/path/file.csv"] }`
 *
 * Outcomes: `Succeeded`, `FileNotAvailable` (success, the next schedule tick retries), or `TransferFailed`.
 * See docs/architecture/component-specs.md §4.
 */
export class RetrieveFileStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RetrieveFileStateMachineProps) {
    super(scope, id);
    const { connectorArn, connectorId } = props.connector;
    const sdkRetry: sfn.RetryProps = {
      errors: ['Transfer.ThrottlingException', 'Transfer.ServiceUnavailableException', 'Transfer.InternalServiceError'],
      interval: Duration.seconds(2),
      maxAttempts: 5,
      backoffRate: 2,
      jitterStrategy: sfn.JitterType.FULL,
    };

    const start = new tasks.CallAwsService(this, 'StartFileTransfer', {
      service: 'transfer',
      action: 'startFileTransfer',
      iamAction: 'transfer:StartFileTransfer',
      parameters: {
        ConnectorId: connectorId,
        RetrieveFilePaths: sfn.JsonPath.listAt('$.remoteFilePaths'),
        LocalDirectoryPath: props.localDirectoryPath,
      },
      iamResources: [connectorArn],
      resultSelector: { 'TransferId.$': '$.TransferId' },
      resultPath: '$.transfer',
    }).addRetry(sdkRetry);

    const wait = new sfn.Wait(this, 'WaitForTransfer', {
      time: sfn.WaitTime.duration(props.pollInterval ?? Duration.seconds(30)),
    });

    const poll = new tasks.CallAwsService(this, 'ListFileTransferResults', {
      service: 'transfer',
      action: 'listFileTransferResults',
      iamAction: 'transfer:ListFileTransferResults',
      parameters: {
        ConnectorId: connectorId,
        TransferId: sfn.JsonPath.stringAt('$.transfer.TransferId'),
      },
      iamResources: [connectorArn],
      resultSelector: { 'Results.$': '$.FileTransferResults' },
      resultPath: '$.poll',
    }).addRetry(sdkRetry);

    const status = '$.poll.Results[0].StatusCode';
    const failureCode = '$.poll.Results[0].FailureCode';

    const evaluate = new sfn.Choice(this, 'EvaluateResult')
      .when(sfn.Condition.not(sfn.Condition.isPresent(status)), wait)
      .when(sfn.Condition.stringEquals(status, 'COMPLETED'), new sfn.Succeed(this, 'Succeeded'))
      .when(
        sfn.Condition.and(
          sfn.Condition.stringEquals(status, 'FAILED'),
          sfn.Condition.isPresent(failureCode),
          sfn.Condition.stringEquals(failureCode, props.fileNotFoundFailureCode),
        ),
        new sfn.Succeed(this, 'FileNotAvailable', {
          comment: 'Remote file not published yet; the next schedule tick retries.',
        }),
      )
      .when(
        sfn.Condition.stringEquals(status, 'FAILED'),
        new sfn.Fail(this, 'TransferFailed', {
          error: 'TransferFailed',
          // FilePath, StatusCode, FailureCode and FailureMessage of the failed file.
          causePath: sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$.poll.Results[0]')),
        }),
      )
      .otherwise(wait);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/aws/vendedlogs/states/${props.stateMachineName}`,
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: props.stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(start.next(wait).next(poll).next(evaluate)),
      timeout: props.timeout ?? Duration.minutes(15),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });

    acknowledge(this.stateMachine, [
      {
        id: 'AwsSolutions-SF1',
        reason:
          'ERROR-level logging without execution data is deliberate (cost, and no payloads in logs); execution history covers the rest.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'X-Ray and CloudWatch Logs delivery actions do not support resource scoping.',
      },
    ]);
  }
}
