import { Match } from 'aws-cdk-lib/assertions';
import { buildStage, json, resourcesOf } from './helpers';

describe('ProcessingStack', () => {
  const { processing } = buildStage().templates;

  test('Shadow-Rename is Python on arm64 with reserved concurrency 1', () => {
    processing.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Shadow-Rename',
      Runtime: 'python3.14',
      Handler: 'app.lambda_handler',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 1,
      TracingConfig: { Mode: 'Active' },
    });
  });

  test('rule matches Object Created in any JSE temp/ folder of the bucket', () => {
    processing.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
        detail: {
          bucket: { name: [Match.anyValue()] },
          object: { key: [{ wildcard: 'jse/idp/*/temp/*' }] },
        },
      },
      Targets: [
        Match.objectLike({
          DeadLetterConfig: { Arn: Match.anyValue() },
          RetryPolicy: { MaximumEventAgeInSeconds: 7200, MaximumRetryAttempts: 4 },
        }),
      ],
    });
  });

  test('can delete only inside temp/ folders', () => {
    const policy = resourcesOf(processing, 'AWS::IAM::Policy')
      .map(([, p]) => json(p.Properties))
      .find((p) => p.includes('s3:DeleteObject'));
    expect(policy).toBeDefined();
    const statements = JSON.parse(policy!).PolicyDocument.Statement as {
      Action: string | string[];
      Resource: unknown;
    }[];
    const deletes = statements.filter((s) => [s.Action].flat().some((a) => a.startsWith('s3:DeleteObject')));
    expect(deletes).toHaveLength(1);
    expect(json(deletes[0].Resource)).toContain('/jse/idp/*/temp/*');
  });
});
