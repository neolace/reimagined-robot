import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { devConfig, EnvironmentConfig } from '../infra/config';
import { IngestionStage } from '../infra/lib/stage';

export interface BuiltStage {
  app: App;
  stage: IngestionStage;
  templates: {
    storage: Template;
    transfer: Template;
    orchestration: Template;
    processing: Template;
    monitoring: Template;
  };
}

/** Builds and synthesises one environment without bundling Lambda assets (no esbuild/pip needed in unit tests). */
export const buildStage = (config: EnvironmentConfig = devConfig): BuiltStage => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stage = new IngestionStage(app, `Prime-${config.envName}`, {
    env: { account: config.account, region: config.region },
    config,
  });
  app.synth();
  return {
    app,
    stage,
    templates: {
      storage: Template.fromStack(stage.storage),
      transfer: stage.transfer ? Template.fromStack(stage.transfer) : Template.fromJSON({ Resources: {} }),
      orchestration: Template.fromStack(stage.orchestration),
      processing: Template.fromStack(stage.processing),
      monitoring: Template.fromStack(stage.monitoring),
    },
  };
};

type Resource = { Properties: Record<string, unknown> };

/** Resources of a type as [logicalId, resource] pairs. */
export const resourcesOf = (template: Template, type: string): [string, Resource][] =>
  Object.entries(template.findResources(type)) as [string, Resource][];

export const json = (value: unknown): string => JSON.stringify(value);
