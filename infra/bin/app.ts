#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { ENVIRONMENTS } from '../config';
import { IngestionStage } from '../lib/stage';

const app = new App();

for (const config of ENVIRONMENTS) {
  new IngestionStage(app, `Prime-${config.envName}`, {
    env: { account: config.account, region: config.region },
    config,
  });
}

Tags.of(app).add('Project', 'prime-sftp-ingestion');
Tags.of(app).add('Owner', 'prime-data-engineering');
Tags.of(app).add('CostCentre', 'prime');
