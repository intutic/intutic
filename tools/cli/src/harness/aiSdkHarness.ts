/**
 * aiSdkHarness.ts — Vercel `@ai-sdk/harness` adapter (env-file config,
 * SDK-side gate).
 *
 * Same shape as mastra.ts/vercelAiSdk.ts (see jsSdkGatedAdapter.ts), for
 * Vercel's sandboxed coding-agent runtime (`HarnessAgent`): detected via
 * `@ai-sdk/harness` itself, any `@ai-sdk/harness-*` runtime adapter
 * (harness-claude-code, harness-grok-build, ...), or any `@ai-sdk/sandbox-*`
 * provider in `package.json` — each family independently signals the
 * framework, hence `requiresAnyPrefix` rather than a single required package.
 *
 * TWO DOCUMENTED LIMITATIONS carried into the generated `.env.intutic`
 * (both confirmed against `@ai-sdk/harness@1.0.75`'s shipped types — see
 * `@intutic/gate/harness`'s module doc for the full record):
 *
 *   1. Tool execution is SERVER-SIDE, in Vercel Sandbox microVMs — the
 *      local Intutic proxy never sees sandbox egress, so the written
 *      base-URL vars govern only LLM calls the CALLER's own process makes.
 *      Egress governance for the sandbox itself is the sandbox's own
 *      network policy (coarse, host-level), recommended via
 *      `recommendedHarnessSettings()`.
 *   2. Built-in sandbox tools (read/write/edit/bash/...) are governed only
 *      by `permissionMode`, which DEFAULTS to `'allow-all'` — the gate can
 *      only reach custom host-executed tools, via the approval flow.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

export const aiSdkHarnessAdapter = makeJsSdkGatedAdapter({
  type: HarnessType.AI_SDK_HARNESS,
  label: 'AI SDK Harness',
  requires: [],
  requiresAnyPrefix: ['@ai-sdk/harness', '@ai-sdk/sandbox-'],
  npmInstall: '@intutic/gate',
  envPreamble: [
    'These env vars govern LLM egress from THIS process only. AI SDK Harness',
    'agents execute their tools server-side in Vercel Sandbox microVMs — that',
    'traffic never crosses this proxy, and no config or hook file can gate the',
    'sandbox from here. The blocking tool gate (custom host-executed tools',
    'only) ships SDK-side:',
  ],
  importLine:
    "import { intuticApprovalResponder, intuticStaticApprovals, recommendedHarnessSettings } from '@intutic/gate/harness'",
  usageSummary:
    "toolApproval: intuticStaticApprovals(tools) routes every custom tool through the approval flow; " +
    'answer pauses with intuticApprovalResponder(). NOTE: built-in sandbox tools ignore toolApproval ' +
    "entirely — set permissionMode (defaults to 'allow-all') via recommendedHarnessSettings(); sandbox " +
    'egress never crosses this proxy — set a sandbox networkPolicy.',
  docsSlug: 'ai-sdk-harness',
})
