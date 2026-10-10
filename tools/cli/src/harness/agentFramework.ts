/**
 * agentFramework.ts — Microsoft Agent Framework adapter (env-file config,
 * SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Agent Framework (the
 * AutoGen + Semantic Kernel successor, `agent-framework` /
 * `agent-framework-core` on PyPI, imported as `agent_framework`) is a separate
 * framework from AutoGen (autogen.ts), so it has its own adapter.
 * Its tools run in the agent's own Python process, so the blocking gate ships
 * SDK-side via
 * `intutic_clawde.gate.adapters.agent_framework.IntuticFunctionMiddleware`, a
 * `FunctionMiddleware` that skips `call_next()` on a deny (verified live
 * against agent-framework-core==1.20.0).
 *
 * "agent-framework" is a generic phrase, so detection anchors the start of the
 * name: it must not follow a letter, digit, `-`, `_` or `.`. That matches
 * `agent-framework`, `agent-framework-core`, `agent-framework-openai` and the
 * `agent_framework` spelling, but not some other project's
 * `my-agent-framework`.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

const AGENT_FRAMEWORK_TOKEN = /(?:^|[^a-z0-9_.-])agent[-_]framework(?![a-z0-9])/m

export const agentFrameworkAdapter = makeSdkGatedAdapter({
  type: HarnessType.AGENT_FRAMEWORK,
  label: 'Microsoft Agent Framework',
  keywords: [AGENT_FRAMEWORK_TOKEN],
  pipInstall: 'intutic-clawde[agent-framework]',
  importLine: 'from intutic_clawde.gate.adapters.agent_framework import IntuticFunctionMiddleware',
  usageSummary:
    'Agent(middleware=[IntuticFunctionMiddleware()]) skips call_next() on a denied tool call, ' +
    'so the tool never runs and the model receives the refusal as the tool result.',
  docsSlug: 'microsoft-agent-framework',
})
