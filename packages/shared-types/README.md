# @intutic/shared-types

> Zod-validated TypeScript types shared across all Intutic services.

## Overview

`@intutic/shared-types` is the single source of truth for TypeScript interfaces, enums, and Zod schemas used across the Intutic monorepo. Every service, package, and application imports types from here — never duplicated, always validated.

## Scope

One source module per domain under `src/`. Among them:

| Module | Key Types |
|--------|-----------|
| `enums` | `EnforcementAction`, `HarnessType`, `RiskLevel`, `SopLifecycleState` |
| `finops` | `TraceEntry`, `CostBreakdown`, `TraceFilters` |
| `sop` | SOPs, lifecycle transitions, proof trees, plans, decision-log entries |
| `auth` | Login, signup and terms acceptance (`acceptTerms`), JWT payload, API key and member types |
| `apiKeyScopes` | `API_SCOPES` and `API_SCOPE_AREAS`: what an API key may do (`*`, `gateway:use`, `<area>:read` / `<area>:write`) |
| `api-contracts` | Request schemas such as `CreateTraceSchema`, each with its inferred type |
| `identity` | SSO/OIDC provider config, cross-workspace user identity |
| `sync` | Config sync state, drift detection, harness config types |
| `policy` | Permission sets, policy and plugin verdicts, `InterventionMode` |
| `anomaly` | Anomaly events and classifications, probe results, trust scores (categories and severities come from `@intutic/anomaly-taxonomy`) |
| `notifications` | Notification channels, event types, rules, delivery status, Slack and webhook payloads |
| `billing` | Metered usage events and their reconciliation |
| `observability` | The trace DAG: a trace's sessions and their parents |
| `responses/` | The control plane's response schemas (`<Thing>Response`, zod with the inferred type): what each route that declares one answers with, as published in the OpenAPI document. `WireFields<T>` is a client's defensive read of one (every declared field, each `unknown` until checked); `fixtures/responses/` holds captured answers the tests hold to them |

## Usage

```typescript
import { EnforcementAction, HarnessType, CreateTraceSchema } from '@intutic/shared-types';

// Zod validation
const parsed = CreateTraceSchema.parse(rawData);
```

## Design Principles

- **Single source of truth**: All cross-package types live here. No type duplication.
- **Zod at the boundaries**: API payloads have Zod schemas, with their TypeScript types inferred via `z.infer<>`; other shapes are plain interfaces.
- **Barrel exports**: `index.ts` is the single entry point; import from the package root (there are no subpath exports).
- **Minimal runtime dependencies**: Zod and `@intutic/anomaly-taxonomy`, nothing else.

## Installation

```bash
npm install @intutic/shared-types
```

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — policy as code for AI agents, enforced at the tool call.

## License

MIT — see [LICENSE](../../LICENSE) for details.
