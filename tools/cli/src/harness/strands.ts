/**
 * strands.ts — AWS Strands Agents adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Strands tools are
 * plain decorated callables (or MCP-materialised `MCPAgentTool`s) in the
 * agent's own Python process — no on-disk hook/config file exists to gate a
 * call, so the blocking gate ships SDK-side via
 * `intutic_clawde.gate.adapters.strands.IntuticHookProvider`, built on
 * Strands' own documented `BeforeToolCallEvent.cancel_tool` veto (verified
 * live against strands-agents==1.52.0).
 *
 * Egress caveat, unique so far in this family: Strands' DEFAULT model
 * provider is Bedrock, whose SigV4-signed boto3 traffic the Intutic proxy
 * cannot terminate — the ANTHROPIC_BASE_URL/OPENAI_BASE_URL vars the shared
 * `.env.intutic` writes only take effect if the user selects the Anthropic/
 * OpenAI/LiteLLM providers instead. See apps/docs/integrations/strands.md.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const strandsAdapter = makeSdkGatedAdapter({
  type: HarnessType.STRANDS,
  label: 'Strands Agents',
  // Matches strands-agents, strands-agents-tools, and the bedrock-agentcore
  // `strands-agents` extra — all of which imply the framework is in use.
  keywords: ['strands-agents'],
  pipInstall: 'intutic-clawde[strands]',
  importLine: 'from intutic_clawde.gate.adapters.strands import IntuticHookProvider',
  usageSummary:
    'Agent(hooks=[IntuticHookProvider()]) cancels denied tool calls via Strands’ own ' +
    'BeforeToolCallEvent.cancel_tool before the tool body runs (MCP tools included).',
  docsSlug: 'strands',
})
