# Decisions and open questions

These are lightweight architecture decision records (ADRs). Add a new ADR for any decision that changes the design. Don't edit an accepted ADR; supersede it with a new one.

## ADR-001: AWS CDK in TypeScript; Python only for Shadow-Rename

- **Status:** Accepted
- **Context:** We need IaC for dev, uat and prod, and a single language for most of the codebase. The diagram specifies the Shadow-Rename Lambda as Python.
- **Decision:** The CDK app, the date Lambda, tests and tooling are in **TypeScript**. **Shadow-Rename stays Python** (`src/lambdas/shadow_rename/`). No other Python is added.
- **Consequences:**
  - CI needs both Node.js and Python toolchains. Docker isn't needed ([ADR-008](#adr-008-bundle-python-with-local-pip-not-docker)).
  - There are two test runners (Jest and pytest).
  - Everyone works in one CDK language, with typed config and constructs.

## ADR-002: One reusable retrieve-file state machine construct

- **Status:** Accepted
- **Context:** The diagram shows five Step Functions that all "transfer hardcoded file name to hardcoded folder".
- **Decision:** Build one `RetrieveFileStateMachine` construct and instantiate it once per feed, keeping the diagram's names. Remote paths come from schedule input; local paths come from construct props.
- **Consequences:** Retry, polling and error logic is defined once. Each feed still has its own state machine, so it has separate metrics, alarms and execution history.

## ADR-003: Standard Workflows for retrieval

- **Status:** Accepted
- **Context:** `StartFileTransfer` is asynchronous, so the state machine has to poll for the result.
- **Decision:** Use **Standard** workflows with a 30 s `Wait` and `ListFileTransferResults` loop and a 15-minute timeout.
- **Consequences:** We get full execution history for support, and the cost is negligible at this volume ([cost](well-architected-review.md#cost-optimization)). Alternative considered: react to Transfer Family's connector EventBridge events instead of polling. That's more decoupled, but the result correlation is harder to follow. Revisit it if volume grows.

## ADR-004: Shadow-Rename triggered by S3 → EventBridge

- **Status:** Accepted
- **Context:** The diagram doesn't say what triggers Shadow-Rename.
- **Decision:** Enable EventBridge notifications on the bucket and use one rule with key wildcard `jse/idp/*/temp/*`.
- **Consequences:**
  - One rule covers all four JSE feeds, including the nested `market-data/*` folders. Plain S3 notifications would need a prefix per feed.
  - There's no recursion risk because the Lambda writes outside `temp/`.
  - We get a built-in retry policy and a DLQ.

## ADR-005: Compute md5 by streaming instead of using the ETag

- **Status:** Accepted
- **Context:** The bucket uses SSE-KMS, and the connector may use multipart upload. In both cases the S3 ETag isn't the md5 of the content.
- **Decision:** Shadow-Rename streams the object and computes the md5 itself. It stores the digest as `md5` user metadata on the promoted object, so later comparisons only hash the new file.
- **Consequences:** The Lambda reads every staged file once. That's acceptable at this volume. S3 additional checksums (SHA-256 / CRC) are an option if the connector starts supplying them.

## ADR-006: Africa/Johannesburg for all times and business dates

- **Status:** Accepted
- **Decision:** Scheduler expressions use timezone `Africa/Johannesburg`, and the date Lambda formats the date in that zone.
- **Consequences:** The business date and the run times match JSE local time. SAST has no daylight saving time, so there are no DST edge cases.

## ADR-007: Separate AWS account per environment

- **Status:** Proposed. Confirm with the platform team.
- **Decision:** dev, uat and prod each run in their own account, deployed from a tooling/CI account.
- **Consequences:**
  - Strong blast-radius isolation.
  - Resource names (other than the globally unique bucket) can match the diagram exactly in every environment.
  - Each environment has its own connector IPs to allowlist.

## ADR-008: Bundle Python with local pip, not Docker

- **Status:** Accepted
- **Context:** `@aws-cdk/aws-lambda-python-alpha` `PythonFunction` always bundles inside Docker. That makes Docker a hard requirement for every `cdk synth`, both on developer machines and in CI, and it's an alpha module.
- **Decision:** Package Shadow-Rename with `lambda.Code.fromAsset` and a local bundler, `pythonCode()` in `infra/lib/constructs/python-code.ts`. It runs `pip install --platform manylinux2014_aarch64 --implementation cp --python-version <runtime> --only-binary=:all:` and falls back to the SAM build image only when no local Python is available.
- **Consequences:**
  - No Docker needed.
  - Only wheels are allowed, which is fine for `aws-lambda-powertools` (pure Python) and keeps builds reproducible.
  - A future dependency without an aarch64 wheel would fail the local bundle and use the Docker fallback.

## ADR-009: cdk-nag v3 as a validation plugin, with base-rule acknowledgements

- **Status:** Accepted
- **Context:** cdk-nag v3 runs as a CDK policy-validation plugin, and acknowledgements use `Validations.of(construct).acknowledge()`. Granular rules such as `AwsSolutions-IAM5` only match exact finding IDs, which embed CloudFormation export tokens that differ in every environment.
- **Decision:** `AwsSolutionsPlugin` (`infra/lib/nag.ts`) wraps `AwsSolutionsChecks`. Acknowledging the base rule on a construct covers all of that rule's findings on the construct and its children, the same as cdk-nag v2 without `appliesTo`. Each acknowledgement is scoped to the narrowest construct and carries a written reason.
- **Consequences:** `test/nag.test.ts` fails the build if dev, uat or prod has any unacknowledged violation, and CI also checks `cdk.out/validation-report.json`.

## ADR-010: Shadow-Rename stores date-stamped copies and never overwrites

- **Status:** Accepted. Answers open question Q6.
- **Context:** The first design overwrote the file in the parent folder in place, and S3 versioning kept the history.
- **Decision:** Shadow-Rename never overwrites a file. If a file in the parent folder already has the new file's md5 (its `md5` metadata), the temp file is deleted. Otherwise the temp file is copied to the parent folder as `<name>_<YYYYMMDDTHHMMSS><extension>`, stamped with the time it was retrieved in SAST (for example `BDA_FILE_20261001T033012.csv`), and then deleted from `temp/`. If a file with that name already exists, the Lambda raises an error instead of copying.
- **Consequences:**
  - Every content change adds a file, and existing files never change. History no longer depends on S3 versioning.
  - Consumers read the newest stamped file in a folder instead of a fixed file name.
  - Content that changes back to an earlier version is discarded as a duplicate, because its md5 is already in the folder.
  - The duplicate check reads the `md5` metadata of the files in the parent folder, newest first. A repeated download matches on the first read; a new file reads every stored copy.
  - The 07:00 deadline check looks for a copy stamped with today's date, not a fixed file modified today.

---

## Open questions

| # | Question | Default if not answered | Blocks |
| --- | --- | --- | --- |
| Q1 | Which AWS region? Are Transfer Family SFTP connectors and EventBridge Scheduler supported there? | `af-south-1`; fall back to `eu-west-1` if a service is missing | Phase 1 |
| Q2 | Exact remote paths and file-name patterns for each feed, including the A2X date format in the name | Placeholders in config | Phase 3, Phase 5 |
| Q3 | Schedules for market-data, reference-data, options-data and A2X | Same window as bda | Phase 3, Phase 5 |
| Q4 | Weekdays only, or also weekends and JSE public holidays? | `MON-FRI`; holidays not handled (runs end in `FileNotAvailable`) | Phase 3 |
| Q5 | The A2X schedule is named `gm-prime-equities-sftp-a2x` in the diagram, the same as the JSE one. Is that intended? | Rename to `gm-prime-equities-sftp-a2x` | Phase 5 |
| Q8 | Secret names in the original diagram (unreadable) | `prime/{env}/sftp/a2x`, `prime/{env}/sftp/jse-idp` | Phase 2 |
| Q9 | Deadline for each feed after which a missing file is an incident | 07:00 SAST | Phase 6 |
