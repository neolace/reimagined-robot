# Reuse Existing Transfer Family Connectors in Dev

## Problem

The dev configuration currently describes vendor SFTP endpoints and host keys, and `TransferStack` creates new AWS Transfer Family connectors. JSE and A2X dev connectors already exist and should be used instead.

## Design

Represent a vendor connection as either an existing connector ID or the current endpoint/host-key configuration. In dev, configure JSE with connector ID `c-sadfsdfsdfsd` and A2X with connector ID `c-dsfgdsfgsdf`. In uat and prod, retain the endpoint/host-key configuration and the existing connector provisioning path.

For an existing connector, the CDK stage will construct its connector ID and ARN references for the Step Functions tasks and their resource-scoped IAM permissions. If both connectors are imported, it will omit the empty Transfer stack entirely. It will not create a connector, credential secret, connector access role, or connector logging role for an imported vendor. The existing connector's access role is already configured with the required S3 bucket and prefix permissions. The stage will continue to provision those resources and emit connector outputs for environments that create connectors.

The retrieval state machines, schedules, file-not-found behavior, and storage layout remain unchanged.

## Validation

- Unit tests verify dev connector IDs are used by the state machines and no connector resources are synthesized for those configured references.
- Existing transfer-stack tests verify uat/prod-style endpoint configurations still synthesize connectors with their configured URL and host keys.
- Run the focused Jest tests, then the repository test suite and CDK synthesis/type checks if available.

## Constraints

- Connector IDs are account- and region-specific; the supplied IDs apply only to dev in `af-south-1`.
- Existing connector access roles remain managed outside this stack and must retain S3 access to the configured destination prefixes.
- No AWS resource is queried or modified as part of this change.