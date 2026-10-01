import { HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import type { DeadlineFeed } from '../src/lambdas/file-deadline-check';

const s3Mock = mockClient(S3Client);
const snsMock = mockClient(SNSClient);

const FEEDS: DeadlineFeed[] = [
  { feed: 'bda', kind: 'fixed', key: 'jse/idp/bda/BDA_FILE.csv' },
  { feed: 'a2x', kind: 'dated', key: 'a2x/ftp/reference-data/equities/EQ_REF_{}.csv' },
];

const notFound = () => new NotFound({ message: 'Not Found', $metadata: {} });

let cachedHandler: (typeof import('../src/lambdas/file-deadline-check'))['handler'] | undefined;

/** Import once, after the environment is set, so the SDK clients use the mocked classes. */
const loadHandler = async () => {
  if (cachedHandler) return cachedHandler;
  process.env.AWS_REGION = 'af-south-1';
  process.env.BUCKET_NAME = 'prime-test-file-downloads';
  process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:af-south-1:111111111111:alerts';
  process.env.FEEDS = JSON.stringify(FEEDS);
  process.env.POWERTOOLS_METRICS_NAMESPACE = 'Test';
  process.env.POWERTOOLS_DEV = 'true';
  cachedHandler = (await import('../src/lambdas/file-deadline-check')).handler;
  return cachedHandler;
};

describe('file-deadline-check', () => {
  beforeEach(() => {
    s3Mock.reset();
    snsMock.reset();
    // 07:00 SAST on 1 Oct 2026
    jest.useFakeTimers({ now: new Date('2026-10-01T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('no alert when every file arrived today', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ LastModified: new Date('2026-10-01T03:10:00Z') });
    const handler = await loadHandler();

    await expect(handler()).resolves.toEqual({ missing: [] });
    expect(s3Mock).toHaveReceivedCommandWith(HeadObjectCommand, {
      Key: 'a2x/ftp/reference-data/equities/EQ_REF_20261001.csv',
    });
    expect(snsMock).not.toHaveReceivedCommand(PublishCommand);
  });

  test('alerts when a fixed-name file is stale or a dated file is missing', async () => {
    s3Mock
      .on(HeadObjectCommand, { Key: 'jse/idp/bda/BDA_FILE.csv' })
      .resolves({ LastModified: new Date('2026-09-30T03:00:00Z') })
      .on(HeadObjectCommand, { Key: 'a2x/ftp/reference-data/equities/EQ_REF_20261001.csv' })
      .rejects(notFound());
    const handler = await loadHandler();

    const { missing } = await handler();

    expect(missing.map((m) => m.feed)).toEqual(['bda', 'a2x']);
    expect(missing[0].reason).toContain('20260930');
    expect(missing[1].reason).toBe('object does not exist');
    expect(snsMock).toHaveReceivedCommandTimes(PublishCommand, 1);
    const message = snsMock.commandCalls(PublishCommand)[0].args[0].input.Message;
    expect(message).toContain('jse/idp/bda/BDA_FILE.csv');
    expect(message).toContain('EQ_REF_20261001.csv');
  });

  test('a file modified late UTC on the previous day but today in SAST counts as today', async () => {
    // 22:30 UTC on 30 Sep = 00:30 SAST on 1 Oct
    s3Mock.on(HeadObjectCommand).resolves({ LastModified: new Date('2026-09-30T22:30:00Z') });
    const handler = await loadHandler();

    await expect(handler()).resolves.toEqual({ missing: [] });
  });

  test('unexpected S3 errors propagate so the invocation fails and alarms', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error('AccessDenied'));
    const handler = await loadHandler();

    await expect(handler()).rejects.toThrow('AccessDenied');
  });
});
