/**
 * aiSdkWorkflow.ts — Vercel `@ai-sdk/workflow` adapter (env-file config,
 * SDK-side gate).
 *
 * Same shape as mastra.ts/vercelAiSdk.ts (see jsSdkGatedAdapter.ts), for
 * Vercel's durable workflow-agent runtime (`WorkflowAgent`): detected via
 * `@ai-sdk/workflow` in `package.json`. The unscoped `workflow` package
 * (the Workflow DevKit runtime, `workflow`/`wf` CLI) is deliberately NOT a
 * detection trigger on its own: the bare name is far too generic to treat as
 * framework evidence (any package named "workflow" in any stack would
 * false-positive), and the durable runtime without `@ai-sdk/workflow` has no
 * WorkflowAgent — nothing this integration's gate applies to. A workspace
 * with both declares `@ai-sdk/workflow` anyway, which is the trigger.
 *
 * DOCUMENTED SEMANTICS carried into the generated `.env.intutic` (confirmed
 * against `@ai-sdk/workflow@1.0.69` + `workflow@4.8.3` — see
 * `@intutic/gate/workflow`'s module doc for the full record): WorkflowAgent
 * has no agent-level approval option; the veto surface is per-tool
 * `needsApproval`, and a refusal thrown from it must be FatalError-compatible
 * or the durable runtime RETRIES the denial toward max attempts.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import { makeJsSdkGatedAdapter } from './jsSdkGatedAdapter.js'

export const aiSdkWorkflowAdapter = makeJsSdkGatedAdapter({
  type: HarnessType.AI_SDK_WORKFLOW,
  label: 'AI SDK Workflow',
  requires: [{ name: '@ai-sdk/workflow' }],
  npmInstall: '@intutic/gate',
  importLine: "import { intuticNeedsApproval, withIntuticApproval } from '@intutic/gate/workflow'",
  usageSummary:
    'new WorkflowAgent({ ..., tools: withIntuticApproval(tools) }) — attaches an async needsApproval ' +
    'per tool (WorkflowAgent itself has no approval option). BLOCK throws a FatalError-compatible ' +
    'refusal so the durable runtime aborts instead of retry-looping the denial; ALLOW resolves ' +
    "false (or true with { onAllow: 'human' } to keep the durable human-approval pause).",
  docsSlug: 'ai-sdk-workflow',
})
