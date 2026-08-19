/**
 * autogen.ts — AutoGen adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via any of
 * the `autogen-agentchat` / `autogen-core` / `autogen-ext` packages — any one
 * present is treated as "AutoGen is here".
 *
 * The blocking gate ships SDK-side via
 * `intutic_clawde.gate.adapters.autogen.IntuticInterventionHandler`, an
 * `autogen_core.InterventionHandler.on_send` — verified live against
 * autogen-core==0.7.5 by driving a real `SingleThreadedAgentRuntime` end to
 * end. IMPORTANT, documented in that module's own doc: `on_send` only sees
 * `FunctionCall` messages explicitly routed through
 * `runtime.send_message`/`publish_message` — `AssistantAgent`'s own tool
 * calls never go through the runtime at all, so for `AssistantAgent`-based
 * code the framework-agnostic `@guard`/`guard_tools` helpers (governing the
 * tool objects directly) remain the applicable coverage, same as before this
 * adapter existed (see TD-374).
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
  importLine: 'from intutic_clawde.gate.adapters.autogen import IntuticInterventionHandler',
  usageSummary:
    'IntuticInterventionHandler vetoes a runtime-routed FunctionCall via on_send (see TD-374: ' +
    'invisible to AssistantAgent\'s own tool calls — wrap those tools with @guard/guard_tools ' +
    'instead).',
  docsSlug: 'autogen',
})
