import type { JseFeedId } from './types';

/** Environment-independent feed definitions. Names match the architecture diagram. */
export interface JseFeedDefinition {
  readonly id: JseFeedId;
  readonly stateMachineName: string;
  readonly scheduleName: string;
  /** Final S3 prefix (no leading slash). Files land in `${prefix}temp/` first. */
  readonly prefix: string;
}

export const JSE_FEEDS: readonly JseFeedDefinition[] = [
  {
    id: 'bda',
    stateMachineName: 'gm-prime-equities-bda',
    scheduleName: 'gm-prime-equities-sftp-bda',
    prefix: 'jse/idp/bda/',
  },
  {
    id: 'marketData',
    stateMachineName: 'gm-prime-equities-market-data',
    scheduleName: 'gm-prime-equities-sftp-market-data',
    prefix: 'jse/idp/market-data/equities/',
  },
  {
    id: 'referenceData',
    stateMachineName: 'gm-prime-equities-reference-data',
    scheduleName: 'gm-prime-equities-sftp-reference-data',
    prefix: 'jse/idp/market-data/reference/',
  },
  {
    id: 'optionsData',
    stateMachineName: 'gm-prime-equities-options-data',
    scheduleName: 'gm-prime-equities-sftp-options-data',
    prefix: 'jse/idp/market-data/options/',
  },
];

export const A2X_FEED = {
  outerStateMachineName: 'gm-prime-equities-a2x',
  transferStateMachineName: 'gm-prime-equities-a2x-transfer',
  dateFunctionName: 'gm-prime-equities-date',
  scheduleName: 'gm-prime-equities-sftp-a2x',
  prefix: 'a2x/ftp/reference-data/equities/',
} as const;

export const SCHEDULE_GROUPS = {
  jse: 'gm-prime-scheduler-group-sftp',
  a2x: 'gm-prime-scheduler-group-a2x-sftp',
} as const;

export const JSE_TEMP_KEY_WILDCARD = 'jse/idp/*/temp/*';

export const bucketNameFor = (envName: string): string => `prime-${envName}-file-downloads`;

/** Final S3 key of a retrieved file: the connector keeps the remote file name. */
export const finalKeyFor = (prefix: string, remotePath: string): string =>
  `${prefix}${remotePath.substring(remotePath.lastIndexOf('/') + 1)}`;
