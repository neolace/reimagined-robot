import type { CronOptions } from 'aws-cdk-lib/aws-events';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

export type EnvName = 'dev' | 'uat' | 'prod';
export type JseFeedId = 'bda' | 'marketData' | 'referenceData' | 'optionsData';

/** A scheduled retrieval of one remote file. */
export interface FeedConfig {
  readonly enabled: boolean;
  /** Absolute path of the file on the vendor SFTP server. */
  readonly remotePath: string;
  /** Interpreted in Africa/Johannesburg. */
  readonly schedule: CronOptions;
}

export interface VendorConfig {
  /** e.g. "sftp://sftp.vendor.example:22" */
  readonly sftpUrl: string;
  /** Host public keys supplied by the vendor out-of-band. Never trust-on-first-use. */
  readonly trustedHostKeys: string[];
  /** Transfer Family FailureCode meaning "remote file does not exist" (confirmed by the Phase 2 spike). */
  readonly fileNotFoundFailureCode: string;
}

export interface EnvironmentConfig {
  readonly envName: EnvName;
  readonly account: string;
  readonly region: string;
  readonly logRetention: RetentionDays;
  readonly alarmEmails: string[];
  /** Local (SAST) time after which a missing file is an incident. */
  readonly fileDeadline: { readonly hour: number; readonly minute: number };
  /** Optional central S3 server-access-logs bucket name. */
  readonly accessLogsBucketName?: string;
  readonly jse: VendorConfig & { readonly feeds: Record<JseFeedId, FeedConfig> };
  readonly a2x: VendorConfig & {
    readonly enabled: boolean;
    /** Remote path with a single "{}" placeholder replaced by the business date (YYYYMMDD). */
    readonly remotePathTemplate: string;
    readonly schedule: CronOptions;
  };
}
