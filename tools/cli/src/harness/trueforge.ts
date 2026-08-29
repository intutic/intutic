/**
 * trueforge.ts — TrueForge (embedded) adapter (env-file config, SDK-side gate).
 *
 * Same shape as mastra.ts/vercelAiSdk.ts (see jsSdkGatedAdapter.ts): detected
 * via `@truefoundry/trueforge-core` in `package.json`, and points at
 * `@intutic/gate/trueforge`'s `intuticApprovalResponder()` rather than an
 * `intutic-clawde` import.
 *
 * Covers ONLY the embedded-library deployment mode — another team's Node
 * process importing `@truefoundry/trueforge-core` directly. TrueForge run as
 * its own standalone/hosted server (`npx @truefoundry/trueforge`, Docker
 * Compose, or the Helm chart) is a separate, not-yet-built HarnessType and is
 * NOT detected by this adapter.
 *
 * NOTE (confirmed against a real install, `@truefoundry/trueforge-core@0.1.4`):
 * unlike Mastra's `beforeToolCall`/Vercel AI SDK's `toolApproval`, TrueForge
 * has no synchronous in-process approval callback at all — the gate is a
 * batch responder answering `tool.approval_required` turn pauses. See
 * `@intutic/gate/trueforge`'s module doc for the full record.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

export const trueforgeAdapter = makeJsSdkGatedAdapter({
  type: HarnessType.TRUEFORGE,
  label: 'TrueForge (embedded)',
  requires: [{ name: '@truefoundry/trueforge-core' }],
  npmInstall: '@intutic/gate',
  importLine: "import { intuticApprovalResponder } from '@intutic/gate/trueforge'",
  usageSummary:
    'intuticApprovalResponder() answers tool.approval_required pauses with a real ' +
    'Gate.guard() verdict, producing user.tool_approval items for your next ' +
    "session.createTurn() call. NOTE: TrueForge has no synchronous approval callback to " +
    'hang a function off — this is a batch responder, not a beforeToolCall/toolApproval ' +
    'option. Covers embedded-library mode only; the standalone/hosted server is not yet ' +
    'supported.',
  docsSlug: 'trueforge',
})
