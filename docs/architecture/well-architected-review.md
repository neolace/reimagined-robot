# Well-Architected review

This review checks the SFTP ingestion design against the six pillars of the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html). For each pillar it lists the **controls built into the design**, with links to where they're specified, and the **risks we accept**. Repeat the review at the Phase 7 gate in the [implementation plan](../implementation-plan.md#phase-7-uat-sign-off-and-production-rollout) and record it in the AWS Well-Architected Tool if your organisation uses it.

Status key: ✅ designed in · ⚠️ partially addressed or depends on an open question · ⛔ accepted risk

---

## Operational Excellence

*Run and monitor systems to deliver business value, and keep improving processes and procedures.*

| Practice | Control | Status |
| --- | --- | --- |
| Everything as code | All infrastructure in AWS CDK (TypeScript); no console changes. Drift detected by `cdk diff` in the pipeline. | ✅ |
| Small, reversible changes | PR-based workflow; dev deploys automatically, uat and prod behind manual approvals ([deployment](../operations/environments-and-deployment.md#cicd-pipeline)) | ✅ |
| Observability | Structured JSON logs (Powertools), X-Ray tracing, a CloudWatch dashboard for each environment ([observability](../operations/observability-and-runbook.md)) | ✅ |
| Runbooks | One runbook entry per alarm ([runbook](../operations/observability-and-runbook.md#runbook)) | ✅ |
| Learn from failure | Post-incident review template; alarms tuned after hypercare | ⚠️ process to be agreed with the support team |
| Hardcoded file names | Kept in typed config (`infra/config/*.ts`), not in state machine code, so changing a name is a reviewed config change | ✅ |

## Security

*Protect data, systems and assets using cloud security.*

| Practice | Control | Status |
| --- | --- | --- |
| Identity and least privilege | A separate IAM role per connector, per schedule, per state machine and per Lambda, scoped to specific prefixes and ARNs ([specs](component-specs.md)). No wildcard actions. | ✅ |
| Strong authentication to vendors | SSH key auth preferred; credentials only in Secrets Manager, set out-of-band, never in the repo or templates | ✅ |
| Server identity | `TrustedHostKeys` pinned from values the vendor supplies (no trust-on-first-use) | ✅ |
| Encryption at rest | One customer-managed KMS key with rotation for S3 and secrets; S3 Bucket Keys | ✅ |
| Encryption in transit | SFTP (SSH) to vendors; S3 bucket policy denies non-TLS requests | ✅ |
| Network exposure | No inbound endpoints at all: the connectors make outbound calls only. Vendors allowlist our static egress IPs. | ✅ |
| Detection | CloudTrail (organisation trail), connector logs in CloudWatch, GuardDuty S3 protection (org-level) | ⚠️ depends on the org baseline |
| Automated guardrails | `cdk-nag` `AwsSolutionsChecks` in CI; suppressions need a written reason | ✅ |
| Environment isolation | A separate AWS account per environment | ✅ |
| Credential rotation | Manual, coordinated with the vendor ([runbook](../operations/observability-and-runbook.md#rotating-vendor-credentials)) | ⛔ automatic rotation isn't possible without vendor API support |

## Reliability

*Perform the intended function correctly and consistently, and recover quickly from failure.*

| Practice | Control | Status |
| --- | --- | --- |
| Managed, highly available services | Scheduler, Step Functions, Transfer Family, Lambda, S3 and EventBridge are all regional, multi-AZ managed services | ✅ |
| Retry with backoff and jitter | SDK tasks retry throttling and 5xx errors with exponential backoff and full jitter; Scheduler and EventBridge targets have retry policies | ✅ |
| No silent loss | DLQs on both scheduler groups and the Shadow-Rename trigger, alarmed on depth > 0 | ✅ |
| Expected "not yet published" | `FileNotAvailable` is a success outcome; the next schedule tick retries. A missing file by the deadline raises a separate alarm. | ✅ |
| Idempotency | Shadow-Rename is safe to rerun (it handles `NoSuchKey` and compares md5 before acting); retrievals overwrite the same `temp/` key | ✅ |
| Concurrency safety | Shadow-Rename reserved concurrency = 1 | ✅ |
| Data recovery | S3 versioning (90-day noncurrent retention); the vendor is the source of record and can be pulled again | ✅ |
| Backfill | Date Lambda accepts a `businessDate` override; JSE state machines can be started by hand with any input | ✅ |
| Regional failure | Single region | ⛔ accepted. The vendors are the source of truth, so after a regional outage the files can be pulled again. Multi-region isn't justified. |
| Vendor-side failure (host key rotation, IP change) | Alarm on connector failure; runbook procedure | ⚠️ depends on vendor notice periods |

## Performance Efficiency

*Use resources efficiently as demand changes.*

| Practice | Control | Status |
| --- | --- | --- |
| Serverless first | No servers or containers to size; the connectors scale with the service | ✅ |
| Right-sized compute | Date Lambda 128 MB; Shadow-Rename sized from real file sizes measured in UAT; arm64 (Graviton) | ⚠️ final sizing after UAT |
| Efficient processing | Streamed md5 in 8 MiB chunks (memory stays flat whatever the file size); managed multipart copy | ✅ |
| Polling cost and latency | A 30-second poll interval balances the number of state transitions against detection delay | ✅ |

## Cost Optimization

*Deliver business value at the lowest price point.*

| Practice | Control | Status |
| --- | --- | --- |
| Pay per use | Connectors are charged per call and per GB transferred; there's no always-on Transfer Family server endpoint | ✅ |
| Storage lifecycle | `temp/` expires after 7 days; noncurrent versions after 90 days; incomplete multipart uploads aborted after 1 day | ✅ |
| KMS request cost | S3 Bucket Keys enabled | ✅ |
| Workflow type | Standard Workflows: about 30 executions a day × about 10 transitions each is well under the free tier and costs pennies. Express Workflows would save nothing worth having and lose the execution history. | ✅ |
| Cost allocation | Tags `Project`, `Environment`, `Owner`, `CostCentre` applied app-wide; a budget alarm per account | ✅ |
| Log retention | Explicit retention on every log group (30 days dev and uat, 90 days prod) | ✅ |

## Sustainability

*Minimise the environmental impact of running cloud workloads.*

| Practice | Control | Status |
| --- | --- | --- |
| No idle capacity | Fully event- and schedule-driven; nothing runs between invocations | ✅ |
| Efficient hardware | arm64 (Graviton) Lambdas | ✅ |
| Less data stored and moved | Duplicates discarded instead of stored; lifecycle expiry; only the required files retrieved | ✅ |
| Matching schedules to demand | The bda polling window is limited to 03:00–06:30 on weekdays, and should be narrowed once publication times are known from UAT data | ⚠️ |

---

## High-risk issues to track

| ID | Issue | Pillar | Plan |
| --- | --- | --- | --- |
| HRI-1 | Host key or IP changes at the vendor break ingestion without warning | Reliability | Agree a notice period with each vendor; alarm and runbook in place |
| HRI-2 | Credential rotation is manual | Security | Agree a rotation interval with each vendor and set a shared calendar reminder; the runbook covers the swap |
| HRI-3 | Schedules for market-data, reference-data, options-data and A2X not yet defined | Operational Excellence | Resolve in Phase 0 ([open questions](decisions.md#open-questions)) |
