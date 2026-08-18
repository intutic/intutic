/**
 * autogen.ts — AutoGen adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via any of
 * the `autogen-agentchat` / `autogen-core` / `autogen-ext` packages — any one
 * present is treated as "AutoGen is here".
 *
 * TODO(P2, sibling wave): no `intutic_clawde.gate.adapters.autogen` module
 * exists yet — that ships in the next wave (see gateRegistry.ts's NO_GATE
 * row for `autogen`). Until it lands, AutoGen tools are plain callables, so
 * the framework-agnostic `@guard`/`guard_tools` helpers already govern them
 * (see framework.py's module doc: "CrewAI and AutoGen tools ... need nothing
 * else"); the comment this adapter writes points there rather than at a
 * dedicated adapter import that does not exist yet.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeSdkGatedAdapter } from './sdkGatedAdapter.js'

export const autogenAdapter = makeSdkGatedAdapter({
  type: HarnessType.AUTOGEN,
  label: 'AutoGen',
  keywords: ['autogen-agentchat', 'autogen-core', 'autogen-ext'],
  pipInstall: 'intutic-clawde',
  importLine: 'from intutic_clawde.gate import guard, guard_tools',
  usageSummary:
    'AutoGen tools are plain callables — @guard/guard_tools already govern them; a ' +
    'dedicated adapters.autogen convenience module ships in a later wave.',
  docsSlug: 'autogen',
})
