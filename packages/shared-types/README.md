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
| `sop` | SOP lifecycle types, rule schemas, hook definitions |
| `auth` | Session, token, credential types |
| `identity` | SSO/OIDC provider config, cross-workspace user identity |
| `sync` | Config sync state, drift detection, harness config types |
| `policy` | Policy evaluation results, enforcement decisions |
| `anomaly` | Anomaly detection signals, baseline models |
| `notifications` | Notification channels, alert templates, delivery status |
| `billing` | Subscription tiers, usage metering, invoice types |
| `observability` | Trace spans, metric definitions, log schemas |
| `responses/` | The control plane's response schemas (`<Thing>Response`, zod with the inferred type): what each route that declares one answers with, as published in the OpenAPI document |

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

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
