import { prodConfig } from '../infra/config';
import { buildStage } from './helpers';

/** Asset hashes depend on line endings and local paths; mask them so snapshots are portable. */
const normalise = (template: unknown): unknown =>
  JSON.parse(JSON.stringify(template).replace(/[a-f0-9]{64}(\.zip|\.json)?/g, '<asset-hash>$1'));

describe('template snapshots (prod)', () => {
  const { templates } = buildStage(prodConfig);

  test.each(Object.keys(templates) as (keyof typeof templates)[])('%s', (name) => {
    expect(normalise(templates[name].toJSON())).toMatchSnapshot();
  });
});
