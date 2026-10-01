import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER, jseFeeds, SFTP_WINDOW } from './defaults';
import type { EnvironmentConfig } from './types';

// Values marked REPLACE_ME must be filled in before the first deploy to this environment.
export const devConfig: EnvironmentConfig = {
  envName: 'dev',
  account: process.env.PRIME_DEV_ACCOUNT ?? '111111111111', // REPLACE_ME
  region: 'af-south-1',
  logRetention: RetentionDays.ONE_MONTH,
  alarmEmails: ['tertius.geldenhuys@standardbank.co.za'],
  fileDeadline: { hour: 7, minute: 0 },
  jse: {
    connectorId: 'c-dsfgdsfgsdfdgsdf',
    fileNotFoundFailureCode: FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER,
    feeds: jseFeeds(false),
  },
  a2x: {
    enabled: false,
    connectorId: 'c-sadfsdfsdfsddfsd',
    fileNotFoundFailureCode: FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER,
    remotePathTemplate: '/outbound/equities/EQ_REF_{}.csv', // REPLACE_ME (Q2)
    schedule: SFTP_WINDOW,
  },
};
