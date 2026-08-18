/**
 * pydanticAi.ts — Pydantic AI adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via
 * `pydantic-ai` or `pydantic-ai-slim` (the substring "pydantic-ai" matches
 * both).
 *
 * TODO(P2, sibling wave): no `intutic_clawde.gate.adapters.pydantic_ai`
 * module exists yet (see gateRegistry.ts's NO_GATE row for `pydantic-ai`).
 * Pydantic AI tools are plain callables, so `@guard`/`guard_tools` already
 * govern them in the meantime.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const pydanticAiAdapter = makeSdkGatedAdapter({
  type: HarnessType.PYDANTIC_AI,
  label: 'Pydantic AI',
  keywords: ['pydantic-ai'], // matches "pydantic-ai" and "pydantic-ai-slim"
  pipInstall: 'intutic-clawde',
  importLine: 'from intutic_clawde.gate import guard, guard_tools',
  usageSummary:
    'Pydantic AI tools are plain callables — @guard/guard_tools already govern them; a ' +
    'dedicated adapters.pydantic_ai convenience module ships in a later wave.',
  docsSlug: 'pydantic-ai',
})
