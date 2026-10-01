# Testing strategy

Tests are **TypeScript (Jest)** for everything except the Shadow-Rename Lambda, which is tested with **pytest**. All unit and static checks run in CI on every pull request ([pipeline](environments-and-deployment.md#cicd-pipeline)).

| Layer | Tooling | Runs | Covers |
| --- | --- | --- | --- |
| Static analysis | ESLint, Prettier, `tsc`, ruff, cdk-nag | Every PR | Style, types, security rules for the infrastructure |
| Infrastructure unit | Jest + `aws-cdk-lib/assertions` | Every PR | Resource properties, IAM scope, wiring |
| Infrastructure snapshot | Jest snapshots of the synthesized templates | Every PR | Unintended changes to the infrastructure |
| Lambda unit (TS) | Jest | Every PR | Date Lambda |
| Lambda unit (Python) | pytest + moto | Every PR | Shadow-Rename |
| Integration | Deployed dev stack + mock SFTP server | After deploy to dev | End-to-end retrieval and promotion |
| UAT | Vendor UAT endpoints | Phase 7, before prod | Real files, real timings |

## Static analysis

- `cdk-nag` v3 runs as a policy-validation plugin on every stage (`AwsSolutionsPlugin` in `infra/lib/nag.ts`, see [ADR-009](../architecture/decisions.md#adr-009-cdk-nag-v3-as-a-validation-plugin-with-base-rule-acknowledgements)).
- `test/nag.test.ts` fails if any environment has an unacknowledged violation. CI also fails if `cdk.out/validation-report.json` lists any violation.
- Acknowledgements must be scoped to the narrowest construct and give a written `reason`. Never acknowledge app-wide.

```ts
acknowledge(accessRole, [
  { id: 'AwsSolutions-IAM5', reason: 'Object wildcard limited to jse/idp/*/temp/*; KMS data-key actions require a wildcard suffix.' },
]);
```

## Infrastructure unit tests (Jest)

Assert the properties that matter for security and reliability, not every property.

```ts
// test/storage-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../infra/lib/stacks/storage-stack';
import { devConfig } from '../infra/config/dev';

describe('StorageStack', () => {
  const template = Template.fromStack(new StorageStack(new App(), 'Storage', { config: devConfig }));

  test('bucket is KMS-encrypted, versioned and EventBridge-enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'prime-dev-file-downloads',
      VersioningConfiguration: { Status: 'Enabled' },
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: Match.anyValue() } }),
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  test('bucket policy denies non-TLS access', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });
});
```

**Tests to have for each stack:**

| Stack | Assertions |
| --- | --- |
| Storage | Encryption, versioning, BPA, TLS-only, lifecycle rules for each `temp/` prefix, `DeletionPolicy: Retain` |
| Transfer | Connector has `TrustedHostKeys` and `UserSecretId`; the access role trust has `aws:SourceAccount`; S3 permissions limited to the landing prefix |
| Orchestration | Five retrieve state machines with the expected names; bda schedule expression `cron(0/30 3-6 ? * MON-FRI *)` with timezone `Africa/Johannesburg`; flexible window `OFF`; DLQ attached; each scheduler role can start only its own machine |
| Processing | Rule pattern uses the wildcard `jse/idp/*/temp/*`; Lambda reserved concurrency = 1; DLQ on the target |
| Monitoring | An alarm exists for each state machine and Lambda; alarm actions point at the SNS topic |

Keep **snapshot tests** (`expect(template.toJSON()).toMatchSnapshot()`) for each stack. Reviewers must look at snapshot diffs in PRs.

## Lambda unit tests

### TypeScript: date Lambda

```ts
// test/equities-date.test.ts
import { handler, toBusinessDate } from '../src/lambdas/equities-date';

describe('toBusinessDate', () => {
  test('uses SAST, not UTC, across midnight', () => {
    // 22:30 UTC on 30 Sep = 00:30 SAST on 1 Oct
    expect(toBusinessDate(new Date('2026-09-30T22:30:00Z'))).toBe('20261001');
  });
  test('same day during business hours', () => {
    expect(toBusinessDate(new Date('2026-10-01T03:00:00Z'))).toBe('20261001');
  });
});

describe('handler', () => {
  test('honours a valid businessDate override', async () => {
    await expect(handler({ businessDate: '20260102' })).resolves.toEqual({ businessDate: '20260102' });
  });
  test('rejects a malformed override', async () => {
    await expect(handler({ businessDate: '2026-01-02' })).rejects.toThrow('Invalid businessDate');
  });
});
```

### Python: Shadow-Rename

Use `moto`'s `mock_aws` with a versioned bucket. Each test drops an object into `temp/` and calls `lambda_handler` with an EventBridge-shaped event.

| Test | Given | Expect |
| --- | --- | --- |
| `test_new_file_promoted` | Nothing in the parent folder | Parent object created with `md5` metadata; temp deleted; `action == "promoted"` |
| `test_duplicate_discarded` | Parent has the same content and `md5` | Parent unchanged (same VersionId); temp deleted; `action == "discarded"` |
| `test_changed_file_replaces` | Parent has different content | New parent version with the new `md5`; old version kept; temp deleted |
| `test_redelivered_event_is_noop` | Temp already deleted | No exception; `action == "noop"` |
| `test_nested_market_data_path` | Key `jse/idp/market-data/options/temp/f.csv` | Target is `jse/idp/market-data/options/f.csv` |
| `test_large_file_streams` | 50 MiB object | md5 correct; memory not exhausted |
| `test_unexpected_s3_error_raises` | `head_object` returns AccessDenied | Exception propagates, so EventBridge retries and the DLQ catches it |

```python
# src/lambdas/shadow_rename/tests/conftest.py
import boto3
import pytest
from moto import mock_aws

BUCKET = "prime-test-file-downloads"


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name="af-south-1")
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "af-south-1"})
        client.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        yield client


def s3_event(key: str) -> dict:
    return {"detail-type": "Object Created", "source": "aws.s3",
            "detail": {"bucket": {"name": BUCKET}, "object": {"key": key}}}
```

The `app` module creates its boto3 client at import time, so import it **inside** each test (or a fixture), after `mock_aws` is active.

## Integration tests

Run these against the **deployed dev stack** after each dev deployment.

- **SFTP target.** Use a mock SFTP server that we control in dev, such as an `atmoz/sftp` container on a small, separate, locked-down host, or a Transfer Family *server* in a sandbox account. That way tests don't depend on vendor availability. Point the dev connector at it through config.
- **Test runner.** A Jest suite (`test/integration/*.int.test.ts`) using the AWS SDK v3, tagged so it doesn't run in the unit stage:
  1. Upload a fixture file to the mock SFTP server.
  2. `StartExecution` on `gm-prime-equities-bda` and wait for `SUCCEEDED`.
  3. Poll S3 until `jse/idp/bda/<file>` exists with the expected `md5` metadata and `temp/` is empty.
  4. Run the same steps again, and check the parent object's VersionId is unchanged (duplicate discarded).
  5. Change the fixture and repeat; check a new version is promoted.
  6. Start the machine with a non-existent path and check it ends in `FileNotAvailable`.

## UAT checklist

Run this in **uat** against the vendors' UAT endpoints for at least 5 business days.

- [ ] Every feed retrieves its file at the scheduled time, every business day.
- [ ] The bda polling window catches the file; record the actual publish times.
- [ ] Repeated bda pulls produce exactly one promoted file a day (no duplicates in the parent folder).
- [ ] The A2X file name resolves to the correct SAST date.
- [ ] Each alarm is forced at least once (bad path, revoked secret, disabled IP) and reaches the right recipients.
- [ ] Shadow-Rename duration and memory measured against the largest real file. Memory and timeout adjusted.
- [ ] The runbook was followed by someone outside the build team for at least one simulated incident.
- [ ] Downstream consumers confirm the file locations and formats.
