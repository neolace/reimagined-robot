import * as path from 'path';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig, JSE_TEMP_KEY_WILDCARD } from '../../config';
import { createDeadLetterQueue } from '../constructs/feed-schedule';
import { pythonCode } from '../constructs/python-code';
import { LAMBDA_SRC_DIR } from '../constructs/typescript-function';
import { acknowledge } from '../nag';

export interface ProcessingStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly bucket: s3.IBucket;
}

export const SHADOW_RENAME_FUNCTION_NAME = 'gm-prime-equities-shadow-rename';

/**
 * Shadow-Rename (Python): promotes changed files out of the JSE temp/ folders and discards duplicates.
 * See docs/architecture/component-specs.md §7.
 */
export class ProcessingStack extends Stack {
  public readonly shadowRename: lambda.IFunction;
  public readonly deadLetterQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);
    const { config, bucket } = props;

    const runtime = lambda.Runtime.PYTHON_3_14;
    const fn = new lambda.Function(this, 'ShadowRename', {
      functionName: SHADOW_RENAME_FUNCTION_NAME,
      code: pythonCode(path.join(LAMBDA_SRC_DIR, 'shadow_rename'), runtime),
      handler: 'app.lambda_handler',
      runtime,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      // Serialises processing so two copies of the same file can never race.
      reservedConcurrentExecutions: 1,
      tracing: lambda.Tracing.ACTIVE,
      environment: { POWERTOOLS_SERVICE_NAME: 'shadow-rename', POWERTOOLS_LOG_LEVEL: 'INFO' },
      logGroup: new logs.LogGroup(this, 'ShadowRenameLogs', {
        logGroupName: `/aws/lambda/${SHADOW_RENAME_FUNCTION_NAME}`,
        retention: config.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    bucket.grantRead(fn, 'jse/idp/*');
    bucket.grantPut(fn, 'jse/idp/*');
    bucket.grantDelete(fn, JSE_TEMP_KEY_WILDCARD);
    this.shadowRename = fn;

    this.deadLetterQueue = createDeadLetterQueue(this, 'ShadowRenameDlq', `${SHADOW_RENAME_FUNCTION_NAME}-dlq`);

    new events.Rule(this, 'JseTempObjectCreated', {
      description: 'Invoke Shadow-Rename when a file lands in a JSE temp/ folder',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: events.Match.wildcard(JSE_TEMP_KEY_WILDCARD) },
        },
      },
      targets: [
        new eventsTargets.LambdaFunction(fn, {
          deadLetterQueue: this.deadLetterQueue,
          retryAttempts: 4,
          maxEventAge: Duration.hours(2),
        }),
      ],
    });

    acknowledge(fn, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is the standard minimal logging policy.' },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Object wildcards limited to jse/idp/*; KMS data-key and X-Ray actions require wildcards.',
      },
    ]);
    acknowledge(this.deadLetterQueue, [
      { id: 'AwsSolutions-SQS3', reason: 'This queue is itself a dead-letter queue.' },
    ]);
  }
}
