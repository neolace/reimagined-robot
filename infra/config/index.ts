import { devConfig } from './dev';
import { prodConfig } from './prod';
import { uatConfig } from './uat';

export * from './types';
export * from './feeds';
export const ENVIRONMENTS = [devConfig, uatConfig, prodConfig] as const;
export { devConfig, uatConfig, prodConfig };
