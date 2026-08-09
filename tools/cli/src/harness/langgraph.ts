/**
 * langgraph.ts — LangGraph adapter (env-file config, SDK-side gate).
 *
 * Writes the workspace .env.intutic file with proxy base-URL env vars so
 * LangGraph's ChatOpenAI/ChatAnthropic clients route LLM calls through the
 * Intutic proxy. Trace attribution comes from the `x-intutic-harness:
 * langgraph` header the SDK sends (honoured by the proxy since 0583ef74).
 *
 * Unlike hook-based harnesses, LangGraph has NO on-disk config or hook file
 * the sync daemon can write a tool-call gate into: tools are plain Python
 * callables inside the agent's own process. The blocking gate ships SDK-side
 * in `intutic-clawde` (`intutic_clawde.gate`, python-raise contract), which
 * evaluates the policy snapshot + A3 SOP argPattern rules in-process before
 * the tool body runs — so the env file this adapter writes also carries a
 * comment block pointing developers at that gate.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'

const CONFIG_FILE = '.env.intutic'

/** Dependency manifests scanned for a langgraph/langchain dependency. */
const MANIFEST_FILES = ['pyproject.toml', 'requirements.txt', 'uv.lock']

export const langgraphAdapter: IHarnessAdapter = {
  type: HarnessType.LANGGRAPH,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    for (const manifest of MANIFEST_FILES) {
      try {
        const content = await readFile(join(workspaceRoot, manifest), 'utf-8')
        const lower = content.toLowerCase()
        if (lower.includes('langgraph') || lower.includes('langchain')) return true
      } catch { /* manifest not present */ }
    }
    return false
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const envContent = [
      '# Intutic Governance Rules (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '# Source this file: source .env.intutic',
      '',
      `export ANTHROPIC_BASE_URL="${proxyUrl}"`,
      `export OPENAI_BASE_URL="${proxyUrl}"`,
      `export INTUTIC_PROXY_URL="${proxyUrl}"`,
      `export INTUTIC_SOP_COUNT=${sops.length}`,
      '',
      '# These env vars govern LLM egress only. LangGraph tools run in your own',
      '# Python process, where no config or hook file can gate them — the',
      '# blocking tool gate ships SDK-side:',
      '#   pip install intutic-clawde',
      '#   from intutic_clawde.gate import guard_tools',
      '# guard_tools(tools) refuses denied calls by raising, before the tool',
      '# body runs. See https://docs.intutic.ai/integrations/langgraph',
      '',
    ].join('\n')

    await mkdir(dirname(filePath), { recursive: true })
    const tmpEnv = filePath + '.intutic-tmp'
    await writeFile(tmpEnv, envContent, 'utf-8')
    await rename(tmpEnv, filePath)

    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
