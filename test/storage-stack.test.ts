import { Match } from 'aws-cdk-lib/assertions';
import { JSE_FEEDS } from '../infra/config';
import { buildStage } from './helpers';

describe('StorageStack', () => {
  const { storage } = buildStage().templates;

  test('bucket is KMS-encrypted, versioned and private', () => {
    storage.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'prime-dev-file-downloads',
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: Match.anyValue() },
          }),
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('EventBridge notifications are enabled', () => {
    storage.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: { EventBridgeConfiguration: {} },
    });
  });

  test('bucket and key are retained on stack deletion', () => {
    storage.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    storage.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
  });

  test('KMS key rotation is enabled', () => {
    storage.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  test('bucket policy denies non-TLS access', () => {
    storage.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });

  test('temp/ prefixes expire after 7 days and noncurrent versions after 90', () => {
    storage.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 90 } }),
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
          ...JSE_FEEDS.map((feed) =>
            Match.objectLike({ Prefix: `${feed.prefix}temp/`, ExpirationInDays: 7, Status: 'Enabled' }),
          ),
        ]),
      },
    });
  });
});
