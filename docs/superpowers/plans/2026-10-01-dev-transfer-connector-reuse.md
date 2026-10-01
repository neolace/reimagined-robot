# Reuse Existing Transfer Family Connectors in Dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the dev stage to use its already-created JSE and A2X Transfer Family connectors without provisioning duplicate connectors, while preserving connector provisioning in uat and prod.

**Architecture:** Model vendor connectivity as a discriminated configuration: an existing `connectorId`, or a remote `sftpUrl` with pinned `trustedHostKeys`. Normalize both choices into a small connector reference carrying an ID and ARN so the retrieval state machines and their IAM policies do not depend on whether the connector was imported or created. For the imported dev connectors, leave connector-side roles and S3 access external to this stack.

**Tech Stack:** AWS CDK v2, TypeScript, Jest, CDK assertions, Prettier.

## Global Constraints

- The supplied dev IDs are JSE `c-sadfsdfsdfsd` and A2X `c-dsfgdsfgsdf`.
- These IDs apply only to dev in `af-south-1`; uat and prod keep their existing endpoint/host-key provisioning path.
- Existing connector roles already have the S3 access required by this app; do not modify or recreate them.
- Retrieval state machine behavior, schedules, file-not-found handling, and S3 paths remain unchanged.
- Do not query or modify live AWS resources.

---

## File Map

- `infra/config/types.ts`: express imported connector IDs versus endpoint/host-key configuration.
- `infra/config/dev.ts`: configure the supplied dev connector IDs and remove the placeholder remote endpoint and host keys for JSE/A2X.
- `infra/lib/stacks/transfer-stack.ts`: conditionally import existing connector references or provision connector-side resources for endpoint configurations.
- `infra/lib/stacks/orchestration-stack.ts`: pass normalized connector references through to retrieval constructs.
- `infra/lib/constructs/retrieve-file-state-machine.ts`: consume the normalized ID/ARN interface for task parameters and IAM scoping.
- `infra/lib/stage.ts`: omit the Transfer stack when both connectors are imported and create their references for orchestration.
- `test/helpers.ts`: represent the absent dev Transfer stack as an empty assertion template.
- `test/transfer-stack.test.ts`: use isolated TransferStack and RetrieveFileStateMachine constructs to assert imported dev IDs and connector ARNs appear in task definitions and generated IAM policies.
- `test/transfer-stack.test.ts`: retain connector creation and supporting-resource assertions using uat config.
- `docs/architecture/component-specs.md`: document imported dev connectors and the provisioning path retained for uat/prod.

## Task 1: Support Imported Connector References

**Files:** The files in the map above.

**Interfaces:**
- `VendorConfig` is a discriminated union with either `connectorId: string` or `sftpUrl: string` plus `trustedHostKeys: string[]`, and always includes `fileNotFoundFailureCode`.
- A normalized connector reference exposes `connectorId: string` and `connectorArn: string`. Both imported and newly created connectors satisfy this interface.
- Retrieval state machines use the normalized connector reference and retain connector-scoped `transfer:StartFileTransfer` and `transfer:ListFileTransferResults` permissions.

- [ ] **Step 1: Add failing dev-import assertions**

Update `test/transfer-stack.test.ts` so tests for connector creation use `uatConfig`, and add dev assertions that `AWS::Transfer::Connector`, `AWS::SecretsManager::Secret`, and connector-specific `AWS::IAM::Role` resources are absent. In the same test, construct retrieval state machines using the dev connector references and assert their task definitions contain IDs `c-sadfsdfsdfsd` and `c-dsfgdsfgsdf`, and their generated IAM policies scope transfer actions to those connector ARNs.

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

Run:

```powershell
npx jest --runInBand test/transfer-stack.test.ts
```

Expected: the new dev-import assertions fail because the current dev configuration still provisions connectors from endpoint values.

- [ ] **Step 3: Add the configuration union and dev IDs**

In `infra/config/types.ts`, split vendor connection settings into the imported-ID form and the endpoint/host-key form while retaining `fileNotFoundFailureCode`. In `infra/config/dev.ts`, replace the `sftpUrl` and `trustedHostKeys` entries for JSE and A2X with the IDs supplied above. Keep `uat.ts` and `prod.ts` on the endpoint form.

- [ ] **Step 4: Normalize imported and provisioned connector references**

In `infra/lib/stacks/transfer-stack.ts`, create a small connector reference interface with `connectorId` and `connectorArn`. For a configured `connectorId`, create a reference using that ID and the stack-formatted Transfer connector ARN; do not create connector, secret, role, logging, or egress-output resources for that vendor. For endpoint/host-key config, retain the existing provisioning behavior and return its `attrConnectorId` and `attrArn`. Create the shared connector logging role only if at least one connector is provisioned. In `infra/lib/stage.ts`, omit the Transfer stack entirely when both vendors use existing connector IDs, and derive references from the storage stack's environment. Update `test/helpers.ts` to provide an empty assertion template when that stack is absent.

Change `OrchestrationStackProps` and `RetrieveFileStateMachineProps` to accept the normalized reference instead of `transfer.CfnConnector`. Use the reference ID and ARN in both transfer API tasks and their IAM resource lists.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```powershell
npx jest --runInBand test/transfer-stack.test.ts
```

Expected: imported dev IDs and ARNs are present in retrieval task definitions and IAM policies; dev has no Transfer connector, secret, or connector roles; uat connector provisioning assertions pass.

- [ ] **Step 6: Update the component specification**

Revise the Transfer Family section in `docs/architecture/component-specs.md` to document that dev references pre-existing connectors, while uat/prod continue provisioning connectors and associated secrets and roles from vendor endpoint configuration. State that external connector roles must grant the configured S3 prefix permissions.

- [ ] **Step 7: Run repository checks**

Run:

```powershell
npm run build
npm test -- --runInBand
npm run lint
```

Expected: TypeScript compilation, Jest tests, and ESLint/Prettier checks pass. Update snapshots only if the tests demonstrate a legitimate prod template change; prod behavior is intended to remain unchanged.
