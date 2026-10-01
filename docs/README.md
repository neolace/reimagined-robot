# Documentation

These docs describe how to build the SFTP ingestion platform shown in the [root README](../README.md#architecture). It pulls equities files from **A2X** and **JSE IDP** into S3 on a schedule, then de-duplicates them and promotes them out of the `temp/` staging folders.

The design follows the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html). Everything is built with **AWS CDK in TypeScript**. The only exception is the `Shadow-Rename` Lambda, which is written in **Python**.

## Reading order

| # | Document | Read it when |
| --- | --- | --- |
| 1 | [Implementation plan](implementation-plan.md) | You need the delivery phases, tasks, acceptance criteria and repo layout |
| 2 | [Component specifications](architecture/component-specs.md) | You're building a specific resource and need its config, IAM and CDK code |
| 3 | [Well-Architected review](architecture/well-architected-review.md) | You need to justify or check a design choice against the six pillars |
| 4 | [Decisions and open questions](architecture/decisions.md) | You want to know why something is the way it is, or what's still unresolved |
| 5 | [Environments and deployment](operations/environments-and-deployment.md) | You're setting up accounts, CI/CD or promoting dev → uat → prod |
| 6 | [Testing strategy](operations/testing-strategy.md) | You're writing tests or wiring CI quality gates |
| 7 | [Observability and runbook](operations/observability-and-runbook.md) | You're on support, or adding alarms and dashboards |

## Conventions

- **Names:** resources keep the names in the diagram and add an environment suffix where they have to be unique per account or globally, for example `prime-{env}-file-downloads`.
- **Region:** `af-south-1` (Cape Town) is assumed because the data sources are South African. This is listed as an open question in [decisions](architecture/decisions.md#open-questions).
- **Timezone:** all schedules and business dates use `Africa/Johannesburg` (SAST, UTC+2, no DST).
- **Languages:** TypeScript for the CDK app, the date Lambda, tests and tooling. Python only for `src/lambdas/shadow_rename/`.
