/**
 * agentReporter.ts — register the workspace's agents with the control plane.
 *
 * Each detected harness is a durable agent identity. On the sync loop, the
 * daemon collects the facets it can see locally — the configured guardrails,
 * the role SOPs on disk, the skills bundled into the workspace, the MCP servers
 * declared in the harness config, and the budget tier — and reports them to
 * `POST /api/v1/agents/report`. The control plane rescores posture on each
 * report, so the dashboard ring stays live.
 *
 * The daemon only reports what is locally observable; the control plane owns
 * anything requiring cross-session state (agent-to-agent links from session
 * parentage, spend actuals).
 *
 * @module
 */

import { readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { newIso } from '@intutic/id'
import { scanSkillContent, type HarnessType } from '@intutic/shared-types'
import { discoverMcpServers } from './harness/mcpAutoWrite.js'

/** Live egress-enforcement status read from the proxy's own diagnostic endpoint. */
export interface EgressFacet {
  mode: string
  denied: number
  would_deny: number
}

interface AgentFacets {
  guardrails: {
    dlp: boolean
    wasm_rules: number
    hook_gate: boolean
    pcas: boolean
    /** Present when the local proxy answered GET /intutic/egress (LLD #63 §4). */
    egress?: EgressFacet
  }
  sops: Array<{ sop_id: string; name: string; enforced: boolean }>
  budgets: { tier?: string }
  mcp_tools: Array<{ server: string; harness: string; transport: string; wrapped: boolean }>
  skills: Array<{
    name: string
    source: string
    /** Whether `scanSkillContent` actually ran against this skill's
     *  `SKILL.md`. `false` on a read failure — never omitted, and never
     *  paired with `clean: true`; see `collectSkills` below. */
    scanned: boolean
    /** Only meaningful when `scanned` is `true`. `false` means the content
     *  scan found at least one pattern match (report-only — see
     *  `packages/shared-types/src/skillScan.ts`'s doc comment; nothing here
     *  blocks or modifies the skill). */
    clean: boolean
    /** Count of findings when scanned and not clean; `0` when scanned+clean
     *  or when unscanned (there is nothing to count). */
    findingsCount: number
  }>
  loops: { configured: boolean }
  harness: { type: string; config_synced: boolean }
  memory: Array<{ provider: string; configured: boolean }>
}

export interface AgentReport {
  agentKey: string
  displayName: string
  harnessType: string
  agentRole: string
  facets: AgentFacets
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Read the local proxy's egress-enforcement status (LLD #63 §4). The proxy
 * exposes `{mode, denied, would_deny}` at `GET /intutic/egress`, but nothing
 * plumbed those counters off the machine — this is the wiring that carries them
 * up so an egress denial is visible in the dashboard, not just the proxy log.
 * Best-effort: an unreachable or non-managed proxy simply omits the facet.
 */
export async function fetchEgressStatus(): Promise<EgressFacet | null> {
  // Regex-free trailing-slash trim — CodeQL flags `/\/+$/` as a polynomial
  // pattern even on operator-env input; a loop sidesteps the category.
  let base = process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000'
  while (base.endsWith('/')) base = base.slice(0, -1)
  try {
    const res = await fetch(`${base}/intutic/egress`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const body = (await res.json()) as { mode?: unknown; denied?: unknown; would_deny?: unknown }
    if (typeof body.mode !== 'string') return null
    return {
      mode: body.mode,
      denied: typeof body.denied === 'number' ? body.denied : 0,
      would_deny: typeof body.would_deny === 'number' ? body.would_deny : 0,
    }
  } catch {
    return null
  }
}

/** Count `.wasm` rules under `~/.intutic/wasm` (best-effort). */
async function countWasmRules(): Promise<number> {
  const dir = join(process.env.HOME ?? '', '.intutic', 'wasm')
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => e.endsWith('.wasm')).length
  } catch {
    return 0
  }
}

/** Role SOPs on disk under `<root>/.intutic/sops`. */
async function collectSops(workspaceRoot: string): Promise<AgentFacets['sops']> {
  const dir = join(workspaceRoot, '.intutic', 'sops')
  try {
    const entries = await readdir(dir)
    const out: AgentFacets['sops'] = []
    for (const file of entries.filter((e) => e.endsWith('.md'))) {
      const body = await readFile(join(dir, file), 'utf8').catch(() => '')
      // An SOP is "enforced" if it declares deny_tools or allow_harnesses.
      const enforced = /deny_tools|allow_harnesses/.test(body)
      out.push({ sop_id: file.replace(/\.md$/, ''), name: file, enforced })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Bundled skills under `<root>/.agents/skills/<name>/SKILL.md`, content-
 * scanned via `scanSkillContent` (`@intutic/shared-types`) on every cycle.
 *
 * Report-only, matching `scanSkillContent`'s own doc comment: this function
 * never modifies, blocks, or removes anything — it reads and attaches a
 * verdict for `agentPosture.ts`'s content-aware `skills` scoring to consume.
 *
 * Refusal-not-pass: a `SKILL.md` that cannot be read (permissions, vanished
 * between `readdir` and `readFile`, not a regular file, …) is reported
 * `scanned: false, clean: false` — never `clean: true`, and never silently
 * dropped from the list. An unreadable skill is not a skill the daemon can
 * vouch for, and dropping it would make a workspace's posture score look
 * better than what is actually known.
 */
async function collectSkills(workspaceRoot: string): Promise<AgentFacets['skills']> {
  const dir = join(workspaceRoot, '.agents', 'skills')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs = entries.filter((e) => e.isDirectory())
  const out: AgentFacets['skills'] = []
  for (const e of dirs) {
    const skillMdPath = join(dir, e.name, 'SKILL.md')
    try {
      const content = await readFile(skillMdPath, 'utf8')
      const result = scanSkillContent(content)
      out.push({
        name: e.name,
        source: '.agents/skills',
        scanned: true,
        clean: result.clean,
        findingsCount: result.findings.length,
      })
    } catch {
      out.push({ name: e.name, source: '.agents/skills', scanned: false, clean: false, findingsCount: 0 })
    }
  }
  return out
}

/** Local notes vaults (Obsidian/Logseq/Foam) at or above the workspace root. */
async function detectLocalVaults(workspaceRoot: string): Promise<string[]> {
  const markers = ['.obsidian', '.logseq', '.foam']
  const found: string[] = []
  let dir = workspaceRoot
  for (let depth = 0; depth < 8; depth++) {
    for (const marker of markers) {
      if (await exists(join(dir, marker))) {
        found.push(marker.slice(1))
      }
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return [...new Set(found)]
}

/**
 * MCP servers declared across every harness config format this daemon knows
 * how to parse (see `mcpAutoWrite.ts`'s `discoverMcpServers` — 9 config paths
 * across 8 harnesses), with each server's proxy-wrapped status. Previously
 * this only read 3 hardcoded paths (`.mcp.json`, `.cursor/mcp.json`,
 * `~/.claude.json`) and flattened per declared tool; `discoverMcpServers` is
 * the shared, read-only extraction of the same format knowledge
 * `injectMcpServer` uses to wrap servers, so this reporter's coverage can
 * never silently lag behind what actually gets wrapped.
 */
async function collectMcpTools(workspaceRoot: string): Promise<AgentFacets['mcp_tools']> {
  return discoverMcpServers(workspaceRoot)
}

/**
 * Build a facet report for one harness in the workspace.
 *
 * `dlpEnabled` / `policyEnforced` come from the daemon's known proxy config;
 * the daemon spawns and configures the proxy, so it knows these without a
 * round-trip.
 */
export async function collectAgentReport(opts: {
  workspaceRoot: string
  harnessType: HarnessType
  agentRole?: string
  configSynced: boolean
  dlpEnabled: boolean
  policyEnforced: boolean
  budgetTier?: string
  /** Workspace policy: may local vaults feed /fix? Defaults to allowed. */
  allowLocalVaults?: boolean
}): Promise<AgentReport> {
  const [wasmRules, sops, skills, mcpTools, vaults, egress] = await Promise.all([
    countWasmRules(),
    collectSops(opts.workspaceRoot),
    collectSkills(opts.workspaceRoot),
    collectMcpTools(opts.workspaceRoot),
    detectLocalVaults(opts.workspaceRoot),
    fetchEgressStatus(),
  ])

  const role = opts.agentRole ?? ''
  return {
    agentKey: `${opts.harnessType}:${role || 'default'}`,
    displayName: role ? `${opts.harnessType} (${role})` : opts.harnessType,
    harnessType: opts.harnessType,
    agentRole: role,
    facets: {
      guardrails: {
        dlp: opts.dlpEnabled,
        wasm_rules: wasmRules,
        hook_gate: true, // the daemon writes the hook gate for every harness it supports
        pcas: opts.policyEnforced,
        // Present only when the local proxy answered; an egress denial thus
        // becomes visible in the dashboard, not just the proxy's own log.
        ...(egress ? { egress } : {}),
      },
      sops,
      budgets: { tier: opts.budgetTier },
      mcp_tools: mcpTools,
      skills,
      loops: { configured: false }, // set by the loops feature when a run is active
      harness: { type: opts.harnessType, config_synced: opts.configSynced },
      // Visibility, not content: which vault kinds exist near the workspace,
      // and whether workspace policy lets them feed /fix. Note names/content
      // never leave the machine.
      memory:
        opts.allowLocalVaults === false
          ? []
          : vaults.map((kind) => ({ provider: `local-vault:${kind}`, configured: true })),
    },
  }
}

/** POST a report to the control plane. Non-fatal on failure (mirrors reportStatus). */
export async function reportAgent(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
  report: AgentReport,
): Promise<void> {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/v1/agents/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...report, reportedAt: newIso() }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[sync-daemon] reportAgent failed for ${report.agentKey}: ${res.status}`)
    }
  } catch (err) {
    console.warn(`[sync-daemon] reportAgent error for ${report.agentKey}:`, err instanceof Error ? err.message : err)
  }
}
