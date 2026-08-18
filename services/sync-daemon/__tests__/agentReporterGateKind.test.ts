/**
 * agentReporterGateKind.test.ts — `collectAgentReport`'s guardrails facet
 * reports the correct `hook_gate`/`gate_kind` per harness, instead of the
 * previous hardcoded `hook_gate: true` for every harness.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectAgentReport } from '../src/agentReporter.js'

describe('collectAgentReport — guardrails.hook_gate / guardrails.gate_kind', () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(join(tmpdir(), 'intutic-agent-reporter-gatekind-'))
  })

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  it('reports hook_gate:true, gate_kind:"hook" for a hook-based harness (claude-code)', async () => {
    const r = await collectAgentReport({
      workspaceRoot,
      harnessType: 'claude-code',
      configSynced: true,
      dlpEnabled: false,
      policyEnforced: false,
    })
    expect(r.facets.guardrails.hook_gate).toBe(true)
    expect(r.facets.guardrails.gate_kind).toBe('hook')
  })

  it('reports hook_gate:false, gate_kind:"sdk" for LangGraph — no on-disk hook file exists', async () => {
    const r = await collectAgentReport({
      workspaceRoot,
      harnessType: 'langgraph',
      configSynced: true,
      dlpEnabled: false,
      policyEnforced: false,
    })
    expect(r.facets.guardrails.hook_gate).toBe(false)
    expect(r.facets.guardrails.gate_kind).toBe('sdk')
  })

  it('reports hook_gate:false, gate_kind:"sdk" for every Wave 1 SDK-gated harness', async () => {
    for (const harnessType of [
      'langchain',
      'crewai',
      'autogen',
      'ag2',
      'google-adk',
      'openai-agents',
      'pydantic-ai',
      'smolagents',
    ] as const) {
      const r = await collectAgentReport({
        workspaceRoot,
        harnessType,
        configSynced: true,
        dlpEnabled: false,
        policyEnforced: false,
      })
      expect(r.facets.guardrails.hook_gate, harnessType).toBe(false)
      expect(r.facets.guardrails.gate_kind, harnessType).toBe('sdk')
    }
  })

  it('reports hook_gate:false, gate_kind:"none" for aider — it has no tool-call gate at all', async () => {
    const r = await collectAgentReport({
      workspaceRoot,
      harnessType: 'aider',
      configSynced: true,
      dlpEnabled: false,
      policyEnforced: false,
    })
    expect(r.facets.guardrails.hook_gate).toBe(false)
    expect(r.facets.guardrails.gate_kind).toBe('none')
  })
})
