import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { acknowledge } from '../nag';
import { Construct } from 'constructs';
import { bucketNameFor, EnvironmentConfig, JSE_FEEDS } from '../../config';

export interface StorageStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/** Customer-managed KMS key and the landing bucket. See docs/architecture/component-specs.md §1. */
export class StorageStack extends Stack {
  public readonly dataKey: kms.Key;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${bucketNameFor(config.envName)}`,
      description: 'Encrypts the landing bucket, SFTP secrets and alert topic',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // CloudWatch alarms and EventBridge rules publish to the KMS-encrypted alert topic.
    this.dataKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAlertPublishersToUseKey',
        principals: [
          new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
          new iam.ServicePrincipal('events.amazonaws.com'),
        ],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    const accessLogsBucket = config.accessLogsBucketName
      ? s3.Bucket.fromBucketName(this, 'AccessLogsBucket', config.accessLogsBucketName)
      : undefined;

    this.bucket = new s3.Bucket(this, 'FileDownloads', {
      bucketName: bucketNameFor(config.envName),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      eventBridgeEnabled: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: accessLogsBucket ? `${bucketNameFor(config.envName)}/` : undefined,
      lifecycleRules: [
        { id: 'noncurrent-versions', noncurrentVersionExpiration: Duration.days(90) },
        { id: 'abort-incomplete-mpu', abortIncompleteMultipartUploadAfter: Duration.days(1) },
        ...JSE_FEEDS.map((feed) => ({
          id: `expire-temp-${feed.id}`,
          prefix: `${feed.prefix}temp/`,
          expiration: Duration.days(7),
        })),
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    if (!accessLogsBucket) {
      acknowledge(this.bucket, [
        {
          id: 'AwsSolutions-S1',
          reason:
            'Server access logs go to the org central logging bucket when accessLogsBucketName is configured; CloudTrail covers access auditing otherwise.',
        },
      ]);
    }

    // CDK-managed singleton that enables EventBridge notifications on the bucket.
    for (const child of this.node.children.filter((c) => c.node.id.startsWith('BucketNotificationsHandler'))) {
      acknowledge(child, [
        { id: 'AwsSolutions-IAM4', reason: 'CDK-managed BucketNotificationsHandler uses AWSLambdaBasicExecutionRole.' },
      ]);
    }
  }
}
