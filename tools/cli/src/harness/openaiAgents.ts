/**
 * openaiAgents.ts — OpenAI Agents SDK adapter (env-file config, SDK-side
 * gate) covering BOTH ecosystems the SDK ships in, following the LangChain
 * dual-ecosystem precedent (see HarnessType.LANGCHAIN's doc comment in
 * shared-types/enums.ts) — except that unlike LangChain, BOTH sides have a
 * shipped gate here, so detection AND config cover both:
 *
 *   * Python (`openai-agents` on PyPI): same shape as langgraph.ts (see
 *     sdkGatedAdapter.ts). Tools run as plain Python callables inside the
 *     agent's own process — no on-disk hook/config file exists to gate a
 *     call, so the blocking gate ships SDK-side via
 *     `intutic_clawde.gate.adapters.openai_agents.intutic_tool_guardrail`, a
 *     `@tool_input_guardrail` that runs before the tool executes and can
 *     reject the call via `ToolGuardrailFunctionOutput.reject_content()` —
 *     the SDK's own documented veto point (verified live against
 *     openai-agents==0.20.0).
 *   * TypeScript (`@openai/agents` on npm, plus its `-core`/`-openai`/
 *     `-realtime`/`-extensions` sub-packages — all matched by the
 *     `@openai/agents` prefix rule, same mechanism as vercelAiSdk.ts's
 *     `@ai-sdk/` prefix): the gate ships in `@intutic/gate/openai`
 *     (packages/gate-js), the same tool-input-guardrail veto point verified
 *     against @openai/agents@0.16.1 (guardrails exist since
 *     @openai/agents-core 0.3.8) — see that module's doc for the MCP
 *     materialization gotcha and the tracing-exporter DLP caveat its
 *     `installOpenAiGate()` closes.
 *
 * `writeConfig` writes the SAME proxy env vars either way (the `openai`
 * clients of both ecosystems honour `OPENAI_BASE_URL`); only the SDK-gate
 * pointer comment differs. A workspace detected as TypeScript-only gets the
 * `@intutic/gate/openai` pointer; anything else (Python-only, or a monorepo
 * with both) gets the Python pointer — the Python text is the established
 * default this adapter has always written, and a both-ecosystems workspace
 * still finds the TS adapter through the docs page both comments link to.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

/** The Python side — unchanged from this adapter's original single-ecosystem
 *  shape, and still the default `writeConfig` text (see module doc). */
const pythonAdapter = makeSdkGatedAdapter({
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

/** The TypeScript side — package.json-dep detection (any `@openai/agents*`
 *  package; the meta-package alone is enough, and `-core`-only installs are
 *  matched too) plus the `@intutic/gate/openai` pointer comment. No
 *  `minMajor` floor: the guardrail veto point predates every version the
 *  meta-package `@openai/agents` ever shipped as latest in 2026, and the
 *  docs page states the >=0.3.8 core floor explicitly. */
const jsAdapter = makeJsSdkGatedAdapter({
  type: HarnessType.OPENAI_AGENTS,
  label: 'OpenAI Agents SDK (TypeScript)',
  requires: [],
  requiresPrefix: '@openai/agents',
  npmInstall: '@intutic/gate',
  importLine: "import { installOpenAiGate, wrapAgent } from '@intutic/gate/openai'",
  usageSummary:
    'installOpenAiGate() + wrapAgent(agent) — tool input guardrails refuse denied calls before ' +
    'the tool body runs, mcpServers-derived tools included. installOpenAiGate() also disables ' +
    'the SDK tracing exporter, which posts tool I/O to a hardcoded api.openai.com endpoint ' +
    'that bypasses OPENAI_BASE_URL.',
  docsSlug: 'openai-agents',
})

export const openaiAgentsAdapter: IHarnessAdapter = {
  type: HarnessType.OPENAI_AGENTS,
  configFileName: '.env.intutic',

  async detect(workspaceRoot: string): Promise<boolean> {
    return (await pythonAdapter.detect(workspaceRoot)) || (await jsAdapter.detect(workspaceRoot))
  },

  async writeConfig(workspaceRoot, sops, proxyUrl): Promise<string | null> {
    const [python, js] = await Promise.all([
      pythonAdapter.detect(workspaceRoot),
      jsAdapter.detect(workspaceRoot),
    ])
    if (js && !python) {
      return jsAdapter.writeConfig(workspaceRoot, sops, proxyUrl)
    }
    return pythonAdapter.writeConfig(workspaceRoot, sops, proxyUrl)
  },

  // Both sides write the identical file path; either delegate reads it.
  readCurrentHash: (workspaceRoot) => pythonAdapter.readCurrentHash(workspaceRoot),
}
