# Observability and runbook

## Logging and tracing

| Source | Destination | Retention (dev/uat · prod) | Notes |
| --- | --- | --- | --- |
| State machines | `/aws/vendedlogs/states/<name>` | 30 · 90 days | Level `ERROR`, execution data excluded (paths only, no content) |
| Date Lambda | `/aws/lambda/gm-prime-equities-date` | 30 · 90 days | Powertools Logger (TS), JSON |
| Shadow-Rename | `/aws/lambda/gm-prime-equities-shadow-rename` | 30 · 90 days | Powertools Logger (Python), JSON; keys `temp_key`, `target_key`, `duplicate_of`, `md5`, `action` |
| Transfer connectors | `/aws/transfer/<connector-id>` | 30 · 90 days | Connection and transfer events |
| API activity | Organisation CloudTrail | Org policy | |

X-Ray tracing is enabled on the state machines and both Lambdas.

**Useful Logs Insights query** (what Shadow-Rename did today):

```text
fields @timestamp, action, temp_key, target_key, duplicate_of, md5
| filter ispresent(action)
| sort @timestamp desc
```

## Alarms

All alarms go to one SNS topic per environment, `prime-{env}-ingestion-alerts`, which is encrypted with `dataKey`. Subscribers are set in config. Use `treatMissingData: NOT_BREACHING` for every alarm.

| Alarm | Metric / source | Condition | Runbook |
| --- | --- | --- | --- |
| `<state-machine>-failed` (×6) | `AWS/States ExecutionsFailed` | ≥ 1 in 5 min | [Transfer failed](#transfer-failed) |
| `<state-machine>-timed-out` (×6) | `AWS/States ExecutionsTimedOut` | ≥ 1 in 5 min | [Transfer failed](#transfer-failed) |
| `equities-date-errors` | `AWS/Lambda Errors` | ≥ 1 in 5 min | [Transfer failed](#transfer-failed) |
| `shadow-rename-errors` | `AWS/Lambda Errors` | ≥ 1 in 5 min | [Messages in a DLQ](#messages-in-a-dlq) |
| `<dlq>-not-empty` (×3: two scheduler groups, Shadow-Rename) | `AWS/SQS ApproximateNumberOfMessagesVisible` | ≥ 1 | [Messages in a DLQ](#messages-in-a-dlq) |
| `connector-retrieve-failed` | EventBridge rule on `source: aws.transfer`, `detail-type: SFTP Connector File Retrieve Failed` → SNS | Any event | [Connector cannot connect](#connector-cannot-connect) |
| `file-not-received-<feed>` | Deadline check (below) | File missing at the deadline | [File not received by deadline](#file-not-received-by-deadline) |

### "File not received by deadline" check

CloudWatch alarms can't express "by 07:00 on a weekday", so a small **TypeScript** Lambda, `gm-prime-file-deadline-check`, runs on an EventBridge Scheduler cron at `cfg.fileDeadline` (default `cron(0 7 ? * MON-FRI *)`, `Africa/Johannesburg`). For each feed it checks the expected final key:

- JSE feeds: a copy stamped with today's SAST date must exist. It lists keys starting, for example, `jse/idp/bda/BDA_FILE_20261001T` ([ADR-010](../architecture/decisions.md#adr-010-shadow-rename-stores-date-stamped-copies-and-never-overwrites)).
- A2X: `HeadObject` on the date-stamped key for today's `businessDate`.

For each feed that's missing, it publishes to the alerts SNS topic and emits a `FileMissing` custom metric (dimension `Feed`).

> **Assumption:** each day's JSE file differs from every earlier file in its folder. If a feed can legitimately repeat earlier content, Shadow-Rename discards it as a duplicate, nothing is stamped with that day's date, and the check sends a false alert. In that case, have Shadow-Rename also write a small marker object for each day it sees the file.

## Dashboard

One CloudWatch dashboard per environment, `prime-{env}-sftp-ingestion`:

1. **Today at a glance:** a text widget with the feed schedule, plus an alarm status widget covering every alarm above.
2. **Executions per feed:** `ExecutionsStarted`, `ExecutionsSucceeded`, `ExecutionsFailed`, stacked by state machine.
3. **Shadow-Rename:** invocations, errors, duration p95, throttles, and a log widget showing `action` counts (promoted, discarded, noop).
4. **Queues:** DLQ depth for all three DLQs.
5. **Missing files:** `FileMissing` by `Feed`.

---

## Runbook

Every alarm links to one of these entries. Run all commands with the right environment's profile, for example `--profile prime-prod`.

### Transfer failed

**Symptom:** `<state-machine>-failed` or `-timed-out`.

1. Open the failed execution in the Step Functions console and read the `TransferFailed` cause (the `FailureMessage`).
2. Act on the cause:
   - **Auth or host key or connection errors:** go to [Connector cannot connect](#connector-cannot-connect).
   - **Permission denied writing to S3:** the connector access role or the KMS key policy changed. Check the last deploy (`cdk diff`) and CloudTrail for `AccessDenied`.
   - **Timed out:** check the Transfer Family service health and connector logs. A very large file might need a longer state machine timeout (a config change).
   - **Date Lambda error:** check its logs. Backfill with an override (see [Backfill a missed day](#backfill-a-missed-day)).
3. When the cause is fixed, rerun by hand (see [Backfill a missed day](#backfill-a-missed-day)) or wait for the next schedule tick.

### Connector cannot connect

```bash
aws transfer test-connection --connector-id <connector-id>
```

| `StatusMessage` points to | Likely cause | Fix |
| --- | --- | --- |
| Timeout / connection refused | Our egress IP isn't allowlisted, or the vendor is down | Get the IPs (`aws transfer describe-connector --connector-id <id>` → `ServiceManagedEgressIpAddresses`) and confirm with the vendor |
| Host key verification failed | The vendor rotated its host key | Get the new key **from the vendor out-of-band**, update `trustedHostKeys` in `infra/config/<env>.ts`, then deploy through the pipeline |
| Authentication failed | Credentials expired, rotated or revoked | See [Rotating vendor credentials](#rotating-vendor-credentials) |

### File not received by deadline

1. Check the feed's executions after the last schedule run. Were they all `FileNotAvailable`?
   - **Yes:** the vendor hasn't published. Contact the vendor. Once it's published, run the feed by hand.
   - **No, there were failures:** go to [Transfer failed](#transfer-failed).
2. If the file was retrieved but isn't in the parent folder, check whether it's still in `temp/`, and check the Shadow-Rename logs and DLQ.
3. If publish times keep drifting late, propose a schedule window change through config.

### Messages in a DLQ

- **Scheduler DLQs:** the scheduler couldn't start the state machine, usually because of IAM or a deleted target. Read the message attributes for the error, fix it, then run the feed by hand. Delete the messages once handled.
- **Shadow-Rename DLQ:** each message body is the original S3 EventBridge event.
  1. Find the error in the Shadow-Rename logs, using the `temp_key`.
  2. Fix the cause (for example permissions). A `FileExistsError` means a file with the same date-stamped name, but different content, is already in the parent folder. Shadow-Rename won't overwrite it, so find out where that file came from before you reprocess.
  3. Reprocess by invoking the Lambda with the event from the message (it's idempotent):

     ```bash
     aws lambda invoke --function-name gm-prime-equities-shadow-rename \
       --cli-binary-format raw-in-base64-out --payload file://event.json out.json
     ```

  4. Delete the DLQ message.

### Wrong file promoted

Shadow-Rename never overwrites, so the wrong file is its own date-stamped copy and the earlier copies are untouched. Wait until the vendor has fixed the file, or [pause ingestion](#pause-ingestion) first; otherwise the next pull stores the wrong file again. Then delete the wrong copy:

```bash
aws s3api list-objects-v2 --bucket gm-prime-equities-file-downloads-<env> --prefix jse/idp/bda/ --delimiter /
aws s3api delete-object --bucket gm-prime-equities-file-downloads-<env> --key jse/idp/bda/<name>_<YYYYMMDDTHHMMSS>.csv
```

S3 versioning keeps the deleted copy as a noncurrent version for 90 days. Tell the downstream consumers about the correction.

### Backfill a missed day

- **JSE feed:** start the state machine with the schedule's input:

  ```bash
  aws stepfunctions start-execution \
    --state-machine-arn arn:aws:states:<region>:<account>:stateMachine:gm-prime-equities-bda-daily \
    --input '{"remoteFilePaths":["/outbound/bda/BDA_FILE.csv"]}'
  ```

- **A2X:** start the outer machine with a date override:

  ```bash
  aws stepfunctions start-execution \
    --state-machine-arn arn:aws:states:<region>:<account>:stateMachine:gm-prime-equities-step-function-a2x-sftp \
    --input '{"businessDate":"20261001"}'
  ```

### Rotating vendor credentials

1. Agree a cut-over time with the vendor. Get the new credentials (or give them a new public key) through a secure channel.
2. Write the new value. The connector reads the secret each time it connects, so no deploy is needed.

   ```bash
   aws secretsmanager put-secret-value --secret-id prime/<env>/sftp/jse-idp \
     --secret-string file://new-secret.json   # {"Username": "...", "PrivateKey": "..."}
   rm new-secret.json
   ```

3. Run `aws transfer test-connection --connector-id <id>` and expect `OK`.
4. If it fails, restore the previous version (`aws secretsmanager update-secret-version-stage` back to `AWSPREVIOUS`) and contact the vendor.

### Pause ingestion

- **Planned:** set `enabled: false` for the feed in `infra/config/<env>.ts` and deploy.
- **Emergency:** run `aws scheduler update-schedule` with `--state DISABLED`. Include the existing schedule fields: `update-schedule` replaces the whole definition, so get it first with `get-schedule`. Then make the matching config change so the next deploy doesn't re-enable it.
