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
    stateMachineName: 'gm-prime-equities-bda-daily',
    scheduleName: 'gm-prime-equities-jse-sftp-bda',
    prefix: 'jse/idp/bda/',
  },
  {
    id: 'marketData',
    stateMachineName: 'gm-prime-equities-market-data',
    scheduleName: 'gm-prime-equities-jse-sftp-market-data',
    prefix: 'jse/idp/market-data/equities/',
  },
  {
    id: 'referenceData',
    stateMachineName: 'gm-prime-equities-reference-data',
    scheduleName: 'gm-prime-equities-jse-sftp-reference-data',
    prefix: 'jse/idp/market-data/reference/',
  },
  {
    id: 'optionsData',
    stateMachineName: 'gm-prime-equities-options-data',
    scheduleName: 'gm-prime-equities-jse-sftp-options-data',
    prefix: 'jse/idp/market-data/options/',
  },
];

export const A2X_FEED = {
  outerStateMachineName: 'gm-prime-equities-step-function-a2x-sftp',
  /** The diagram's nested "A2X" Step Function. */
  transferStateMachineName: 'gm-prime-equities-a2x-transfer',
  dateFunctionName: 'gm-prime-equities-date',
  scheduleName: 'gm-prime-equities-schedule-a2x-sftp',
  prefix: 'a2x/ftp/reference-data/equities/',
} as const;

export const SCHEDULE_GROUPS = {
  jse: 'gm-prime-equities-scheduler-group-jse-sftp',
  a2x: 'gm-prime-equities-scheduler-group-a2x-sftp',
} as const;

export const JSE_TEMP_KEY_WILDCARD = 'jse/idp/*/temp/*';

/** The diagram's `gm-prime-equities-file-downloads` with an environment suffix, because bucket names are global. */
export const bucketNameFor = (envName: string): string => `gm-prime-equities-file-downloads-${envName}`;

/**
 * S3 key of a retrieved file in its final folder: the connector keeps the remote file name. For JSE feeds this is the
 * name before Shadow-Rename adds its date-time stamp (`<name>_<YYYYMMDDTHHMMSS><extension>`).
 */
export const finalKeyFor = (prefix: string, remotePath: string): string =>
  `${prefix}${remotePath.substring(remotePath.lastIndexOf('/') + 1)}`;
