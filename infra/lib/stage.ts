import { Stage, StageProps, Tags, Validations } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { EnvironmentConfig, VendorConfig } from '../config';
import { AwsSolutionsPlugin } from './nag';
import type { TransferConnectorReference } from './constructs/retrieve-file-state-machine';
import { MonitoringStack } from './stacks/monitoring-stack';
import { OrchestrationStack } from './stacks/orchestration-stack';
import { ProcessingStack } from './stacks/processing-stack';
import { StorageStack } from './stacks/storage-stack';
import { TransferStack } from './stacks/transfer-stack';

export interface IngestionStageProps extends StageProps {
  readonly config: EnvironmentConfig;
}

/** One complete environment: Storage → optional Transfer → Orchestration + Processing → Monitoring. */
export class IngestionStage extends Stage {
  public readonly storage: StorageStack;
  public readonly transfer: TransferStack | undefined;
  public readonly orchestration: OrchestrationStack;
  public readonly processing: ProcessingStack;
  public readonly monitoring: MonitoringStack;

  constructor(scope: Construct, id: string, props: IngestionStageProps) {
    super(scope, id, props);
    const { config } = props;

    this.storage = new StorageStack(this, 'Storage', { config });
    this.transfer = [config.jse, config.a2x].some((vendor) => 'sftpUrl' in vendor)
      ? new TransferStack(this, 'Transfer', {
          config,
          bucket: this.storage.bucket,
          dataKey: this.storage.dataKey,
        })
      : undefined;
    const referenceFor = (vendor: VendorConfig): TransferConnectorReference => {
      if ('connectorId' in vendor) {
        return {
          connectorId: vendor.connectorId,
          connectorArn: this.storage.formatArn({
            service: 'transfer',
            resource: 'connector',
            resourceName: vendor.connectorId,
          }),
        };
      }
      throw new Error('A provisioned Transfer Family connector reference is missing.');
    };

    this.orchestration = new OrchestrationStack(this, 'Orchestration', {
      config,
      bucket: this.storage.bucket,
      jseConnector: this.transfer?.jseConnector ?? referenceFor(config.jse),
      a2xConnector: this.transfer?.a2xConnector ?? referenceFor(config.a2x),
    });
    this.processing = new ProcessingStack(this, 'Processing', { config, bucket: this.storage.bucket });
    this.monitoring = new MonitoringStack(this, 'Monitoring', {
      config,
      bucket: this.storage.bucket,
      dataKey: this.storage.dataKey,
      stateMachines: this.orchestration.stateMachines,
      functions: [this.orchestration.dateFunction, this.processing.shadowRename],
      deadLetterQueues: [...this.orchestration.deadLetterQueues, this.processing.deadLetterQueue],
    });

    Tags.of(this).add('Environment', config.envName);
    // cdk-nag runs as a policy-validation plugin: any unacknowledged violation fails synthesis.
    Validations.of(this).addPlugins(new AwsSolutionsPlugin(this));
  }
}
