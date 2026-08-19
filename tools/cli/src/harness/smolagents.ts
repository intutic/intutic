/**
 * smolagents.ts — smolagents adapter (env-file config, SDK-side gate).
 *
 * Same shape as langgraph.ts (see sdkGatedAdapter.ts). Detected via the
 * `smolagents` package name.
 *
 * `ToolCallingAgent`'s tools are plain callables — `@guard`/`guard_tools`
 * govern them directly (guard_tools was extended to duck-type `.forward`,
 * since a smolagents `Tool` is otherwise `callable` on its own `__call__`
 * and would have been silently replaced with a bare wrapper function,
 * losing its schema — see framework.py's doc). `CodeAgent` has no discrete
 * tool calls at all; its choke point is the generated Python CODE STRING,
 * gated by `intutic_clawde.gate.adapters.smolagents.IntuticPythonExecutor`
 * (wraps any `PythonExecutor`) — verified live against smolagents==1.26.0 by
 * driving a real `CodeAgent.run()` end to end. See that module's doc (and
 * TD-377) for what governing code TEXT does and does not cover.
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
  pipInstall: 'intutic-clawde[smolagents]',
  importLine: 'from intutic_clawde.gate.adapters.smolagents import IntuticPythonExecutor',
  usageSummary:
    'IntuticPythonExecutor gates CodeAgent\'s generated code text before running it; ' +
    'ToolCallingAgent tools are covered by @guard/guard_tools instead (see TD-377).',
  docsSlug: 'smolagents',
})
