import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as transfer from 'aws-cdk-lib/aws-transfer';
import { acknowledge } from '../nag';
import { Construct } from 'constructs';
import { A2X_FEED, EnvironmentConfig, JSE_FEEDS, SCHEDULE_GROUPS } from '../../config';
import { createDeadLetterQueue, FeedSchedule } from '../constructs/feed-schedule';
import { RetrieveFileStateMachine } from '../constructs/retrieve-file-state-machine';
import { TypeScriptFunction } from '../constructs/typescript-function';

export interface OrchestrationStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly bucket: s3.IBucket;
  readonly jseConnector: transfer.CfnConnector;
  readonly a2xConnector: transfer.CfnConnector;
}

/**
 * Retrieval state machines, the A2X date Lambda and the EventBridge Scheduler groups/schedules.
 * See docs/architecture/component-specs.md §4–6.
 */
export class OrchestrationStack extends Stack {
  /** Every state machine, keyed by name, for monitoring. */
  public readonly stateMachines: Record<string, sfn.StateMachine> = {};
  public readonly dateFunction: lambda.IFunction;
  public readonly deadLetterQueues: sqs.IQueue[];

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);
    const { config, bucket } = props;
    const localDir = (prefix: string) => `/${bucket.bucketName}/${prefix.replace(/\/$/, '')}`;

    // ---------- JSE IDP ----------
    const jseGroup = new scheduler.ScheduleGroup(this, 'JseScheduleGroup', { scheduleGroupName: SCHEDULE_GROUPS.jse });
    const jseDlq = createDeadLetterQueue(this, 'JseScheduleDlq', `${SCHEDULE_GROUPS.jse}-dlq`);

    for (const feed of JSE_FEEDS) {
      const feedConfig = config.jse.feeds[feed.id];
      const retrieve = new RetrieveFileStateMachine(this, `Retrieve-${feed.id}`, {
        stateMachineName: feed.stateMachineName,
        connector: props.jseConnector,
        localDirectoryPath: localDir(`${feed.prefix}temp/`),
        fileNotFoundFailureCode: config.jse.fileNotFoundFailureCode,
        logRetention: config.logRetention,
      });
      this.stateMachines[feed.stateMachineName] = retrieve.stateMachine;

      new FeedSchedule(this, `Schedule-${feed.id}`, {
        scheduleName: feed.scheduleName,
        scheduleGroup: jseGroup,
        stateMachine: retrieve.stateMachine,
        cron: feedConfig.schedule,
        input: { remoteFilePaths: [feedConfig.remotePath] },
        enabled: feedConfig.enabled,
        deadLetterQueue: jseDlq,
      });
    }

    // ---------- A2X ----------
    this.dateFunction = new TypeScriptFunction(this, 'EquitiesDate', {
      functionName: A2X_FEED.dateFunctionName,
      sourceDir: 'equities-date',
      logRetention: config.logRetention,
    });

    const a2xTransfer = new RetrieveFileStateMachine(this, 'Retrieve-a2x', {
      stateMachineName: A2X_FEED.transferStateMachineName,
      connector: props.a2xConnector,
      localDirectoryPath: localDir(A2X_FEED.prefix),
      fileNotFoundFailureCode: config.a2x.fileNotFoundFailureCode,
      logRetention: config.logRetention,
    });
    this.stateMachines[A2X_FEED.transferStateMachineName] = a2xTransfer.stateMachine;

    const determineDate = new tasks.LambdaInvoke(this, 'DetermineDate', {
      lambdaFunction: this.dateFunction,
      payloadResponseOnly: true,
      resultPath: '$.date',
    });

    const transferA2xFile = new tasks.StepFunctionsStartExecution(this, 'TransferA2xFile', {
      stateMachine: a2xTransfer.stateMachine,
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      associateWithParent: true,
      input: sfn.TaskInput.fromObject({
        remoteFilePaths: sfn.JsonPath.array(
          sfn.JsonPath.format(config.a2x.remotePathTemplate, sfn.JsonPath.stringAt('$.date.businessDate')),
        ),
      }),
    });

    const a2xOuter = new sfn.StateMachine(this, 'A2xOuter', {
      stateMachineName: A2X_FEED.outerStateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(determineDate.next(transferA2xFile)),
      timeout: Duration.minutes(20),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'A2xOuterLogs', {
          logGroupName: `/aws/vendedlogs/states/${A2X_FEED.outerStateMachineName}`,
          retention: config.logRetention,
        }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
    this.stateMachines[A2X_FEED.outerStateMachineName] = a2xOuter;
    acknowledge(a2xOuter, [
      { id: 'AwsSolutions-SF1', reason: 'ERROR-level logging without execution data is deliberate.' },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'startExecution.sync needs events:PutTargets/DescribeRule on the managed rule and execution ARNs.',
      },
    ]);

    const a2xGroup = new scheduler.ScheduleGroup(this, 'A2xScheduleGroup', { scheduleGroupName: SCHEDULE_GROUPS.a2x });
    const a2xDlq = createDeadLetterQueue(this, 'A2xScheduleDlq', `${SCHEDULE_GROUPS.a2x}-dlq`);
    new FeedSchedule(this, 'Schedule-a2x', {
      scheduleName: A2X_FEED.scheduleName,
      scheduleGroup: a2xGroup,
      stateMachine: a2xOuter,
      cron: config.a2x.schedule,
      input: {},
      enabled: config.a2x.enabled,
      deadLetterQueue: a2xDlq,
    });

    this.deadLetterQueues = [jseDlq, a2xDlq];
    for (const dlq of this.deadLetterQueues) {
      acknowledge(dlq, [{ id: 'AwsSolutions-SQS3', reason: 'This queue is itself a dead-letter queue.' }]);
    }
  }
}
