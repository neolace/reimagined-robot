/**
 * End-to-end test against the deployed dev stage and a mock SFTP server the team controls.
 * See docs/operations/testing-strategy.md#integration-tests
 *
 * Required environment:
 *   AWS credentials for the dev account (and AWS_REGION)
 *   PRIME_ENV                 dev (default)
 *   MOCK_SFTP_HOST            host of the mock SFTP server the dev JSE connector points at
 *   MOCK_SFTP_PORT            default 22
 *   MOCK_SFTP_USER
 *   MOCK_SFTP_PRIVATE_KEY     path to the private key
 *
 * Run: npm run test:integration
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import SftpClient from 'ssh2-sftp-client';
import { bucketNameFor, devConfig, ENVIRONMENTS, finalKeyFor, JSE_FEEDS } from '../../infra/config';

const env = process.env.PRIME_ENV ?? 'dev';
const config = ENVIRONMENTS.find((c) => c.envName === env) ?? devConfig;
const bucket = bucketNameFor(config.envName);
const bda = JSE_FEEDS.find((f) => f.id === 'bda')!;
const remotePath = config.jse.feeds.bda.remotePath;
const targetKey = finalKeyFor(bda.prefix, remotePath);
const stateMachineArn = `arn:aws:states:${config.region}:${config.account}:stateMachine:${bda.stateMachineName}`;

const sfnClient = new SFNClient({ region: config.region });
const s3 = new S3Client({ region: config.region });

const configured = Boolean(
  process.env.MOCK_SFTP_HOST && process.env.MOCK_SFTP_USER && process.env.MOCK_SFTP_PRIVATE_KEY,
);
const describeIfConfigured = configured ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 5 * 60_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(5_000);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const uploadFixture = async (content: string): Promise<void> => {
  const sftp = new SftpClient();
  await sftp.connect({
    host: process.env.MOCK_SFTP_HOST,
    port: Number(process.env.MOCK_SFTP_PORT ?? 22),
    username: process.env.MOCK_SFTP_USER,
    privateKey: readFileSync(process.env.MOCK_SFTP_PRIVATE_KEY!),
  });
  try {
    await sftp.mkdir(remotePath.substring(0, remotePath.lastIndexOf('/')), true);
    await sftp.put(Buffer.from(content), remotePath);
  } finally {
    await sftp.end();
  }
};

const runExecution = async (input: object): Promise<{ status: string; output?: string }> => {
  const { executionArn } = await sfnClient.send(
    new StartExecutionCommand({ stateMachineArn, name: `int-${randomUUID()}`, input: JSON.stringify(input) }),
  );
  return until('execution to finish', async () => {
    const result = await sfnClient.send(new DescribeExecutionCommand({ executionArn }));
    return result.status === 'RUNNING' ? undefined : { status: result.status!, output: result.output };
  });
};

const targetMd5 = async (): Promise<{ md5?: string; versionId?: string } | undefined> => {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: targetKey }));
    return { md5: head.Metadata?.md5, versionId: head.VersionId };
  } catch {
    return undefined;
  }
};

const tempIsEmpty = async (): Promise<boolean> => {
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${bda.prefix}temp/` }));
  return (listing.KeyCount ?? 0) === 0;
};

const md5 = (content: string) => createHash('md5').update(content).digest('hex');

describeIfConfigured(`bda retrieval and Shadow-Rename (${config.envName})`, () => {
  const first = `integration ${new Date().toISOString()} ${randomUUID()}\n`;
  let firstVersion: string | undefined;

  test('a new file is retrieved and promoted with md5 metadata', async () => {
    await uploadFixture(first);

    const execution = await runExecution({ remoteFilePaths: [remotePath] });
    expect(execution.status).toBe('SUCCEEDED');

    const target = await until('promoted file', async () => {
      const head = await targetMd5();
      return head?.md5 === md5(first) && (await tempIsEmpty()) ? head : undefined;
    });
    firstVersion = target.versionId;
  });

  test('retrieving the same content again is discarded as a duplicate', async () => {
    const execution = await runExecution({ remoteFilePaths: [remotePath] });
    expect(execution.status).toBe('SUCCEEDED');

    await until('temp/ to be emptied', async () => ((await tempIsEmpty()) ? true : undefined));
    expect((await targetMd5())?.versionId).toBe(firstVersion);
  });

  test('changed content is promoted as a new version', async () => {
    const second = `${first}changed\n`;
    await uploadFixture(second);

    expect((await runExecution({ remoteFilePaths: [remotePath] })).status).toBe('SUCCEEDED');
    const target = await until('new version', async () => {
      const head = await targetMd5();
      return head?.md5 === md5(second) ? head : undefined;
    });
    expect(target.versionId).not.toBe(firstVersion);
  });

  test('a missing remote file ends in FileNotAvailable, not a failure', async () => {
    const execution = await runExecution({ remoteFilePaths: [`/does-not-exist/${randomUUID()}.csv`] });
    expect(execution.status).toBe('SUCCEEDED');
  });
});
