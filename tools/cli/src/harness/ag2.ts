/**
 * ag2.ts — AG2 (the AutoGen fork) adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). "ag2" is a short
 * package name that would false-positive as a plain substring test (e.g.
 * inside "flag2" or a version string like "...ag2..."), so detection uses a
 * boundary-aware regex instead of `keywords.includes('ag2')` — see
 * sdkGatedAdapter.ts's `ManifestMatcher` type.
 *
 * TODO(P2, sibling wave): no `intutic_clawde.gate.adapters.ag2` module exists
 * yet (see gateRegistry.ts's NO_GATE row for `ag2`). AG2 is an AutoGen fork
 * whose tools are, likewise, plain callables, so `@guard`/`guard_tools`
 * already govern them in the meantime.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

/** Matches a standalone "ag2" token — not "flag2", not "storage2". */
const AG2_TOKEN = /(?:^|[^a-z0-9_])ag2(?:[^a-z0-9_]|$)/

export const ag2Adapter = makeSdkGatedAdapter({
  type: HarnessType.AG2,
  label: 'AG2',
  keywords: [AG2_TOKEN],
  pipInstall: 'intutic-clawde',
  importLine: 'from intutic_clawde.gate import guard, guard_tools',
  usageSummary:
    'AG2 tools are plain callables — @guard/guard_tools already govern them; a dedicated ' +
    'adapters.ag2 convenience module ships in a later wave.',
  docsSlug: 'ag2',
})
