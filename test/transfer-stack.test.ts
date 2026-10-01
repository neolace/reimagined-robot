import { App, Stack } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { devConfig, uatConfig } from '../infra/config';
import { RetrieveFileStateMachine } from '../infra/lib/constructs/retrieve-file-state-machine';
import { TransferStack } from '../infra/lib/stacks/transfer-stack';
import { json, resourcesOf } from './helpers';

const buildTransfer = (config: typeof devConfig | typeof uatConfig) => {
  const app = new App();
  const env = { account: config.account, region: config.region };
  const imports = new Stack(app, `${config.envName}-Imports`, { env });
  new logs.LogGroup(imports, 'FixtureLogGroup');
  const bucket = s3.Bucket.fromBucketName(imports, 'Bucket', `prime-${config.envName}-file-downloads`);
  const dataKey = kms.Key.fromKeyArn(
    imports,
    'DataKey',
    `arn:aws:kms:${config.region}:${config.account}:key/00000000-0000-0000-0000-000000000000`,
  );
  const transfer = new TransferStack(app, `${config.envName}-Transfer`, { config, bucket, dataKey, env });

  new RetrieveFileStateMachine(transfer, 'RetrieveJse', {
    stateMachineName: `${config.envName}-jse-retrieve`,
    connector: transfer.jseConnector,
    localDirectoryPath: `/prime-${config.envName}-file-downloads/jse/idp/bda/temp`,
    fileNotFoundFailureCode: config.jse.fileNotFoundFailureCode,
    logRetention: logs.RetentionDays.ONE_MONTH,
  });
  new RetrieveFileStateMachine(transfer, 'RetrieveA2x', {
    stateMachineName: `${config.envName}-a2x-retrieve`,
    connector: transfer.a2xConnector,
    localDirectoryPath: `/prime-${config.envName}-file-downloads/a2x/ftp/reference-data/equities`,
    fileNotFoundFailureCode: config.a2x.fileNotFoundFailureCode,
    logRetention: logs.RetentionDays.ONE_MONTH,
  });

  return {
    transfer: Template.fromStack(transfer),
  };
};

describe('TransferStack', () => {
  const dev = buildTransfer(devConfig);
  const uat = buildTransfer(uatConfig);
  const { transfer: devTransfer } = dev;
  const { transfer: uatTransfer } = uat;

  test('dev uses existing connectors without provisioning connector resources', () => {
    devTransfer.resourceCountIs('AWS::Transfer::Connector', 0);
    devTransfer.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const connectorRoles = resourcesOf(devTransfer, 'AWS::IAM::Role').filter(([, role]) =>
      String(role.Properties.Description ?? '').includes('connector'),
    );
    expect(connectorRoles).toHaveLength(0);
  });

  test('dev retrieval tasks use the configured connector IDs and ARNs', () => {
    const template = json(devTransfer.toJSON());
    for (const connectorId of ['c-sadfsdfsdfsd', 'c-dsfgdsfgsdf']) {
      expect(template).toContain(connectorId);
      expect(template).toContain(`transfer:${devConfig.region}:${devConfig.account}:connector/${connectorId}`);
    }
  });

  test('uat provisions connectors with pinned host keys, a secret and a logging role', () => {
    uatTransfer.resourceCountIs('AWS::Transfer::Connector', 2);
    for (const vendor of [uatConfig.jse, uatConfig.a2x]) {
      if (!('sftpUrl' in vendor)) throw new Error('Uat must provision connectors from endpoint configuration.');
      uatTransfer.hasResourceProperties('AWS::Transfer::Connector', {
        Url: vendor.sftpUrl,
        SftpConfig: { TrustedHostKeys: vendor.trustedHostKeys, UserSecretId: Match.anyValue() },
        LoggingRole: Match.anyValue(),
      });
    }
  });

  test('secrets are CMK-encrypted, retained and carry no value in the template', () => {
    uatTransfer.resourceCountIs('AWS::SecretsManager::Secret', 2);
    for (const name of ['prime/uat/sftp/jse-idp', 'prime/uat/sftp/a2x']) {
      uatTransfer.hasResource('AWS::SecretsManager::Secret', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({ Name: name, KmsKeyId: Match.anyValue(), SecretString: Match.absent() }),
      });
    }
  });

  test('roles trust Transfer Family only from this account', () => {
    const roles = resourcesOf(uatTransfer, 'AWS::IAM::Role').filter(([, role]) =>
      json(role.Properties.AssumeRolePolicyDocument).includes('transfer.amazonaws.com'),
    );
    expect(roles).toHaveLength(3);
    for (const [, role] of roles) {
      const statement = (role.Properties.AssumeRolePolicyDocument as { Statement: unknown[] }).Statement[0];
      expect(statement).toMatchObject({
        Principal: { Service: 'transfer.amazonaws.com' },
        Condition: { StringEquals: { 'aws:SourceAccount': uatConfig.account } },
      });
    }
  });

  test('each connector can only write to its own landing prefix', () => {
    const policies = resourcesOf(uatTransfer, 'AWS::IAM::Policy').map(([, p]) => json(p.Properties));
    const jse = policies.find((p) => p.includes('JseIdpConnectorAccessRole'));
    const a2x = policies.find((p) => p.includes('A2xConnectorAccessRole'));
    expect(jse).toContain('/jse/idp/*/temp/*');
    expect(jse).not.toContain('a2x/');
    expect(a2x).toContain('/a2x/ftp/reference-data/equities/*');
    expect(a2x).not.toContain('jse/');
  });

  test('egress IPs are exported for vendor allowlisting', () => {
    uatTransfer.hasOutput('JseIdpConnectorEgressIps', {});
    uatTransfer.hasOutput('A2xConnectorEgressIps', {});
  });
});
