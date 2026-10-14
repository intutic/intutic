/**
 * autogen.ts — AutoGen adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via any of
 * the `autogen-agentchat` / `autogen-core` / `autogen-ext` packages — any one
 * present is treated as "AutoGen is here".
 *
 * The blocking gate ships SDK-side, and the written comment leads with the
 * same mechanism the integration page does:
 * `intutic_clawde.gate.adapters.autogen_workbench.IntuticWorkbench`, a
 * `Workbench.call_tool` veto that governs `AssistantAgent`'s own in-process
 * tool calls. `intutic_clawde.gate.adapters.autogen.IntuticInterventionHandler`
 * (an `InterventionHandler.on_send` veto, verified live against
 * autogen-core==0.7.5) covers only `FunctionCall` messages explicitly routed
 * through `runtime.send_message`/`publish_message` — `AssistantAgent`'s tool
 * calls never go through the runtime — so it is named as the addition for
 * code that dispatches those by hand.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const autogenAdapter = makeSdkGatedAdapter({
  type: HarnessType.AUTOGEN,
  label: 'AutoGen',
  keywords: ['autogen-agentchat', 'autogen-core', 'autogen-ext'],
  pipInstall: 'intutic-clawde[autogen]',
  importLine: 'from intutic_clawde.gate.adapters.autogen_workbench import IntuticWorkbench',
  usageSummary:
    'AssistantAgent(workbench=IntuticWorkbench(StaticWorkbench(tools))) vetoes each tool call via ' +
    'call_tool; for runtime-routed FunctionCall messages add ' +
    'intutic_clawde.gate.adapters.autogen.IntuticInterventionHandler.',
  docsSlug: 'autogen',
})
