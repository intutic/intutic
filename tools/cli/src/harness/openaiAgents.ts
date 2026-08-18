/**
 * openaiAgents.ts — OpenAI Agents SDK (Python) adapter (env-file config,
 * SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Tools run as plain
 * Python callables inside the agent's own process — no on-disk hook/config
 * file exists to gate a call, so the blocking gate ships SDK-side via
 * `intutic_clawde.gate.adapters.openai_agents.intutic_tool_guardrail`, a
 * `@tool_input_guardrail` that runs before the tool executes and can reject
 * the call via `ToolGuardrailFunctionOutput.reject_content()` — the SDK's own
 * documented veto point (verified live against openai-agents==0.20.0).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const openaiAgentsAdapter = makeSdkGatedAdapter({
  type: HarnessType.OPENAI_AGENTS,
  label: 'OpenAI Agents SDK',
  keywords: ['openai-agents'],
  pipInstall: 'intutic-clawde[openai-agents]',
  importLine: 'from intutic_clawde.gate.adapters.openai_agents import intutic_tool_guardrail',
  usageSummary:
    'intutic_tool_guardrail, attached via function_tool(tool_input_guardrails=[...]), ' +
    'refuses denied calls before the tool body runs.',
  docsSlug: 'openai-agents',
})
