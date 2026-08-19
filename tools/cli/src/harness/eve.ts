/**
 * eve.ts — Vercel "eve" adapter (env-file config, SDK-side gate).
 *
 * Same family as mastra.ts/vercelAiSdk.ts (see jsSdkGatedAdapter.ts), with
 * one difference the shared builder cannot express: detection is a COMPOUND
 * check. The npm package name `eve` is short and generic enough that a
 * dependency check alone over-detects, and `agent/` is a directory name half
 * the JS ecosystem uses for something — so this adapter requires BOTH the
 * `eve` dependency in `package.json` AND the framework's characteristic
 * `agent/` directory at the workspace root (eve is filesystem-first: the
 * agent IS that directory — `agent/instructions.md`, `agent/tools/*.ts`,
 * `agent/hooks/`, ... — per eve's own getting-started layout). Implemented
 * by wrapping the builder's adapter and tightening its `detect`, rather
 * than growing the builder a one-consumer knob.
 *
 * No version floor: eve is pre-1.0 (0.39.x at integration time) and the
 * `approval` surface `@intutic/gate/eve` targets has no known major-version
 * boundary to gate on — the churn risk is handled by the gate package's own
 * pinned devDependency verification instead (TD-410).
 *
 * PREVIEW-CHURN NOTE (same shield the dsh integration established): eve is a
 * fast-moving preview product. `@intutic/gate/eve` was verified against
 * eve@0.39.1's shipped `.d.ts` — see that module's doc for exactly what was
 * confirmed vs. assumed, and docs/TECH_DEBT.md TD-410/TD-411/TD-412.
 *
 * LLM-egress note carried into the generated `.env.intutic`: eve routes
 * models through the Vercel AI Gateway by default, whose wire protocol the
 * Intutic proxy does not parse — and like the plain Vercel AI SDK it is
 * built on, eve has no env-var base-URL override. Only the in-code
 * direct-provider path (`defineAgent({ model: withIntuticProxy(...)(...) })`)
 * routes through the proxy. See TD-412 and
 * `apps/docs/integrations/eve.md`.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

const base = makeJsSdkGatedAdapter({
  type: HarnessType.EVE,
  label: 'eve',
  requires: [{ name: 'eve' }],
  npmInstall: '@intutic/gate',
  importLine: "import { intuticApproval, intuticAuditHooks } from '@intutic/gate/eve'",
  usageSummary:
    "defineTool({ ..., approval: intuticApproval() }) per tool (and intuticConnectionApproval() " +
    'per MCP/OpenAPI connection) — eve has no agent-level default approval field. NOTE: ' +
    "eve's default AI Gateway model routing is NOT proxy-governable; the vars above only " +
    'reach a direct-provider model built in code via withIntuticProxy(...). PREVIEW product.',
  docsSlug: 'eve',
})

/** Vercel eve adapter — the builder's adapter with a compound `detect`. */
export const eveAdapter: IHarnessAdapter = {
  ...base,

  async detect(workspaceRoot: string): Promise<boolean> {
    if (!(await base.detect(workspaceRoot))) return false
    try {
      return (await stat(join(workspaceRoot, 'agent'))).isDirectory()
    } catch {
      return false // no agent/ directory — an `eve` dep alone is not an eve app
    }
  },
}
