import { ENVIRONMENTS } from '../infra/config';
import { AwsSolutionsPlugin } from '../infra/lib/nag';
import { buildStage } from './helpers';

describe.each(ENVIRONMENTS.map((c) => [c.envName, c] as const))('cdk-nag AwsSolutions (%s)', (_name, config) => {
  test('has no unacknowledged violations', () => {
    const { stage } = buildStage(config);
    const report = new AwsSolutionsPlugin(stage).validateScope(stage);
    const summary = report.violations.map(
      (v) => `${v.ruleName}: ${v.violatingResources.map((r) => r.constructPath).join(', ')}`,
    );
    expect(summary).toEqual([]);
  });
});
