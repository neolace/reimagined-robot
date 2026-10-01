# Reuse Existing Transfer Family Connectors in Dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the dev stage to use its existing JSE and A2X Transfer Family connectors without provisioning duplicate connector resources, while preserving uat and prod provisioning.

**Architecture:** Represent each vendor connection as either an existing connector ID or endpoint plus pinned host keys. Normalize both forms to a connector ID and ARN consumed by the retrieval state machines, so their task inputs and resource-scoped IAM remain identical. Create connector secrets, roles, logs, outputs, and the Transfer stack only where endpoint-configured connectors require them; external imported connector roles remain outside this CDK app.

**Tech Stack:** AWS CDK v2, TypeScript, Jest, CDK assertions, ESLint, Prettier.

## Global Constraints

- In dev, configure JSE with connector ID `c-sadfsdfsdfsddfsd` and A2X with connector ID `c-dsfgdsfgsdfdgsdf`.
- Connector IDs are account- and region-specific; the supplied IDs apply only to dev in `af-south-1`.
- Existing connector access roles are already configured with the required S3 bucket and prefix permissions; do not modify or recreate them.
- In uat and prod, retain the endpoint/host-key configuration and the existing connector provisioning path.
- Retrieval state machines, schedules, file-not-found behavior, and storage layout remain unchanged.
- No AWS resource is queried or modified as part of this change.

---

## Starting Point

The inspected checkout already contains the vendor configuration union, dev connector IDs, imported/provisioned connector resolution, conditional TransferStack creation, normalized retrieval references, and component-spec documentation. Some test coverage requested below is not yet explicit, especially mixed-mode stage behavior and exact action-to-connector IAM scoping. Run each focused test before changing production code; when it passes because the behavior is already implemented, keep the implementation and add only the missing assertion or mark that behavior complete. Never change correct code merely to force a red test.

## File Map

- `infra/config/types.ts`: define the vendor connection discriminated union and endpoint-only type used by provisioning.
- `infra/config/dev.ts`: select the existing JSE and A2X connector IDs for dev.
- `infra/lib/stacks/transfer-stack.ts`: resolve each vendor to a normalized connector reference; provision connector-owned resources only for endpoint-configured vendors.
- `infra/lib/stage.ts`: instantiate TransferStack only if at least one vendor needs provisioning, and provide imported references to orchestration.
- `infra/lib/stacks/orchestration-stack.ts`: pass normalized references to each retrieval construct.
- `infra/lib/constructs/retrieve-file-state-machine.ts`: use connector ID and ARN in both Transfer API tasks and their IAM resource scopes.
- `test/transfer-stack.test.ts`: cover imported, provisioned, and mixed vendor configurations, including generated IAM scope.
- `test/helpers.ts`: represent an omitted TransferStack as an empty CDK assertion template.
- `test/orchestration-stack.test.ts`: assert that dev omits TransferStack while retrieval definitions still use the configured connector references.
- `docs/architecture/component-specs.md`: document dev imports, uat/prod provisioning, and the external role's S3 access responsibility.

## Task 1: Model Existing Connector Configuration

**Files:**
- Modify: `infra/config/types.ts`
- Modify: `infra/config/dev.ts`
- Test: `test/transfer-stack.test.ts`

**Interfaces:**
- `VendorConfig` always has `fileNotFoundFailureCode` and is exactly one of `{ connectorId: string }` or `{ sftpUrl: string; trustedHostKeys: string[] }`.
- `VendorEndpointConfig` is the endpoint-and-host-key variant of `VendorConfig`.
- Uat and prod continue to satisfy the endpoint variant without changing their configured URLs or host keys.

- [ ] **Step 1: Add a failing configuration assertion**

Add `prodConfig` to the config imports in `test/transfer-stack.test.ts`, then add this test before the `TransferStack` describe block:

```ts
test('dev selects the existing vendor connector IDs while uat and prod retain endpoints', () => {
	expect('connectorId' in devConfig.jse ? devConfig.jse.connectorId : undefined).toBe('c-sadfsdfsdfsddfsd');
	expect('connectorId' in devConfig.a2x ? devConfig.a2x.connectorId : undefined).toBe('c-dsfgdsfgsdfdgsdf');
	for (const vendor of [uatConfig.jse, uatConfig.a2x, prodConfig.jse, prodConfig.a2x]) {
		expect('sftpUrl' in vendor).toBe(true);
		if ('sftpUrl' in vendor) expect(vendor.trustedHostKeys.length).toBeGreaterThan(0);
	}
});
```

- [ ] **Step 2: Run the config assertion and verify it fails**

Run: `npx jest --runInBand test/transfer-stack.test.ts -t "dev selects the existing vendor connector IDs"`

Expected: FAIL because dev does not yet select the supplied IDs.

- [ ] **Step 3: Define the connection union**

In `infra/config/types.ts`, replace the endpoint-only `VendorConfig` interface with:

```ts
export type VendorConfig = VendorConfigBase &
	(
		| { readonly connectorId: string }
		| {
				/** e.g. "sftp://sftp.vendor.example:22" */
				readonly sftpUrl: string;
				/** Host public keys supplied by the vendor out-of-band. Never trust-on-first-use. */
				readonly trustedHostKeys: string[];
			}
	);

export type VendorEndpointConfig = Extract<VendorConfig, { readonly sftpUrl: string }>;
```

Keep `VendorConfigBase.fileNotFoundFailureCode` and the `EnvironmentConfig` vendor-specific fields unchanged.

- [ ] **Step 4: Configure the dev connector IDs**

In `infra/config/dev.ts`, set the JSE connection fields to:

```ts
	jse: {
		connectorId: 'c-sadfsdfsdfsddfsd',
		fileNotFoundFailureCode: FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER,
		feeds: jseFeeds(false),
	},
```

Set the A2X connection fields to:

```ts
	a2x: {
		enabled: false,
		connectorId: 'c-dsfgdsfgsdfdgsdf',
		fileNotFoundFailureCode: FILE_NOT_FOUND_FAILURE_CODE_PLACEHOLDER,
		remotePathTemplate: '/outbound/equities/EQ_REF_{}.csv',
		schedule: BDA_WINDOW,
	},
```

Do not change `infra/config/uat.ts` or `infra/config/prod.ts`.

- [ ] **Step 5: Run the config assertion and typecheck**

Run: `npx jest --runInBand test/transfer-stack.test.ts -t "dev selects the existing vendor connector IDs"`

Expected: PASS. Then run `npm run build`; expected: `tsc --noEmit` exits successfully.

- [ ] **Step 6: Commit the configuration slice**

```powershell
git add infra/config/types.ts infra/config/dev.ts test/transfer-stack.test.ts
git commit -m "feat: configure existing dev transfer connectors"
```

## Task 2: Resolve Imported and Provisioned Connectors Per Vendor

**Files:**
- Modify: `infra/lib/stacks/transfer-stack.ts`
- Test: `test/transfer-stack.test.ts`

**Interfaces:**
- `TransferConnectorReference` has `connectorId: string` and `connectorArn: string`.
- `TransferStack.jseConnector` and `TransferStack.a2xConnector` both expose `TransferConnectorReference` regardless of configuration mode.
- Only `VendorEndpointConfig` may enter connector resource creation; an imported vendor creates no connector, secret, connector access role, or connector log group/output.

- [ ] **Step 1: Generalize the fixture and add exact resource assertions**

Import `EnvironmentConfig` from `../infra/config` and change the fixture signature to `const buildTransfer = (config: EnvironmentConfig) => {`. Add this mixed fixture inside the existing `describe`:

```ts
const mixedConfig: EnvironmentConfig = {
	...uatConfig,
	jse: {
		connectorId: devConfig.jse.connectorId,
		fileNotFoundFailureCode: uatConfig.jse.fileNotFoundFailureCode,
		feeds: uatConfig.jse.feeds,
	},
};
const mixed = buildTransfer(mixedConfig);
```

In the dev test, retain the zero-connector and zero-secret assertions, and add:

```ts
const devRoles = resourcesOf(devTransfer, 'AWS::IAM::Role').filter(([, role]) =>
	String(role.Properties.Description ?? '').includes('connector'),
);
expect(devRoles).toHaveLength(0);
expect(
	resourcesOf(devTransfer, 'AWS::Logs::LogGroup').some(([, group]) =>
		String(group.Properties.LogGroupName ?? '').startsWith('/aws/transfer/'),
	),
).toBe(false);
const devOutputs = devTransfer.toJSON().Outputs ?? {};
expect(devOutputs).not.toHaveProperty('JseIdpConnectorEgressIps');
expect(devOutputs).not.toHaveProperty('A2xConnectorEgressIps');
```

For `mixed.transfer`, assert one connector and one secret. Filter role pairs by logical ID containing `JseIdpConnectorAccessRole` and require none; assert its outputs do not include `JseIdpConnectorEgressIps`. Keep the existing uat assertions for two connectors, two encrypted retained secrets, three Transfer-trusted roles, prefix-limited policies, and two egress outputs.

- [ ] **Step 2: Run the focused tests and verify the resource expectations**

Run: `npx jest --runInBand test/transfer-stack.test.ts`

Expected: the tests distinguish imported dev resources from endpoint-provisioned uat resources; the mixed-mode test fails until per-vendor resolution is implemented.

- [ ] **Step 3: Create the logging role only when a vendor needs provisioning**

In `TransferStack`, initialize the role conditionally from endpoint configuration:

```ts
this.loggingRole = [this.config.jse, this.config.a2x].some((vendor) => 'sftpUrl' in vendor)
	? this.createLoggingRole()
	: undefined;
```

Keep the existing `createLoggingRole()` trust and permissions unchanged.

- [ ] **Step 4: Resolve the imported case before entering provisioning**

Type the vendor argument to `resolveConnector` as `VendorConfig`; return a formatted connector ARN for the imported case and call the existing resource-provisioning method only for the endpoint variant:

```ts
private resolveConnector(
	opts: Omit<ConnectorOptions, 'vendor'> & { readonly vendor: VendorConfig },
): TransferConnectorReference {
	if ('connectorId' in opts.vendor) {
		return {
			connectorId: opts.vendor.connectorId,
			connectorArn: this.formatArn({
				service: 'transfer',
				resource: 'connector',
				resourceName: opts.vendor.connectorId,
			}),
		};
	}

	if (!this.loggingRole) {
		throw new Error('A Transfer Family logging role is required when creating connectors.');
	}
	return this.createConnector({ ...opts, vendor: opts.vendor }, this.loggingRole);
}
```

Keep secret, access-role, connector, connector-log-group, and egress-output creation together in `createConnector`; it must only receive `VendorEndpointConfig`.

- [ ] **Step 5: Verify transfer API IAM statements remain connector-scoped**

Add this assertion to the dev retrieval-reference test:

```ts
const statements = resourcesOf(devTransfer, 'AWS::IAM::Policy').flatMap(([, policy]) => {
	const document = policy.Properties.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] };
	return document.Statement;
});
for (const connectorId of ['c-sadfsdfsdfsddfsd', 'c-dsfgdsfgsdfdgsdf']) {
	const connectorArn = `arn:aws:transfer:${devConfig.region}:${devConfig.account}:connector/${connectorId}`;
	for (const action of ['transfer:StartFileTransfer', 'transfer:ListFileTransferResults']) {
		expect(statements).toContainEqual({ Action: action, Effect: 'Allow', Resource: connectorArn });
	}
}
```

Keep the existing prefix-isolation assertions for uat access-role policies.

- [ ] **Step 6: Run the focused TransferStack tests**

Run: `npx jest --runInBand test/transfer-stack.test.ts`

Expected: PASS for dev import, mixed mode, and uat connector provisioning; the endpoint case still pins configured host keys and exports egress IPs.

- [ ] **Step 7: Commit the TransferStack slice**

```powershell
git add infra/lib/stacks/transfer-stack.ts test/transfer-stack.test.ts
git commit -m "feat: resolve imported transfer connector references"
```

## Task 3: Omit Empty Dev Transfer Stack and Wire Retrieval References

**Files:**
- Modify: `infra/lib/stage.ts`
- Modify: `infra/lib/stacks/orchestration-stack.ts`
- Modify: `infra/lib/constructs/retrieve-file-state-machine.ts`
- Modify: `test/helpers.ts`
- Test: `test/orchestration-stack.test.ts`

**Interfaces:**
- `OrchestrationStackProps.jseConnector` and `.a2xConnector` are `TransferConnectorReference` values.
- `RetrieveFileStateMachineProps.connector` is a `TransferConnectorReference`, whose ID populates both Transfer API task parameters and whose ARN scopes both IAM actions.
- `IngestionStage.transfer` is `undefined` only when both vendors specify existing connector IDs; with at least one endpoint-configured vendor, the stack exists and imported references are still supplied for imported vendors.

- [ ] **Step 1: Add dev stage regression assertions**

Add this test to `test/orchestration-stack.test.ts`:

Import `EnvironmentConfig` from `../infra/config` alongside `devConfig` and `uatConfig`.

```ts
test('dev omits TransferStack but keeps imported connector references in retrieval permissions', () => {
	const built = buildStage(devConfig);
	expect(built.stage.transfer).toBeUndefined();
	built.templates.transfer.resourceCountIs('AWS::Transfer::Connector', 0);

	const template = json(built.templates.orchestration.toJSON());
	for (const connectorId of ['c-sadfsdfsdfsddfsd', 'c-dsfgdsfgsdfdgsdf']) {
		expect(template).toContain(connectorId);
		expect(template).toContain(`transfer:${devConfig.region}:${devConfig.account}:connector/${connectorId}`);
	}
	expect(template).toContain('transfer:StartFileTransfer');
	expect(template).toContain('transfer:ListFileTransferResults');
});
```

In the same test file, add this mixed-stage test:

```ts
test('a mixed stage provisions only the endpoint-configured connector', () => {
	const mixedConfig: EnvironmentConfig = {
		...uatConfig,
		jse: {
			connectorId: devConfig.jse.connectorId,
			fileNotFoundFailureCode: uatConfig.jse.fileNotFoundFailureCode,
			feeds: uatConfig.jse.feeds,
		},
	};
	const mixed = buildStage(mixedConfig);
	expect(mixed.stage.transfer).toBeDefined();
	mixed.templates.transfer.resourceCountIs('AWS::Transfer::Connector', 1);

	const orchestration = json(mixed.templates.orchestration.toJSON());
	expect(orchestration).toContain(devConfig.jse.connectorId);
	expect(orchestration).toContain(
		`transfer:${mixedConfig.region}:${mixedConfig.account}:connector/${devConfig.jse.connectorId}`,
	);
});
```

- [ ] **Step 2: Run the dev regression test and verify it fails**

Run: `npx jest --runInBand test/orchestration-stack.test.ts -t "dev omits TransferStack"`

Expected: FAIL until the stage does not synthesize an empty Transfer stack and the orchestration policy contains both imported references.

- [ ] **Step 3: Pass normalized references through retrieval task construction**

Keep `TransferConnectorReference` as the shared two-string interface. In `RetrieveFileStateMachine`, use the connector fields for both tasks exactly as follows:

```ts
const { connectorArn, connectorId } = props.connector;
```

Set `ConnectorId: connectorId` and `iamResources: [connectorArn]` in both the `startFileTransfer` and `listFileTransferResults` `CallAwsService` definitions. In `OrchestrationStack`, pass `props.jseConnector` to every JSE retrieve construct and `props.a2xConnector` to the A2X retrieve construct. Do not alter state transitions, retries, schedules, or paths.

- [ ] **Step 4: Conditionally create TransferStack and resolve imported references in the stage**

In `infra/lib/stage.ts`, preserve a stack whenever any vendor has endpoint configuration:

```ts
this.transfer = [config.jse, config.a2x].some((vendor) => 'sftpUrl' in vendor)
	? new TransferStack(this, 'Transfer', {
			config,
			bucket: this.storage.bucket,
			dataKey: this.storage.dataKey,
		})
	: undefined;
```

For an imported vendor, format its ARN with `this.storage.formatArn({ service: 'transfer', resource: 'connector', resourceName: vendor.connectorId })`. For an endpoint vendor with no corresponding `TransferStack` reference, throw an error. Pass `this.transfer?.jseConnector ?? referenceFor(config.jse)` and the equivalent A2X expression to `OrchestrationStack`.

- [ ] **Step 5: Keep the stage test helper valid when TransferStack is absent**

In `test/helpers.ts`, preserve the empty-template fallback for the optional stack:

```ts
transfer: stage.transfer ? Template.fromStack(stage.transfer) : Template.fromJSON({ Resources: {} }),
```

Keep `BuiltStage.templates.transfer` typed as `Template` so existing tests can assert against either provisioned or empty templates.

- [ ] **Step 6: Run the orchestration and stage regression tests**

Run: `npx jest --runInBand test/orchestration-stack.test.ts test/transfer-stack.test.ts`

Expected: PASS; dev has no Transfer stack, its task policies contain both resource-scoped ARNs, and uat's schedules and provisioned connectors remain unchanged.

- [ ] **Step 7: Commit the stage and orchestration slice**

```powershell
git add infra/lib/stage.ts infra/lib/stacks/orchestration-stack.ts infra/lib/constructs/retrieve-file-state-machine.ts test/helpers.ts test/orchestration-stack.test.ts
git commit -m "feat: wire dev retrieval to existing connectors"
```

## Task 4: Document the Environment Split and Run Full Validation

**Files:**
- Modify: `docs/architecture/component-specs.md`
- Test: `test/transfer-stack.test.ts`, `test/orchestration-stack.test.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Documentation must describe imported dev connectors and endpoint-provisioned uat/prod connectors consistently with `VendorConfig`.
- No production CloudFormation resource change is intended; keep existing prod snapshots unless synthesis demonstrates a necessary and reviewed change.

- [ ] **Step 1: Update the Transfer Family component specification**

In Sections 2 and 3 of `docs/architecture/component-specs.md`, state that dev references the supplied pre-existing connector IDs and does not manage connector secrets, roles, logs, or egress outputs. State that uat/prod continue to provision these resources from endpoint and pinned-host-key configuration. Retain the explicit requirement that each external dev connector access role already permits writes to its configured destination prefix. Do not imply CDK manages or verifies those external roles.

- [ ] **Step 2: Run focused regression tests**

Run: `npx jest --runInBand test/transfer-stack.test.ts test/orchestration-stack.test.ts`

Expected: PASS for imported and provisioned paths, connector-scoped task permissions, and unchanged retrieval/schedule behavior.

- [ ] **Step 3: Run TypeScript build and all Jest tests**

Run: `npm run build`

Expected: `tsc --noEmit` exits with code 0.

Run: `npm test -- --runInBand`

Expected: all unit tests pass, including prod template snapshots without unrelated changes.

- [ ] **Step 4: Run lint and formatting checks**

Run: `npm run lint`

Expected: ESLint and `prettier --check .` exit with code 0.

- [ ] **Step 5: Synthesize all CDK stages without contacting AWS**

Run: `npm run synth`

Expected: CDK synthesis exits successfully; dev contains no Transfer stack, while uat/prod synthesize their existing connector resources. Synthesis must not query or modify live AWS resources.

- [ ] **Step 6: Commit documentation and final verified changes**

```powershell
git add docs/architecture/component-specs.md
git commit -m "docs: describe dev transfer connector reuse"
```

## Self-Review

- **Spec coverage:** Imported IDs and the `af-south-1` dev-only limitation are in Tasks 1 and 3; absence of duplicate connector resources is in Task 2; uat/prod endpoint provisioning is retained and tested in Tasks 2 and 4; external S3 access-role responsibility is in Task 4; retrieval and schedule behavior is explicitly held constant in Task 3; no live AWS access is allowed by the global constraints and synthesis step.
- **Placeholder scan:** No unresolved planning placeholder is used as a substitute for an action.
- **Type consistency:** `VendorConfig` narrows to `VendorEndpointConfig` before resource creation; both imported and created connector paths produce `TransferConnectorReference`; stage props pass those references to orchestration; retrieval tasks consume `connectorId` and `connectorArn` consistently.

Plan complete and saved to `docs/superpowers/plans/2026-10-01-dev-transfer-connector-reuse.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task and review between tasks.
2. **Inline Execution** - Execute tasks in this session using the executing-plans skill, with checkpoints.

Which approach?
