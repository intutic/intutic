/**
 * langchain.ts — LangChain adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts): writes .env.intutic
 * with proxy base-URL env vars, plus a comment pointing at the SDK-side tool
 * gate — LangChain has no on-disk hook/config file either, since its tools
 * run as plain Python callables/objects in the agent's own process.
 *
 * Detection is Python-only on purpose. LangChain ships in both the Python
 * (`langchain`/`langchain-core`) and JS/TS (`langchain` npm package)
 * ecosystems, and the HarnessType.LANGCHAIN enum member covers both for
 * *detection* purposes (see its doc comment in shared-types/enums.ts) — but
 * this env-adapter only writes Python env vars, matching the
 * `intutic_clawde.gate.adapters.langchain` gate it points at. A JS/TS
 * tool-call gate for LangChain.js is a `@intutic/gate` TypeScript package
 * concern for a later phase, not this adapter.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const langchainAdapter = makeSdkGatedAdapter({
  type: HarnessType.LANGCHAIN,
  label: 'LangChain',
  keywords: ['langchain'], // matches "langchain" and "langchain-core"
  pipInstall: 'intutic-clawde[langchain]',
  importLine: 'from intutic_clawde.gate.adapters.langchain import IntuticMiddleware',
  usageSummary:
    'IntuticMiddleware.wrap_tool_call (LangChain v1.x AgentMiddleware) — or guard_tools ' +
    'for pre-1.0 LangChain — refuses denied calls before the tool body runs.',
  docsSlug: 'langchain',
})
