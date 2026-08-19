/**
 * pydanticAi.ts — Pydantic AI adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via
 * `pydantic-ai` or `pydantic-ai-slim` (the substring "pydantic-ai" matches
 * both).
 *
 * The blocking gate ships SDK-side via
 * `intutic_clawde.gate.adapters.pydantic_ai.IntuticWrapperToolset`, a
 * Pydantic AI `WrapperToolset.call_tool` override, plus a `guard_agent(agent)`
 * convenience helper wrapping every toolset already on an `Agent` in one
 * call — verified live against pydantic-ai-slim==2.31.1 by driving a real
 * `Agent.run_sync()` through `pydantic_ai.models.function.FunctionModel`.
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
  pipInstall: 'intutic-clawde[pydantic-ai]',
  importLine: 'from intutic_clawde.gate.adapters.pydantic_ai import guard_agent',
  usageSummary:
    'guard_agent(agent) wraps every toolset on the Agent; a blocked call raises ModelRetry ' +
    'before the tool body runs.',
  docsSlug: 'pydantic-ai',
})
