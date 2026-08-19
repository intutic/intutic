/**
 * vercelAiSdk.ts — Vercel AI SDK adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts's Python-side siblings (see
 * jsSdkGatedAdapter.ts), but JS/TS-native: detected via `ai` at major
 * version >= 6 (the `toolApproval` veto point this points at is a v6+ API —
 * a bare `ai` presence check would false-positive on pre-6 workspaces whose
 * tool-loop surface does not have this hook at all) PLUS at least one
 * `@ai-sdk/*` provider package, since `ai` alone declares the tool-loop
 * surface but ships no model provider.
 *
 * DOCUMENTED LIMITATION carried into the generated `.env.intutic`: unlike
 * every other harness this env-file convention covers, the Vercel AI SDK
 * has no environment-variable LLM-egress override — the written
 * `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`INTUTIC_PROXY_URL` vars are
 * therefore INERT for this framework's own LLM calls (a plain `source
 * .env.intutic` does nothing for `ai`) unless the caller's own provider
 * construction reads them explicitly — routing requires in-code
 * `createOpenAI({ baseURL })`/`createGateway({ baseURL })` via
 * `@intutic/gate/vercel`'s `withIntuticProxy()`. The vars are still
 * written (a workspace may run OTHER harnesses that DO honour them, or a
 * caller may wire them in manually), but this is not a "zero-code" proxy
 * hookup the way it is for `langchain`/`langgraph`. See
 * `@intutic/gate/vercel`'s module doc and
 * `apps/docs/integrations/vercel-ai-sdk.md`.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

export const vercelAiSdkAdapter = makeJsSdkGatedAdapter({
  type: HarnessType.VERCEL_AI_SDK,
  label: 'Vercel AI SDK',
  requires: [{ name: 'ai', minMajor: 6 }],
  requiresPrefix: '@ai-sdk/',
  npmInstall: '@intutic/gate',
  importLine: "import { intuticToolApproval, withIntuticProxy } from '@intutic/gate/vercel'",
  usageSummary:
    'generateText({ ..., toolApproval: intuticToolApproval() }) — the toolApproval veto point. ' +
    'NOTE: this framework has NO env-var LLM-egress routing; use withIntuticProxy(createOpenAI)( ' +
    '...) or equivalent in code — the env vars above do not route this framework on their own.',
  docsSlug: 'vercel-ai-sdk',
})
