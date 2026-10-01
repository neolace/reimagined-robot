import type { CronOptions } from 'aws-cdk-lib/aws-events';
import type { FeedConfig, JseFeedId } from './types';

/** 03:00, 03:30 … 06:30 SAST on weekdays. */
export const BDA_WINDOW: CronOptions = { minute: '0/30', hour: '3-6', weekDay: 'MON-FRI' };

// TODO(Q2): replace placeholder remote paths with the vendor-confirmed paths.
// TODO(Q3): market-data / reference-data / options-data schedules default to the bda window until confirmed.
export const jseFeeds = (enabled: boolean): Record<JseFeedId, FeedConfig> => ({
  bda: { enabled, remotePath: '/outbound/bda/BDA_FILE.csv', schedule: BDA_WINDOW },
  marketData: { enabled, remotePath: '/outbound/market-data/equities/EQUITIES_FILE.csv', schedule: BDA_WINDOW },
  referenceData: { enabled, remotePath: '/outbound/market-data/reference/REFERENCE_FILE.csv', schedule: BDA_WINDOW },
  optionsData: { enabled, remotePath: '/outbound/market-data/options/OPTIONS_FILE.csv', schedule: BDA_WINDOW },
});

// TODO(Phase 2 spike): replace with the FailureCode observed for a missing remote file.
export const FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER = 'FILE_NOT_FOUND';
