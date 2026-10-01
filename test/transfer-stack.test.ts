import { Match } from 'aws-cdk-lib/assertions';
import { devConfig } from '../infra/config';
import { buildStage, json, resourcesOf } from './helpers';

describe('TransferStack', () => {
  const { transfer } = buildStage().templates;

  test('two connectors with pinned host keys, a secret and a logging role', () => {
    transfer.resourceCountIs('AWS::Transfer::Connector', 2);
    for (const vendor of [devConfig.jse, devConfig.a2x]) {
      transfer.hasResourceProperties('AWS::Transfer::Connector', {
        Url: vendor.sftpUrl,
        SftpConfig: { TrustedHostKeys: vendor.trustedHostKeys, UserSecretId: Match.anyValue() },
        LoggingRole: Match.anyValue(),
      });
    }
  });

  test('secrets are CMK-encrypted, retained and carry no value in the template', () => {
    transfer.resourceCountIs('AWS::SecretsManager::Secret', 2);
    for (const name of ['prime/dev/sftp/jse-idp', 'prime/dev/sftp/a2x']) {
      transfer.hasResource('AWS::SecretsManager::Secret', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({ Name: name, KmsKeyId: Match.anyValue(), SecretString: Match.absent() }),
      });
    }
  });

  test('roles trust Transfer Family only from this account', () => {
    const roles = resourcesOf(transfer, 'AWS::IAM::Role');
    expect(roles).toHaveLength(3);
    for (const [, role] of roles) {
      const statement = (role.Properties.AssumeRolePolicyDocument as { Statement: unknown[] }).Statement[0];
      expect(statement).toMatchObject({
        Principal: { Service: 'transfer.amazonaws.com' },
        Condition: { StringEquals: { 'aws:SourceAccount': devConfig.account } },
      });
    }
  });

  test('each connector can only write to its own landing prefix', () => {
    const policies = resourcesOf(transfer, 'AWS::IAM::Policy').map(([, p]) => json(p.Properties));
    const jse = policies.find((p) => p.includes('JseIdpConnectorAccessRole'));
    const a2x = policies.find((p) => p.includes('A2xConnectorAccessRole'));
    expect(jse).toContain('/jse/idp/*/temp/*');
    expect(jse).not.toContain('a2x/');
    expect(a2x).toContain('/a2x/ftp/reference-data/equities/*');
    expect(a2x).not.toContain('jse/');
  });

  test('egress IPs are exported for vendor allowlisting', () => {
    transfer.hasOutput('JseIdpConnectorEgressIps', {});
    transfer.hasOutput('A2xConnectorEgressIps', {});
  });
});
