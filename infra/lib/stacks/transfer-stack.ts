import { CfnOutput, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as transfer from 'aws-cdk-lib/aws-transfer';
import { acknowledge } from '../nag';
import { Construct } from 'constructs';
import { A2X_FEED, EnvironmentConfig, VendorConfig } from '../../config';

export interface TransferStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly bucket: s3.IBucket;
  readonly dataKey: kms.IKey;
}

interface ConnectorOptions {
  readonly id: string;
  readonly slug: string;
  readonly vendor: VendorConfig;
  /** Object-key pattern the connector may write to. */
  readonly writePattern: string;
}

/** Vendor secrets and Transfer Family SFTP connectors. See docs/architecture/component-specs.md §2–3. */
export class TransferStack extends Stack {
  public readonly jseConnector: transfer.CfnConnector;
  public readonly a2xConnector: transfer.CfnConnector;

  private readonly config: EnvironmentConfig;
  private readonly bucket: s3.IBucket;
  private readonly dataKey: kms.IKey;
  private readonly loggingRole: iam.Role;

  constructor(scope: Construct, id: string, props: TransferStackProps) {
    super(scope, id, props);
    this.config = props.config;
    this.bucket = props.bucket;
    this.dataKey = props.dataKey;

    this.loggingRole = new iam.Role(this, 'ConnectorLoggingRole', {
      assumedBy: this.transferPrincipal(),
      description: 'Lets Transfer Family connectors write CloudWatch Logs',
    });
    this.loggingRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
        resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/transfer/*`],
      }),
    );
    acknowledge(this.loggingRole, [
      { id: 'AwsSolutions-IAM5', reason: 'Connector log group names contain the generated connector id.' },
    ]);

    this.jseConnector = this.createConnector({
      id: 'JseIdp',
      slug: 'jse-idp',
      vendor: this.config.jse,
      writePattern: 'jse/idp/*/temp/*',
    });
    this.a2xConnector = this.createConnector({
      id: 'A2x',
      slug: 'a2x',
      vendor: this.config.a2x,
      writePattern: `${A2X_FEED.prefix}*`,
    });
  }

  private transferPrincipal(): iam.IPrincipal {
    return new iam.ServicePrincipal('transfer.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:transfer:${this.region}:${this.account}:connector/*` },
      },
    });
  }

  private createConnector(opts: ConnectorOptions): transfer.CfnConnector {
    const secret = new secretsmanager.Secret(this, `${opts.id}SftpSecret`, {
      secretName: `prime/${this.config.envName}/sftp/${opts.slug}`,
      description: `${opts.id} SFTP connector credentials as JSON with Username and PrivateKey or Password. Value is set out-of-band.`,
      encryptionKey: this.dataKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    acknowledge(secret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Vendor-issued SFTP credentials; rotation is a manual procedure coordinated with the vendor (runbook).',
      },
    ]);

    const accessRole = new iam.Role(this, `${opts.id}ConnectorAccessRole`, {
      assumedBy: this.transferPrincipal(),
      description: `${opts.id} SFTP connector: write retrieved files to S3 and read its secret`,
    });
    this.bucket.grantPut(accessRole, opts.writePattern);
    accessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [this.bucket.bucketArn],
      }),
    );
    // Principal-side grants: secret.grantRead() would edit the key policy in StorageStack and create a stack cycle.
    accessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [secret.secretArn],
      }),
    );
    accessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [this.dataKey.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } },
      }),
    );
    acknowledge(accessRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: `Object wildcard limited to ${opts.writePattern}; KMS data-key actions require a wildcard suffix.`,
      },
    ]);

    const connector = new transfer.CfnConnector(this, `${opts.id}SftpConnector`, {
      url: opts.vendor.sftpUrl,
      accessRole: accessRole.roleArn,
      loggingRole: this.loggingRole.roleArn,
      sftpConfig: {
        userSecretId: secret.secretArn,
        trustedHostKeys: opts.vendor.trustedHostKeys,
      },
    });

    new logs.LogGroup(this, `${opts.id}ConnectorLogs`, {
      logGroupName: `/aws/transfer/${connector.attrConnectorId}`,
      retention: this.config.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, `${opts.id}ConnectorId`, { value: connector.attrConnectorId });
    new CfnOutput(this, `${opts.id}ConnectorEgressIps`, {
      description: 'Send to the vendor for allowlisting',
      value: Fn.join(',', connector.attrServiceManagedEgressIpAddresses),
    });
    return connector;
  }
}
