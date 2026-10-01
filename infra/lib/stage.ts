import { Stage, StageProps, Tags, Validations } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config';
import { AwsSolutionsPlugin } from './nag';
import { MonitoringStack } from './stacks/monitoring-stack';
import { OrchestrationStack } from './stacks/orchestration-stack';
import { ProcessingStack } from './stacks/processing-stack';
import { StorageStack } from './stacks/storage-stack';
import { TransferStack } from './stacks/transfer-stack';

export interface IngestionStageProps extends StageProps {
  readonly config: EnvironmentConfig;
}

/** One complete environment: Storage → Transfer → Orchestration + Processing → Monitoring. */
export class IngestionStage extends Stage {
  public readonly storage: StorageStack;
  public readonly transfer: TransferStack;
  public readonly orchestration: OrchestrationStack;
  public readonly processing: ProcessingStack;
  public readonly monitoring: MonitoringStack;

  constructor(scope: Construct, id: string, props: IngestionStageProps) {
    super(scope, id, props);
    const { config } = props;

    this.storage = new StorageStack(this, 'Storage', { config });
    this.transfer = new TransferStack(this, 'Transfer', {
      config,
      bucket: this.storage.bucket,
      dataKey: this.storage.dataKey,
    });
    this.orchestration = new OrchestrationStack(this, 'Orchestration', {
      config,
      bucket: this.storage.bucket,
      jseConnector: this.transfer.jseConnector,
      a2xConnector: this.transfer.a2xConnector,
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
