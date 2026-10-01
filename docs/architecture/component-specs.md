# Component specifications

This is the build spec for each component in the [architecture](../../README.md#architecture). Snippets are **TypeScript (AWS CDK v2, `aws-cdk-lib`)**, except for the Shadow-Rename Lambda, which is **Python**. They show intent and the important settings. They aren't complete stack files.

`cfg` refers to the typed per-environment config described in [environments](../operations/environments-and-deployment.md#configuration).

> **The implementation lives in [`infra/`](../../infra) and [`src/lambdas/`](../../src/lambdas).** The snippets below are abridged. Where a snippet and the code differ, the code is authoritative.

---

## 1. S3 bucket and KMS key

| Setting | Value | Why |
| --- | --- | --- |
| Name | `prime-{env}-file-downloads` | Bucket names are global, so the environment is part of the name |
| Encryption | SSE-KMS with a customer-managed key and S3 Bucket Keys | Key policy control and audit; Bucket Keys cut KMS request cost |
| Public access | Block all | |
| Transport | `enforceSSL: true` (denies `aws:SecureTransport = false`) | |
| Versioning | Enabled | Recovers objects that are deleted or overwritten by mistake. Shadow-Rename itself never overwrites ([ADR-010](decisions.md#adr-010-shadow-rename-stores-date-stamped-copies-and-never-overwrites)) |
| EventBridge notifications | Enabled | Triggers Shadow-Rename |
| Lifecycle | `*/temp/` objects expire after 7 days; noncurrent versions expire after 90 days; incomplete multipart uploads are aborted after 1 day | Keeps staging clean and limits version storage |
| Removal policy | `RETAIN` (all envs), plus `autoDeleteObjects` only in dev if wanted | Stops `cdk destroy` from deleting data |

**Key layout.** The diagram shows paths with a leading `/`. In S3 the keys have no leading slash:

| Feed | Staging prefix | Final prefix |
| --- | --- | --- |
| A2X equities reference | n/a (written directly) | `a2x/ftp/reference-data/equities/` |
| JSE BDA | `jse/idp/bda/temp/` | `jse/idp/bda/` |
| JSE market data: equities | `jse/idp/market-data/equities/temp/` | `jse/idp/market-data/equities/` |
| JSE market data: reference | `jse/idp/market-data/reference/temp/` | `jse/idp/market-data/reference/` |
| JSE market data: options | `jse/idp/market-data/options/temp/` | `jse/idp/market-data/options/` |

In the final prefix, each JSE file is a date-stamped copy, for example `jse/idp/bda/BDA_FILE_20261001T033012.csv` ([Shadow-Rename](#7-shadow-rename-lambda-python)).

```ts
const dataKey = new kms.Key(this, 'DataKey', {
  alias: `alias/prime-${cfg.envName}-file-downloads`,
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.RETAIN,
});

const bucket = new s3.Bucket(this, 'FileDownloads', {
  bucketName: `prime-${cfg.envName}-file-downloads`,
  encryption: s3.BucketEncryption.KMS,
  encryptionKey: dataKey,
  bucketKeyEnabled: true,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  versioned: true,
  eventBridgeEnabled: true,
  serverAccessLogsBucket: cfg.accessLogsBucket, // central logging bucket, if the org has one
  lifecycleRules: [
    { id: 'noncurrent-versions', noncurrentVersionExpiration: Duration.days(90) },
    { id: 'abort-mpu', abortIncompleteMultipartUploadAfter: Duration.days(1) },
    ...JSE_FEEDS.map((f) => ({
      id: `expire-temp-${f.id}`,
      prefix: `${f.prefix}temp/`,
      expiration: Duration.days(7),
    })),
  ],
  removalPolicy: RemovalPolicy.RETAIN,
});
```

---

## 2. Secrets Manager

For environments where CDK provisions connectors, create one secret per vendor, encrypted with `dataKey`. CDK creates the secret, but **the value is set out-of-band** (`aws secretsmanager put-secret-value`) so credentials never go into the repo or CloudFormation templates. Dev references existing connectors, so their credentials and secrets remain managed with those connectors outside this stack.

| Secret name | Used by |
| --- | --- |
| `prime/{env}/sftp/a2x` | A2X SFTP connector in uat/prod |
| `prime/{env}/sftp/jse-idp` | JSE IDP SFTP connector in uat/prod |

The value must use the JSON format Transfer Family expects. Key authentication is preferred:

```json
{
  "Username": "<sftp-user>",
  "PrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
}
```

`Password` may be used instead of, or as well as, `PrivateKey` if the vendor needs it.

```ts
const jseSecret = new secretsmanager.Secret(this, 'JseIdpSftpSecret', {
  secretName: `prime/${cfg.envName}/sftp/jse-idp`,
  description: 'JSE IDP SFTP connector credentials (value set out-of-band)',
  encryptionKey: dataKey,
  removalPolicy: RemovalPolicy.RETAIN,
});
```

Rotation happens by hand, driven by the vendor. The procedure is in the [runbook](../operations/observability-and-runbook.md#rotating-vendor-credentials).

---

## 3. Transfer Family SFTP connectors

| Setting | A2X | JSE IDP |
| --- | --- | --- |
| Logical name | `A2xSftpConnector` | `JseIdpSftpConnector` |
| Connection mode | Existing connector ID in dev; created by CDK in uat/prod | Existing connector ID in dev; created by CDK in uat/prod |
| `Url` when provisioned | `cfg.a2x.sftpUrl` (`sftp://host:22`) | `cfg.jse.sftpUrl` |
| `SftpConfig.UserSecretId` when provisioned | `prime/{env}/sftp/a2x` | `prime/{env}/sftp/jse-idp` |
| `SftpConfig.TrustedHostKeys` when provisioned | `cfg.a2x.trustedHostKeys` | `cfg.jse.trustedHostKeys` |
| Access role when provisioned | `a2x-connector-access-role` | `jse-connector-access-role` |
| Logging role when provisioned | shared `transfer-connector-logging-role` | same |

Dev uses the pre-existing JSE and A2X connector IDs in `infra/config/dev.ts`. When both connectors are imported, the stage omits the Transfer stack and does not manage those connectors, their secrets, access roles, logging role, or egress IP outputs. Their access roles must already allow writing to the app's S3 landing prefixes. Uat and prod continue to provision connectors and their supporting resources from endpoint and pinned-host-key configuration.

**Host keys** must be pinned with values obtained out-of-band from the vendor. You can check them, but not replace them, with `ssh-keyscan -p 22 <host>`.

**Static egress IPs.** Each connector exposes `ServiceManagedEgressIpAddresses`. Output them from the stack and send them to the vendor for allowlisting.

### Access role (one per connector, least privilege)

The trust policy allows `transfer.amazonaws.com`, conditioned on `aws:SourceAccount` and on `aws:SourceArn` matching `arn:aws:transfer:{region}:{account}:connector/*`. Permissions:

| Action | Resource |
| --- | --- |
| `s3:PutObject` | The connector's landing prefix only (e.g. `.../jse/idp/*/temp/*`) |
| `s3:ListBucket`, `s3:GetBucketLocation` | The bucket |
| `secretsmanager:GetSecretValue` | Its own secret |
| `kms:Decrypt`, `kms:GenerateDataKey` | `dataKey` |

```ts
const jseAccessRole = new iam.Role(this, 'JseConnectorAccessRole', {
  assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com', {
    conditions: {
      StringEquals: { 'aws:SourceAccount': this.account },
      ArnLike: { 'aws:SourceArn': `arn:aws:transfer:${this.region}:${this.account}:connector/*` },
    },
  }),
});
bucket.grantPut(jseAccessRole, 'jse/idp/*/temp/*');   // also grants kms:Encrypt/GenerateDataKey
jseAccessRole.addToPolicy(new iam.PolicyStatement({
  actions: ['s3:ListBucket', 's3:GetBucketLocation'],
  resources: [bucket.bucketArn],
}));
jseSecret.grantRead(jseAccessRole);                    // also grants kms:Decrypt on dataKey

// Provisioned environments (uat/prod) create the connector from endpoint configuration.
const jseConnector = new transfer.CfnConnector(this, 'JseIdpSftpConnector', {
  url: cfg.jse.sftpUrl,
  accessRole: jseAccessRole.roleArn,
  loggingRole: loggingRole.roleArn,
  sftpConfig: {
    userSecretId: jseSecret.secretArn,
    trustedHostKeys: cfg.jse.trustedHostKeys,
  },
});

new CfnOutput(this, 'JseConnectorEgressIps', {
  value: Fn.join(',', jseConnector.attrServiceManagedEgressIpAddresses),
});
```

### Logging role

The logging role is trusted by `transfer.amazonaws.com`. It has `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:DescribeLogStreams` and `logs:PutLogEvents` on `arn:aws:logs:{region}:{account}:log-group:/aws/transfer/*`. Set log group retention explicitly: 90 days in prod, 30 in dev and uat.

### Transfer result codes

> **To be filled in by the Phase 2 spike.** Record the actual values returned by `aws transfer list-file-transfer-results --connector-id <id> --transfer-id <id>`.

| Scenario | `StatusCode` | `FailureCode` | State machine outcome |
| --- | --- | --- | --- |
| File retrieved | `COMPLETED` | none | `Succeeded` |
| Still running | `QUEUED` / `IN_PROGRESS` | none | Keep polling |
| Remote file does not exist | `FAILED` | _TBC_ | `FileNotAvailable` (success) |
| Auth / host key / network failure | `FAILED` | _TBC_ | `TransferFailed` (fail + alarm) |

---

## 4. Step Functions: retrieve-file state machine

There's **one reusable construct**, `RetrieveFileStateMachine`, instantiated once per feed. This keeps the diagram's names while holding the logic in one place.

| Instance (state machine name) | Connector | `localDirectoryPath` |
| --- | --- | --- |
| `gm-prime-equities-bda` | JSE IDP | `/prime-{env}-file-downloads/jse/idp/bda/temp` |
| `gm-prime-equities-market-data` | JSE IDP | `/prime-{env}-file-downloads/jse/idp/market-data/equities/temp` |
| `gm-prime-equities-reference-data` | JSE IDP | `/prime-{env}-file-downloads/jse/idp/market-data/reference/temp` |
| `gm-prime-equities-options-data` | JSE IDP | `/prime-{env}-file-downloads/jse/idp/market-data/options/temp` |
| `gm-prime-equities-a2x-transfer` | A2X | `/prime-{env}-file-downloads/a2x/ftp/reference-data/equities` |

Because each environment is a separate AWS account, state machine names don't need an environment suffix.

**Input contract** (supplied by the schedule, or by the A2X outer machine):

```json
{ "remoteFilePaths": ["/outbound/bda/BDA_FILE.csv"] }
```

The design supports **one file per execution**, which keeps result evaluation simple. `StartFileTransfer` accepts up to 10 paths if a feed later needs more.

**Flow**

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "background": "#0d1117", "primaryColor": "#1c1f24", "primaryTextColor": "#e9ecef", "primaryBorderColor": "#868e96", "lineColor": "#8b949e", "arrowheadColor": "#8b949e", "clusterBkg": "#161b22", "clusterBorder": "#495057", "titleColor": "#e9ecef", "edgeLabelBackground": "#1c1f24", "noteBkgColor": "#2a1e0f", "noteTextColor": "#ffd8a8", "noteBorderColor": "#f08c00"}}}%%
stateDiagram-v2
    [*] --> StartFileTransfer
    StartFileTransfer --> WaitForTransfer
    WaitForTransfer --> ListFileTransferResults
    ListFileTransferResults --> EvaluateResult
    EvaluateResult --> WaitForTransfer: QUEUED / IN_PROGRESS / no result yet
    EvaluateResult --> Succeeded: COMPLETED
    EvaluateResult --> FileNotAvailable: FAILED + not-found code
    EvaluateResult --> TransferFailed: FAILED (other)
    Succeeded --> [*]
    FileNotAvailable --> [*]
    TransferFailed --> [*]

    classDef blue fill:#14143a,stroke:#3b5bdb,color:#fff
    classDef green fill:#0f2a14,stroke:#2f9e44,color:#b2f2bb
    classDef orange fill:#2a1e0f,stroke:#f08c00,color:#ffd8a8
    classDef red fill:#2a1414,stroke:#e03131,color:#fff
    class StartFileTransfer, ListFileTransferResults blue
    class Succeeded green
    class FileNotAvailable orange
    class TransferFailed red
```

| Setting | Value |
| --- | --- |
| Type | Standard (the executions are long-polling with low volume; see [decisions](decisions.md#adr-003-standard-workflows-for-retrieval)) |
| Timeout | 15 minutes |
| Poll interval | 30 seconds |
| Retries on SDK tasks | `Transfer.ThrottlingException`, `Transfer.ServiceUnavailableException`, `Transfer.InternalServiceError`: 5 attempts, 2 s interval, backoff ×2, full jitter |
| Logging | CloudWatch Logs, level `ERROR`, `includeExecutionData: false` |
| Tracing | X-Ray enabled |

```ts
export interface RetrieveFileStateMachineProps {
  readonly stateMachineName: string;
  readonly connector: transfer.CfnConnector;
  readonly localDirectoryPath: string;   // "/<bucket>/<prefix>"
  readonly fileNotFoundFailureCode: string; // from the Phase 2 spike
}

export class RetrieveFileStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RetrieveFileStateMachineProps) {
    super(scope, id);
    const connectorArn = props.connector.attrArn;
    const sdkRetry: sfn.RetryProps = {
      errors: ['Transfer.ThrottlingException', 'Transfer.ServiceUnavailableException', 'Transfer.InternalServiceError'],
      interval: Duration.seconds(2),
      maxAttempts: 5,
      backoffRate: 2,
      jitterStrategy: sfn.JitterType.FULL,
    };

    const start = new tasks.CallAwsService(this, 'StartFileTransfer', {
      service: 'transfer',
      action: 'startFileTransfer',
      parameters: {
        ConnectorId: props.connector.attrConnectorId,
        'RetrieveFilePaths.$': '$.remoteFilePaths',
        LocalDirectoryPath: props.localDirectoryPath,
      },
      iamResources: [connectorArn],
      resultSelector: { 'TransferId.$': '$.TransferId' },
      resultPath: '$.transfer',
    }).addRetry(sdkRetry);

    const wait = new sfn.Wait(this, 'WaitForTransfer', {
      time: sfn.WaitTime.duration(Duration.seconds(30)),
    });

    const poll = new tasks.CallAwsService(this, 'ListFileTransferResults', {
      service: 'transfer',
      action: 'listFileTransferResults',
      parameters: {
        ConnectorId: props.connector.attrConnectorId,
        'TransferId.$': '$.transfer.TransferId',
      },
      iamResources: [connectorArn],
      resultSelector: { 'Results.$': '$.FileTransferResults' },
      resultPath: '$.poll',
    }).addRetry(sdkRetry);

    const status = '$.poll.Results[0].StatusCode';
    const evaluate = new sfn.Choice(this, 'EvaluateResult')
      .when(sfn.Condition.not(sfn.Condition.isPresent(status)), wait)
      .when(sfn.Condition.stringEquals(status, 'COMPLETED'), new sfn.Succeed(this, 'Succeeded'))
      .when(
        sfn.Condition.and(
          sfn.Condition.stringEquals(status, 'FAILED'),
          sfn.Condition.stringEquals('$.poll.Results[0].FailureCode', props.fileNotFoundFailureCode),
        ),
        new sfn.Succeed(this, 'FileNotAvailable', { comment: 'File not published yet; next schedule will retry' }),
      )
      .when(sfn.Condition.stringEquals(status, 'FAILED'), new sfn.Fail(this, 'TransferFailed', {
        error: 'TransferFailed',
        causePath: '$.poll.Results[0].FailureMessage',
      }))
      .otherwise(wait);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: props.stateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(start.next(wait).next(poll).next(evaluate)),
      timeout: Duration.minutes(15),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'Logs', {
          logGroupName: `/aws/vendedlogs/states/${props.stateMachineName}`,
          retention: logs.RetentionDays.THREE_MONTHS,
        }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
  }
}
```

### A2X outer state machine

`gm-prime-equities-a2x` is the diagram's outer Step Function. It resolves the business date, builds the remote path, then runs the A2X transfer instance and waits for it to finish.

```ts
const determineDate = new tasks.LambdaInvoke(this, 'DetermineDate', {
  lambdaFunction: equitiesDateFn,
  payloadResponseOnly: true,
  resultPath: '$.date',            // -> { businessDate: "YYYYMMDD" }
}).addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException'], jitterStrategy: sfn.JitterType.FULL });

const transfer = new tasks.StepFunctionsStartExecution(this, 'TransferA2xFile', {
  stateMachine: a2xRetrieve.stateMachine,
  integrationPattern: sfn.IntegrationPattern.RUN_JOB,   // wait for child to finish
  associateWithParent: true,
  input: sfn.TaskInput.fromObject({
    // e.g. cfg.a2x.remotePathTemplate = "/outbound/equities/EQ_REF_{}.csv"
    remoteFilePaths: sfn.JsonPath.array(
      sfn.JsonPath.format(cfg.a2x.remotePathTemplate, sfn.JsonPath.stringAt('$.date.businessDate')),
    ),
  }),
});

new sfn.StateMachine(this, 'A2xOuter', {
  stateMachineName: 'gm-prime-equities-a2x',
  definitionBody: sfn.DefinitionBody.fromChainable(determineDate.next(transfer)),
  timeout: Duration.minutes(20),
  tracingEnabled: true,
});
```

---

## 5. Date Lambda (TypeScript)

| Setting | Value |
| --- | --- |
| Name | `gm-prime-equities-date` |
| Runtime / arch | Node.js 24.x (latest LTS) / arm64 |
| Memory / timeout | 128 MB / 10 s |
| Packaging | `TypeScriptFunction` construct (wraps `NodejsFunction`: esbuild, minified, source maps) |
| Permissions | None beyond basic execution (logs) |

It returns the **SAST** date, not the UTC date. It also accepts an optional `businessDate` override so a missed day can be backfilled by starting the outer state machine with `{ "businessDate": "20261001" }`.

```ts
// src/lambdas/equities-date/index.ts
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'equities-date' });
const TIME_ZONE = 'Africa/Johannesburg';

export interface DateEvent { businessDate?: string }
export interface DateResult { businessDate: string }

export const toBusinessDate = (now: Date, timeZone = TIME_ZONE): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}${get('month')}${get('day')}`;
};

export const handler = async (event: DateEvent = {}): Promise<DateResult> => {
  if (event.businessDate !== undefined) {
    if (!/^\d{8}$/.test(event.businessDate)) throw new Error(`Invalid businessDate: ${event.businessDate}`);
    logger.info('Using businessDate override', { businessDate: event.businessDate });
    return { businessDate: event.businessDate };
  }
  const businessDate = toBusinessDate(new Date());
  logger.info('Resolved businessDate', { businessDate });
  return { businessDate };
};
```

For the override to reach the Lambda, the outer machine passes `$` as the payload. A plain scheduled run supplies `{}`.

```ts
// infra/lib/constructs/typescript-function.ts sets NODEJS_24_X, ARM_64, X-Ray, log group and esbuild options.
const equitiesDateFn = new TypeScriptFunction(this, 'EquitiesDate', {
  functionName: 'gm-prime-equities-date',
  sourceDir: 'equities-date',
  logRetention: config.logRetention,
});
```

---

## 6. EventBridge Scheduler

Two schedule groups, as in the diagram. Each schedule targets one state machine through a reusable `FeedSchedule` construct.

| Group | Schedule | Target | Expression (TZ `Africa/Johannesburg`) |
| --- | --- | --- | --- |
| `gm-prime-scheduler-group-sftp` | `gm-prime-equities-sftp-bda` | `gm-prime-equities-bda` | `cron(0/30 3-6 ? * MON-FRI *)` → 03:00, 03:30 … 06:30 |
| `gm-prime-scheduler-group-sftp` | `gm-prime-equities-sftp-market-data` | `gm-prime-equities-market-data` | _TBC_ (see [open questions](decisions.md#open-questions)) |
| `gm-prime-scheduler-group-sftp` | `gm-prime-equities-sftp-reference-data` | `gm-prime-equities-reference-data` | _TBC_ |
| `gm-prime-scheduler-group-sftp` | `gm-prime-equities-sftp-options-data` | `gm-prime-equities-options-data` | _TBC_ |
| `gm-prime-scheduler-group-a2x-sftp` | `gm-prime-equities-sftp-a2x` ¹ | `gm-prime-equities-a2x` | _TBC_ |

¹ The diagram names this schedule `gm-prime-equities-sftp-bda`, which is the same name as the JSE schedule. We treat that as a copy-paste error and propose `gm-prime-equities-sftp-a2x`. See [open questions](decisions.md#open-questions).

| Setting | Value |
| --- | --- |
| Flexible time window | Off (the times are business deadlines) |
| Target input | `{ "remoteFilePaths": [cfg.<feed>.remotePath] }`, which is where the "hardcoded" names live, in config |
| Retry policy | 3 attempts, max event age 1 hour |
| Dead-letter queue | One SQS queue per group, SSE, alarmed on depth > 0 |
| Execution role | Per schedule, `states:StartExecution` on its target machine only |
| State | `ENABLED` in all environments; can be switched through config (`cfg.<feed>.enabled`) |

```ts
const group = new scheduler.ScheduleGroup(this, 'SftpGroup', {
  scheduleGroupName: 'gm-prime-scheduler-group-sftp',
});

new scheduler.Schedule(this, 'BdaSchedule', {
  scheduleName: 'gm-prime-equities-sftp-bda',
  scheduleGroup: group,
  schedule: scheduler.ScheduleExpression.cron({
    minute: '0/30', hour: '3-6', weekDay: 'MON-FRI',
    timeZone: TimeZone.AFRICA_JOHANNESBURG,
  }),
  timeWindow: scheduler.TimeWindow.off(),
  enabled: cfg.bda.enabled,
  target: new schedulerTargets.StepFunctionsStartExecution(bda.stateMachine, {
    input: scheduler.ScheduleTargetInput.fromObject({ remoteFilePaths: [cfg.bda.remotePath] }),
    deadLetterQueue: sftpGroupDlq,
    retryAttempts: 3,
    maxEventAge: Duration.hours(1),
  }),
});
```

> If the Scheduler L2 constructs aren't available in the pinned `aws-cdk-lib` version, use `scheduler.CfnSchedule` with the same settings.

---

## 7. Shadow-Rename Lambda (Python)

**Purpose.** The JSE flows land files in `temp/`, and the bda feed re-downloads the same file every 30 minutes. Shadow-Rename stores a file in its parent folder as a new date-stamped copy only when its content is new, and discards duplicates. It never overwrites a file ([ADR-010](decisions.md#adr-010-shadow-rename-stores-date-stamped-copies-and-never-overwrites)).

| Setting | Value |
| --- | --- |
| Name | `Shadow-Rename` |
| Runtime / arch | Python 3.14 / arm64 |
| Memory / timeout | 512 MB / 5 min (resize after UAT file-size measurements) |
| Trigger | EventBridge rule: `aws.s3` `Object Created`, bucket = `prime-{env}-file-downloads`, key wildcard `jse/idp/*/temp/*` |
| Concurrency | Reserved concurrency **1**, which serialises processing so two copies of the same file can't race |
| Failure handling | EventBridge target retry (4 attempts, max age 2 h), then SQS DLQ |
| Permissions | `s3:ListBucket` on the bucket, `s3:GetObject` on `jse/idp/*`, `s3:PutObject` on `jse/idp/*`, `s3:DeleteObject` on `jse/idp/*/temp/*`, KMS decrypt and encrypt on `dataKey` |
| Packaging | `lambda.Function` with `pythonCode()` ([python-code.ts](../../infra/lib/constructs/python-code.ts)): local `pip install --platform manylinux2014_aarch64 --only-binary=:all:`, falling back to Docker only if no local Python is available ([ADR-008](decisions.md#adr-008-bundle-python-with-local-pip-not-docker)) |

**Algorithm** (the diagram's `lambda_handler` → `file_exists`):

1. Get `bucket` and `key` from the event. The key has the form `<folder>/temp/<name>`.
2. Stream the object and compute its md5. Don't use the S3 ETag: under SSE-KMS or multipart upload the ETag isn't the md5. Keep the object's `LastModified`, which is when the file was retrieved.
3. List the files directly inside `<folder>/` (not `temp/`) and read their `md5` user metadata with `HeadObject`, newest first, until one matches (that's `file_exists`). Files without `md5` metadata never match.
4. If a file matches: delete the temp object (duplicate).
5. Otherwise build the target key `<folder>/<stem>_<YYYYMMDDTHHMMSS><extension>` from the retrieval time in SAST, for example `jse/idp/bda/BDA_FILE_20261001T033012.csv`. If that key already exists, raise `FileExistsError` and leave everything in place. Otherwise copy temp → target with metadata `md5=<digest>` (`MetadataDirective=REPLACE`), then delete the temp object.
6. If the temp object is already gone (`NoSuchKey`), the event was redelivered and already handled. Log it and return success.

```python
# src/lambdas/shadow_rename/app.py (abridged)
SAST = timezone(timedelta(hours=2), "SAST")  # no daylight saving time (ADR-006), so no tz database is needed
STAMP_FORMAT = "%Y%m%dT%H%M%S"


def split_temp_key(temp_key: str) -> tuple[str, str]:
    """``jse/idp/bda/temp/FILE.csv`` -> ``("jse/idp/bda/", "FILE.csv")``."""
    folder, separator, name = temp_key.rpartition(TEMP_SEGMENT)
    if not separator or not name:
        raise ValueError(f"Key is not inside a temp/ folder: {temp_key}")
    return f"{folder}/", name


def target_key_for(temp_key: str, retrieved_at: datetime) -> str:
    folder, name = split_temp_key(temp_key)
    stem, extension = posixpath.splitext(name)
    return f"{folder}{stem}_{retrieved_at.astimezone(SAST).strftime(STAMP_FORMAT)}{extension}"


def file_exists(bucket: str, folder: str, md5: str) -> str | None:
    """Return the key of a file directly inside ``folder`` whose md5 matches, or None. Newest files first."""
    files = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=folder, Delimiter="/"):
        files.extend(page.get("Contents", []))
    for item in sorted(files, key=lambda f: f["LastModified"], reverse=True):
        if stored_md5(bucket, item["Key"]) == md5:
            return item["Key"]
    return None


@logger.inject_lambda_context
def lambda_handler(event, _context):
    bucket = event["detail"]["bucket"]["name"]
    temp_key = event["detail"]["object"]["key"]
    folder, _ = split_temp_key(temp_key)
    logger.append_keys(temp_key=temp_key)

    try:
        new_md5, retrieved_at = md5_of_object(bucket, temp_key)  # streamed, 8 MiB chunks
    except ClientError as err:
        if err.response["Error"]["Code"] in NOT_FOUND:
            logger.info("Temp object already processed", extra={"action": "noop"})
            return {"action": "noop"}
        raise

    duplicate_of = file_exists(bucket, folder, new_md5)
    if duplicate_of:
        s3.delete_object(Bucket=bucket, Key=temp_key)
        logger.info("Duplicate discarded", extra={"action": "discarded", "md5": new_md5, "duplicate_of": duplicate_of})
        return {"action": "discarded", "md5": new_md5, "duplicate_of": duplicate_of}

    target_key = target_key_for(temp_key, retrieved_at)
    try:
        s3.head_object(Bucket=bucket, Key=target_key)
    except ClientError as err:
        if err.response["Error"]["Code"] not in NOT_FOUND:
            raise
    else:
        raise FileExistsError(f"{target_key} already exists with different content; Shadow-Rename never overwrites")

    s3.copy(
        CopySource={"Bucket": bucket, "Key": temp_key},
        Bucket=bucket,
        Key=target_key,
        ExtraArgs={"Metadata": {MD5_METADATA_KEY: new_md5}, "MetadataDirective": "REPLACE"},
    )
    s3.delete_object(Bucket=bucket, Key=temp_key)
    logger.info("File promoted", extra={"action": "promoted", "md5": new_md5, "target_key": target_key})
    return {"action": "promoted", "md5": new_md5, "target_key": target_key}
```

> **Confirm during Phase 4** whether the object key in S3 EventBridge events arrives URL-encoded. If it does, apply `urllib.parse.unquote_plus`. Vendor file names without spaces or special characters avoid the issue.

```ts
const runtime = lambda.Runtime.PYTHON_3_14;
const shadowRename = new lambda.Function(this, 'ShadowRename', {
  functionName: 'Shadow-Rename',
  code: pythonCode(path.join(LAMBDA_SRC_DIR, 'shadow_rename'), runtime),
  handler: 'app.lambda_handler',
  runtime,
  architecture: lambda.Architecture.ARM_64,
  memorySize: 512,
  timeout: Duration.minutes(5),
  reservedConcurrentExecutions: 1,
  tracing: lambda.Tracing.ACTIVE,
  environment: { POWERTOOLS_LOG_LEVEL: 'INFO' },
  logGroup: new logs.LogGroup(this, 'ShadowRenameLogs', { retention: logs.RetentionDays.THREE_MONTHS }),
});
bucket.grantRead(shadowRename, 'jse/idp/*');
bucket.grantPut(shadowRename, 'jse/idp/*');
bucket.grantDelete(shadowRename, 'jse/idp/*/temp/*');

new events.Rule(this, 'JseTempObjectCreated', {
  eventPattern: {
    source: ['aws.s3'],
    detailType: ['Object Created'],
    detail: {
      bucket: { name: [bucket.bucketName] },
      object: { key: events.Match.wildcard('jse/idp/*/temp/*') },
    },
  },
  targets: [new eventsTargets.LambdaFunction(shadowRename, {
    deadLetterQueue: shadowRenameDlq,
    retryAttempts: 4,
    maxEventAge: Duration.hours(2),
  })],
});
```

---

## 8. Monitoring

Alarms, the dashboard and the "file not received" checks are specified in [observability-and-runbook.md](../operations/observability-and-runbook.md).
