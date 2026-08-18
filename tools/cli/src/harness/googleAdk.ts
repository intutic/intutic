/**
 * googleAdk.ts — Google Agent Development Kit (ADK) adapter (env-file
 * config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). ADK tools run as
 * plain Python callables inside the agent's own process — no on-disk
 * hook/config file exists to gate a call, so the blocking gate ships
 * SDK-side via `intutic_clawde.gate.adapters.google_adk.IntuticPlugin`,
 * whose `before_tool_callback` is ADK's own documented veto point: when it
 * returns a non-None dict, the real tool call is skipped and that dict
 * becomes the (synthetic) tool result (verified live against
 * google-adk==2.7.1).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const googleAdkAdapter = makeSdkGatedAdapter({
  type: HarnessType.GOOGLE_ADK,
  label: 'Google ADK',
  keywords: ['google-adk'],
  pipInstall: 'intutic-clawde[google-adk]',
  importLine: 'from intutic_clawde.gate.adapters.google_adk import IntuticPlugin',
  usageSummary:
    'IntuticPlugin.before_tool_callback (App(plugins=[...]) — or the per-agent ' +
    'before_tool_callback fallback) refuses denied calls before the tool body runs.',
  docsSlug: 'google-adk',
})
