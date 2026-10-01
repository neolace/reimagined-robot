import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BDA_WINDOW, FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER, jseFeeds } from './defaults';
import type { EnvironmentConfig } from './types';

// Values marked REPLACE_ME must be filled in before the first deploy to this environment.
export const uatConfig: EnvironmentConfig = {
  envName: 'uat',
  account: process.env.PRIME_UAT_ACCOUNT ?? '222222222222', // REPLACE_ME
  region: 'af-south-1',
  logRetention: RetentionDays.ONE_MONTH,
  alarmEmails: ['tertius.geldenhuys@standardbank.co.za'],
  fileDeadline: { hour: 7, minute: 0 },
  jse: {
    sftpUrl: 'sftp://jse-idp-uat.example.invalid:22', // REPLACE_ME
    trustedHostKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREPLACEMEWITHJSEHOSTKEY000000000000000000000'], // REPLACE_ME
    fileNotFoundFailureCode: FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER,
    feeds: jseFeeds(true),
  },
  a2x: {
    enabled: true,
    sftpUrl: 'sftp://a2x-uat.example.invalid:22', // REPLACE_ME
    trustedHostKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREPLACEMEWITHA2XHOSTKEY000000000000000000000'], // REPLACE_ME
    fileNotFoundFailureCode: FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER,
    remotePathTemplate: '/outbound/equities/EQ_REF_{}.csv', // REPLACE_ME (Q2)
    schedule: BDA_WINDOW, // TODO(Q3)
  },
};
