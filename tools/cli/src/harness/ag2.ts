/**
 * ag2.ts — AG2 adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). "ag2" is a short
 * package name that would false-positive as a plain substring test (e.g.
 * inside "flag2" or a version string like "...ag2..."), so detection uses a
 * boundary-aware regex instead of `keywords.includes('ag2')` — see
 * sdkGatedAdapter.ts's `ManifestMatcher` type.
 *
 * Note: AG2 was found to be a from-scratch rewrite at the version installed
 * to build this adapter (ag2==1.0.2) — it no longer imports as `autogen` and
 * shares no API with the ConversableAgent/GroupChat shape most AG2/pyautogen
 * tutorials still describe. The blocking gate ships SDK-side via
 * `intutic_clawde.gate.adapters.ag2.IntuticMiddleware`, an ag2
 * `BaseMiddleware.on_tool_execution`, matched to that current architecture
 * (see ag2.py's module doc; TD-376 tracks one unverified caveat).
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
  pipInstall: 'intutic-clawde[ag2]',
  importLine: 'from intutic_clawde.gate.adapters.ag2 import IntuticMiddleware',
  usageSummary:
    'Agent(middleware=[IntuticMiddleware]) vetoes a tool call via on_tool_execution before it runs.',
  docsSlug: 'ag2',
})
