import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { toBusinessDate } from '../equities-date';

/**
 * A feed whose file must exist by the deadline.
 * - `fixed`: the key never changes; the object must have been modified today (SAST).
 * - `dated`: the key contains "{}" which is replaced by today's YYYYMMDD; the object must exist.
 */
export interface DeadlineFeed {
  feed: string;
  kind: 'fixed' | 'dated';
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

export const checkFeed = async (bucket: string, feed: DeadlineFeed, now: Date): Promise<FeedResult> => {
  const today = toBusinessDate(now);
  const key = feed.kind === 'dated' ? feed.key.replace('{}', today) : feed.key;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (feed.kind === 'fixed') {
      const modified = head.LastModified ? toBusinessDate(head.LastModified) : undefined;
      if (modified !== today) {
        return { feed: feed.feed, key, ok: false, reason: `last modified ${modified ?? 'unknown'}, expected ${today}` };
      }
    }
    return { feed: feed.feed, key, ok: true };
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') {
      return { feed: feed.feed, key, ok: false, reason: 'object does not exist' };
    }
    throw err;
  }
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
