import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { HeadObjectCommand, ListObjectsV2Command, NotFound, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { toBusinessDate } from '../equities-date';

/**
 * A feed whose file must exist by the deadline.
 * - `stamped`: `key` is the remote file name in its final folder. Shadow-Rename stores each new version as
 *   `<name>_<YYYYMMDDTHHMMSS><extension>`, so a copy stamped with today's SAST date must exist.
 * - `dated`: the key contains "{}", which is replaced by today's YYYYMMDD; the object must exist.
 */
export interface DeadlineFeed {
  feed: string;
  kind: 'stamped' | 'dated';
  key: string;
}

export interface FeedResult {
  feed: string;
  key: string;
  ok: boolean;
  reason?: string;
}

const logger = new Logger();
const metrics = new Metrics();
const s3 = new S3Client({});
const sns = new SNSClient({});

const readFeeds = (): DeadlineFeed[] => JSON.parse(process.env.FEEDS ?? '[]') as DeadlineFeed[];

/**
 * Key prefix of every copy Shadow-Rename stamps on `businessDate`:
 * `jse/idp/bda/BDA_FILE.csv` -> `jse/idp/bda/BDA_FILE_20261001T`. Splits the extension like Python's `posixpath.splitext`.
 */
export const stampPrefixFor = (key: string, businessDate: string): string => {
  const slash = key.lastIndexOf('/');
  const folder = key.substring(0, slash + 1);
  const name = key.substring(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 && /[^.]/.test(name.substring(0, dot)) ? name.substring(0, dot) : name;
  return `${folder}${stem}_${businessDate}T`;
};

const checkStamped = async (bucket: string, feed: DeadlineFeed, today: string): Promise<FeedResult> => {
  const prefix = stampPrefixFor(feed.key, today);
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
  const ok = (listing.KeyCount ?? 0) > 0;
  return { feed: feed.feed, key: `${prefix}*`, ok, ...(ok ? {} : { reason: `no copy stamped ${today}` }) };
};

const checkDated = async (bucket: string, feed: DeadlineFeed, today: string): Promise<FeedResult> => {
  const key = feed.key.replace('{}', today);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { feed: feed.feed, key, ok: true };
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') {
      return { feed: feed.feed, key, ok: false, reason: 'object does not exist' };
    }
    throw err;
  }
};

export const checkFeed = async (bucket: string, feed: DeadlineFeed, now: Date): Promise<FeedResult> => {
  const today = toBusinessDate(now);
  return feed.kind === 'stamped' ? checkStamped(bucket, feed, today) : checkDated(bucket, feed, today);
};

export const handler = async (): Promise<{ missing: FeedResult[] }> => {
  const bucket = process.env.BUCKET_NAME!;
  const topicArn = process.env.ALERT_TOPIC_ARN!;
  const now = new Date();

  const results = await Promise.all(readFeeds().map((feed) => checkFeed(bucket, feed, now)));
  for (const result of results) {
    const single = metrics.singleMetric();
    single.addDimension('Feed', result.feed);
    single.addMetric('FileMissing', MetricUnit.Count, result.ok ? 0 : 1);
  }

  const missing = results.filter((r) => !r.ok);
  if (missing.length > 0) {
    logger.warn('Files missing at deadline', { missing });
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `Prime SFTP ingestion: ${missing.length} file(s) not received by deadline`,
        Message: [
          `Business date ${toBusinessDate(now)}: the following files were not received in s3://${bucket}.`,
          '',
          ...missing.map((m) => `- ${m.feed}: ${m.key} (${m.reason})`),
          '',
          'Runbook: docs/operations/observability-and-runbook.md#file-not-received-by-deadline',
        ].join('\n'),
      }),
    );
  } else {
    logger.info('All files received', { feeds: results.map((r) => r.feed) });
  }
  return { missing };
};
