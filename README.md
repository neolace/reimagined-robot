# reimagined-robot

## Documentation

Implementation docs, framed around the AWS Well-Architected Framework, are in [docs/](docs/README.md). They cover the delivery plan, component specs, ADRs, environments, testing and the runbook.

## Getting started

Everything is AWS CDK in TypeScript, except the `Shadow-Rename` Lambda, which is Python. Prerequisites: Node.js ≥ 22 and Python ≥ 3.13. Docker isn't needed.

```bash
npm ci
python -m venv .venv && .venv/Scripts/pip install -r src/lambdas/shadow_rename/requirements-dev.txt   # bin/ on macOS/Linux

npm run lint          # ESLint + Prettier
npm run build         # tsc --noEmit
npm test              # Jest: stack assertions, cdk-nag gate (dev/uat/prod), snapshots, TS Lambda tests
npm run test:python   # pytest for Shadow-Rename
npm run synth         # synthesizes Prime-dev, Prime-uat, Prime-prod
```

Before the first deploy to an environment, fill in every value marked `REPLACE_ME` in `infra/config/<env>.ts`: account ID, vendor SFTP URLs, host keys and remote paths. The account ID can also come from `PRIME_<ENV>_ACCOUNT`. Set the secret values out-of-band ([runbook](docs/operations/observability-and-runbook.md#rotating-vendor-credentials)). Deployment runs through GitHub Actions ([environments and deployment](docs/operations/environments-and-deployment.md#cicd-pipeline)).

## Architecture

Scheduled SFTP ingestion of equities data from A2X and JSE IDP into S3, with an md5-verified move out of the `temp/` staging folders.

### Components

- **EventBridge Scheduler groups**
  - `gm-prime-scheduler-group-a2x-sftp`: one schedule that runs Step Function `gm-prime-equities-a2x`. A Lambda (`gm-prime-equities-date`) works out today's date (`YYYYMMDD`), then a nested Step Function transfers the A2X file.
  - `gm-prime-scheduler-group-sftp`: four schedules (`bda`, `market-data`, `reference-data`, `options-data`), each running a Step Function that transfers a hardcoded file to a hardcoded folder. The `bda` schedule fires every 30 minutes from 03:00 to 06:30.
- **AWS Transfer Family**: A2X and JSE IDP SFTP connectors, each pulling from its SFTP server over port 22. Credentials come from AWS Secrets Manager.
- **S3 bucket `prime-dev-file-downloads`**
  - `/a2x/ftp/reference-data/equities/`
  - `/jse/idp/bda/`, `/jse/idp/market-data/equities/`, `/jse/idp/market-data/reference/`, `/jse/idp/market-data/options/`. JSE files land in each folder's `temp/` subfolder first.
- **Lambda `Shadow-Rename` (Python)**: `lambda_handler` → `file_exists`. Checks the md5 of each file that lands in a JSE `temp/` folder. If a file with that md5 already exists in the parent folder, it deletes the temp file. Otherwise it copies the file to the parent folder with a date-time stamp, for example `BDA_FILE_20261001T033012.csv`, then deletes it from `temp/`. It never overwrites a file.

### Diagram

```mermaid
flowchart LR
    %% ---------- External SFTP servers ----------
    subgraph EXT_A2X["A2X"]
        A2X_SFTP[("A2X SFTP Server<br/>port 22")]
    end
    subgraph EXT_JSE["JSE IDP"]
        JSE_SFTP[("JSE IDP SFTP Server<br/>port 22")]
    end

    %% ---------- Secrets ----------
    subgraph SM["AWS Secrets Manager"]
        SEC_A2X["A2X SFTP Secret"]
        SEC_JSE["JSE IDP SFTP Secret"]
    end

    %% ---------- Transfer Family ----------
    subgraph TF["AWS Transfer Family"]
        CONN_A2X["A2X SFTP Connector"]
        CONN_JSE["JSE IDP SFTP Connector"]
    end

    CONN_A2X -- "retrieve credentials" --> SEC_A2X
    CONN_JSE -- "retrieve credentials" --> SEC_JSE
    CONN_A2X -- "transfer over 22" --> A2X_SFTP
    CONN_JSE -- "transfer over 22" --> JSE_SFTP

    %% ---------- A2X scheduler ----------
    subgraph SG_A2X["EventBridge Scheduler Group: gm-prime-scheduler-group-a2x-sftp"]
        subgraph SCH_A2X["Schedule: gm-prime-equities-schedule-a2x-sftp"]
            CRON_A2X["Fires at 03:00, every 30 min<br/>until 06:30"]
            subgraph SF_A2X_OUTER["Step Function: gm-prime-equities-step-function-a2x-sftp"]
                subgraph L_DATE["Lambda: gm-prime-equities-date"]
                    DATE["Determine today's date<br/>YYYYMMDD"]
                end
                subgraph SF_A2X["Step Function: A2X"]
                    A2X_XFER["File name with today's date in YYYMMDD<br/> to hardcoded folder"]
                end
                DATE -- "YYYYMMDD" --> A2X_XFER
            end
            CRON_A2X --> DATE
        end
    end

    %% ---------- JSE scheduler ----------
    subgraph SG_JSE["EventBridge Scheduler Group: gm-prime-scheduler-group-sftp"]
        subgraph SCH_BDA["Schedule: gm-prime-equities-sftp-bda"]
            CRON_BDA["Fires at 03:00, every 30 min<br/>until 06:30"]
            SF_BDA["Step Function: gm-prime-equities-bda<br/>Transfer hardcoded file name to hardcoded folder"]
            CRON_BDA --> SF_BDA
        end
        subgraph SCH_MKT["Schedule: gm-prime-equities-sftp-market-data"]
            CRON_MKT["Fires at 03:00, every 30 min<br/>until 06:30"]
            SF_MKT["Step Function<br/>Transfer hardcoded file name to hardcoded folder"]
            CRON_MKT --> SF_MKT
        end
        subgraph SCH_REF["Schedule: gm-prime-equities-sftp-reference-data"]
            CRON_REF["Fires at 03:00, every 30 min<br/>until 06:30"]
            SF_REF["Step Function<br/>Transfer hardcoded file name to hardcoded folder"]
            CRON_REF --> SF_REF
        end
        subgraph SCH_OPT["Schedule: gm-prime-equities-sftp-options-data"]
            CRON_OPT["Fires at 03:00, every 30 min<br/>until 06:30"]
            SF_OPT["Step Function<br/>Transfer hardcoded file name to hardcoded folder"]
            CRON_OPT --> SF_OPT
        end
    end

    A2X_XFER --> CONN_A2X
    SF_BDA --> CONN_JSE
    SF_MKT --> CONN_JSE
    SF_REF --> CONN_JSE
    SF_OPT --> CONN_JSE

    %% ---------- S3: A2X ----------
    subgraph S3_A2X["AWS S3: prime-dev-file-downloads"]
        A2X_FOLDER["/a2x/ftp/reference-data/equities/"]
    end
    A2X_XFER --> A2X_FOLDER

    %% ---------- S3: JSE ----------
    subgraph S3_JSE["AWS S3: prime-dev-file-downloads"]
        subgraph F_BDA["/jse/idp/bda/"]
            T_BDA["temp/"]
        end
        subgraph F_MKT["/jse/idp/market-data/equities/"]
            T_MKT["temp/"]
        end
        subgraph F_REF["/jse/idp/market-data/reference/"]
            T_REF["temp/"]
        end
        subgraph F_OPT["/jse/idp/market-data/options/"]
            T_OPT["temp/"]
        end
    end

    SF_BDA --> T_BDA
    SF_MKT --> T_MKT
    SF_REF --> T_REF
    SF_OPT --> T_OPT

    %% ---------- Shadow-Rename Lambda ----------
    subgraph LAMBDA["AWS Lambda (Python): Shadow-Rename"]
        HANDLER["lambda_handler"]
        EXISTS["file_exists"]
        HANDLER --> EXISTS
    end

    EXISTS -. "check md5 for a match of file in temp folder" .-> T_BDA
    EXISTS -. "check md5 for a match of file in temp folder" .-> T_MKT
    EXISTS -. "check md5 for a match of file in temp folder" .-> T_REF
    EXISTS -. "check md5 for a match of file in temp folder" .-> T_OPT
    HANDLER -- "files moved / renamed after md5 check" --> F_BDA
    HANDLER -- "files moved / renamed after md5 check" --> F_MKT
    HANDLER -- "files moved / renamed after md5 check" --> F_REF
    HANDLER -- "files moved / renamed after md5 check" --> F_OPT

    %% ---------- Styling ----------
    classDef red fill:#2a1414,stroke:#e03131,color:#fff
    classDef green fill:#0f2a14,stroke:#2f9e44,color:#b2f2bb
    classDef blue fill:#14143a,stroke:#3b5bdb,color:#fff
    classDef orange fill:#2a1e0f,stroke:#f08c00,color:#ffd8a8
    classDef teal fill:#0f2a2a,stroke:#12b886,color:#c3fae8

    class SG_A2X,SCH_A2X,SF_A2X_OUTER,EXT_A2X,SM red
    class SG_JSE,SCH_BDA,SCH_MKT,SCH_REF,SCH_OPT,SF_A2X green
    class S3_A2X,S3_JSE,F_BDA,F_MKT,F_REF,F_OPT,EXT_JSE blue
    class LAMBDA,L_DATE orange
    class TF teal
```

### Open questions

- **Secret names**: the diagram uses the placeholders "A2X SFTP Secret" and "JSE IDP SFTP Secret".
- **A2X schedule name** (`gm-prime-equities-sftp-bda`): the source diagram gives the A2X schedule the same name as the JSE `bda` schedule. Probably a copy-paste error.
