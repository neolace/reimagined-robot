import * as path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { acknowledge } from '../nag';
import { Construct } from 'constructs';

export const LAMBDA_SRC_DIR = path.join(__dirname, '../../../src/lambdas');

export interface TypeScriptFunctionProps {
  readonly functionName: string;
  /** Directory under src/lambdas containing index.ts. */
  readonly sourceDir: string;
  readonly logRetention: logs.RetentionDays;
  readonly memorySize?: number;
  readonly timeout?: Duration;
  readonly environment?: Record<string, string>;
}

/** Node.js (arm64, latest LTS runtime) Lambda bundled with esbuild, with Powertools-friendly defaults. */
export class TypeScriptFunction extends lambdaNodejs.NodejsFunction {
  constructor(scope: Construct, id: string, props: TypeScriptFunctionProps) {
    super(scope, id, {
      functionName: props.functionName,
      entry: path.join(LAMBDA_SRC_DIR, props.sourceDir, 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 128,
      timeout: props.timeout ?? Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      environment: { POWERTOOLS_SERVICE_NAME: props.functionName, POWERTOOLS_LOG_LEVEL: 'INFO', ...props.environment },
      logGroup: new logs.LogGroup(scope, `${id}Logs`, {
        logGroupName: `/aws/lambda/${props.functionName}`,
        retention: props.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true, target: 'node24' },
    });

    acknowledge(this, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is the standard minimal logging policy.' },
      { id: 'AwsSolutions-IAM5', reason: 'X-Ray tracing actions do not support resource scoping.' },
    ]);
  }
}
