/**
 * crewai.ts — CrewAI adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). CrewAI tools are
 * plain callables/CrewStructuredTool instances in the agent's own process —
 * no on-disk hook/config file exists to gate a call, so the blocking gate
 * ships SDK-side via `intutic_clawde.gate.adapters.crewai.install()`, which
 * registers a `before_tool_call` hook (CrewAI's own documented interception
 * point — verified live against crewai==1.15.16).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const crewaiAdapter = makeSdkGatedAdapter({
  type: HarnessType.CREWAI,
  label: 'CrewAI',
  keywords: ['crewai'],
  pipInstall: 'intutic-clawde[crewai]',
  importLine: 'from intutic_clawde.gate.adapters.crewai import install',
  usageSummary:
    'install() registers a before_tool_call hook that refuses denied calls before the ' +
    'tool body runs.',
  docsSlug: 'crewai',
})
