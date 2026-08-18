/**
 * smolagents.ts — smolagents adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via the
 * `smolagents` package name.
 *
 * TODO(P2, sibling wave): no `intutic_clawde.gate.adapters.smolagents`
 * module exists yet (see gateRegistry.ts's NO_GATE row for `smolagents`).
 * smolagents tools are plain callables, so `@guard`/`guard_tools` already
 * govern them in the meantime.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const smolagentsAdapter = makeSdkGatedAdapter({
  type: HarnessType.SMOLAGENTS,
  label: 'smolagents',
  keywords: ['smolagents'],
  pipInstall: 'intutic-clawde',
  importLine: 'from intutic_clawde.gate import guard, guard_tools',
  usageSummary:
    'smolagents tools are plain callables — @guard/guard_tools already govern them; a ' +
    'dedicated adapters.smolagents convenience module ships in a later wave.',
  docsSlug: 'smolagents',
})
