# @intutic/shared-types

> Zod-validated TypeScript types shared across all Intutic services.

## Overview

`@intutic/shared-types` is the single source of truth for TypeScript interfaces, enums, and Zod schemas used across the Intutic monorepo. Every service, package, and application imports types from here — never duplicated, always validated.

## Scope

27 source modules exporting ~200+ types covering:

| Module | Key Types |
|--------|-----------|
| `enums` | `EnforcementAction`, `HarnessType`, `RiskLevel`, `SopLifecycleStage` |
| `finops` | `TraceEntry`, `Attribution4D`, `BudgetEnvelope`, `CostBreakdown` |
| `sop` | SOP lifecycle types, rule schemas, hook definitions |
| `auth` | Session, token, credential types |
| `identity` | SSO/SCIM integration types, user/team/org models |
| `sync` | Config sync state, drift detection, harness config types |
| `policy` | Policy evaluation results, enforcement decisions |
| `anomaly` | Anomaly detection signals, baseline models |
| `notifications` | Notification channels, alert templates, delivery status |
| `billing` | Subscription tiers, usage metering, invoice types |
| `observability` | Trace spans, metric definitions, log schemas |

## Usage

```typescript
import { EnforcementAction, HarnessType } from '@intutic/shared-types';
import { traceEntrySchema } from '@intutic/shared-types/finops';

// Zod validation
const parsed = traceEntrySchema.parse(rawData);
```

## Design Principles

- **Single source of truth**: All cross-package types live here. No type duplication.
- **Zod-first**: Schemas define the shape; TypeScript types are inferred via `z.infer<>`.
- **Barrel exports**: Each module re-exports from `index.ts` for clean import paths.
- **No runtime dependencies**: This package has zero runtime dependencies beyond Zod.

## Installation

```bash
npm install @intutic/shared-types
```

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
