/**
 * mastra.ts — Mastra adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts's Python-side siblings (see
 * jsSdkGatedAdapter.ts), but JS/TS-native: detected via `@mastra/core` in
 * `package.json` (any version — the `beforeToolCall` hook this points at
 * has been present since early 1.x), and points at
 * `@intutic/gate/mastra`'s `intuticHooks()` rather than an `intutic-clawde`
 * import.
 *
 * TAMPER NOTE: Mastra's per-call `hooks` option (passed to `.generate()`/
 * `.stream()`) OVERRIDES agent-level hooks entirely rather than merging with
 * them — a caller who passes their own `hooks` at call time silently
 * disables this gate. See `@intutic/gate/mastra`'s module doc and
 * `gateRegistry.ts`'s `mastra` NO_GATE row for the full, confirmed record.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

export const mastraAdapter = makeJsSdkGatedAdapter({
  type: HarnessType.MASTRA,
  label: 'Mastra',
  requires: [{ name: '@mastra/core' }],
  npmInstall: '@intutic/gate',
  importLine: "import { intuticHooks } from '@intutic/gate/mastra'",
  usageSummary:
    "new Agent({ ..., hooks: intuticHooks() }) — Mastra's beforeToolCall veto point, run for " +
    'every tool in the assembled tool dictionary (MCP-sourced tools included). NOTE: per-call ' +
    '`hooks` on .generate()/.stream() OVERRIDE this, not merge with it — see the module doc.',
  docsSlug: 'mastra',
})
