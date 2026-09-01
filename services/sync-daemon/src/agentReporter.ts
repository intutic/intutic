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
import { createHash } from 'node:crypto'
import { newIso } from '@intutic/id'
import {
  scanSkillContent,
  scanScriptContent,
  detectScriptLanguage,
  MAX_SKILL_DIR_DEPTH,
  MAX_FILES_PER_SKILL,
  MAX_SCRIPT_SCAN_BYTES,
  type HarnessType,
} from '@intutic/shared-types'
import { discoverMcpServers } from './harness/mcpAutoWrite.js'
import { gateKindForHarness } from './harness/gateKind.js'

/** Live egress-enforcement status read from the proxy's own diagnostic endpoint. */
export interface EgressFacet {
  mode: string
  denied: number
  would_deny: number
}

/**
 * Summary of the proxy's last scheduled guard-liveness probe run
 * (`GET /intutic/probes`, Wave 6.1 audit-remediation). `ranAt` is the Unix
 * timestamp the *scheduled loop* recorded, not when this fetch ran — a dead
 * loop shows up here as a timestamp that stops advancing, not a fresh
 * "just ran" answer every cycle.
 */
export interface GuardProbesFacet {
  total: number
  failed: number
  ranAt: number
  /** probe_id of every failing probe, capped at 10 — enough to act on
   *  without turning this into an unbounded transcript. */
  failing: string[]
}

interface AgentFacets {
  guardrails: {
    dlp: boolean
    wasm_rules: number
    /**
     * True only when this harness's gate mechanism is `'hook'` (an on-disk
     * file the daemon writes and verified existence of) — kept for older
     * control-plane deployments that read this boolean directly. `false` for
     * `gateKind: 'sdk'` is NOT "this harness is unprotected"; see
     * `gate_kind` below and `harness/gateKind.ts`'s module doc. Previously
     * hardcoded `true` for every harness regardless of mechanism.
     */
    hook_gate: boolean
    /** How this harness's tool calls get gated — see `harness/gateKind.ts`. */
    gate_kind: import('./harness/gateKind.js').GateKind
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
    /**
     * Bundled-script enumeration for this skill (TD-356, Phase S2) — files
     * alongside `SKILL.md` inside the same skill directory, discovered by
     * the same bounded, symlink-skipping walk `discoverSkillBundledFiles`
     * (`tools/cli/src/commands/skill.ts`) uses, and content-scanned via
     * `scanScriptContent` when a recognized language and within
     * `MAX_SCRIPT_SCAN_BYTES`. Omitted (not `{total: 0, ...}`) when the
     * skill has no bundled files at all — `agentPosture.ts`'s `skills`
     * scorer treats an absent facet as "nothing to say," not as a finding.
     */
    scripts?: {
      /** Every bundled file the walk found, scanned or not. */
      total: number
      /** How many of `total` were actually content-scanned — excludes
       *  unreadable files, files over the byte cap (refused, not skipped),
       *  and files whose language `detectScriptLanguage` could not
       *  determine. */
      scanned: number
      /** How many of `scanned` came back with at least one finding. */
      flagged: number
    }
    /**
     * sha256 of the `SKILL.md` content this row describes (Phase S5,
     * TD-357) — lets `services/control-plane/src/routes/agents.ts` look up
     * a previously-judged semantic verdict
     * (`services/semanticSkillAnalysisService.ts`'s `skills:semantic:*`
     * Valkey entry) keyed by the exact content this cycle read, without this
     * daemon ever transmitting the content itself over `/api/v1/agents/report`
     * — only the CLI's `/skills/report` path (opt-in,
     * `semanticSkillAnalysisEnabled`) does that. Absent when `SKILL.md`
     * could not be read.
     */
    sha256?: string
  }>
  loops: { configured: boolean }
  harness: { type: string; config_synced: boolean }
  memory: Array<{ provider: string; configured: boolean }>
  /**
   * Present only when the local proxy answered `GET /intutic/probes`. A
   * sibling of `guardrails`, not a member of it — `guardrails` already names
   * one boolean/count per guard mechanism (dlp, wasm_rules, hook_gate, pcas,
   * egress); guard-liveness is a different axis (did the loaded guards prove
   * themselves against a live probe, on a schedule) and collapsing it into
   * `guardrails` would make `hasOwnProperty` checks there ambiguous between
   * "this guard exists" and "this guard is alive". Absence here (vs. a
   * present-but-empty facet) is itself meaningful to `agentPosture.ts`: no
   * report means `not_enforced`, never a silent pass.
   */
  guardProbes?: GuardProbesFacet
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

/**
 * Read the local proxy's last scheduled guard-liveness probe run
 * (`GET /intutic/probes`, loopback-only — this must run on the same machine
 * as the proxy, exactly like `fetchEgressStatus` above). Best-effort: an
 * unreachable proxy, a 403 (non-loopback — should not happen here), or a 503
 * (suite hasn't run yet, the narrow window right after proxy start) all
 * simply omit the facet rather than reporting a false pass.
 */
export async function fetchGuardProbes(): Promise<GuardProbesFacet | null> {
  let base = process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000'
  while (base.endsWith('/')) base = base.slice(0, -1)
  try {
    const res = await fetch(`${base}/intutic/probes`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const body = (await res.json()) as {
      probes?: unknown
      total?: unknown
      failed?: unknown
      ran_at?: unknown
    }
    if (typeof body.total !== 'number' || typeof body.failed !== 'number' || typeof body.ran_at !== 'number') {
      return null
    }
    const probes = Array.isArray(body.probes) ? body.probes : []
    const failing = probes
      .filter((p): p is { probe_id: unknown; passed: unknown } => typeof p === 'object' && p !== null)
      .filter((p) => p.passed === false && typeof p.probe_id === 'string')
      .map((p) => p.probe_id as string)
      .slice(0, 10)
    return { total: body.total, failed: body.failed, ranAt: body.ran_at, failing }
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
 * Bounded, symlink-skipping walk of one skill directory's bundled files
 * (siblings of `SKILL.md`), content-scanning each one via `scanScriptContent`
 * when its language is recognized and it is within `MAX_SCRIPT_SCAN_BYTES`.
 *
 * TD-356, Phase S2: mirrors `discoverSkillBundledFiles`
 * (`tools/cli/src/commands/skill.ts`) closely — the exact same caps
 * (`MAX_SKILL_DIR_DEPTH`, `MAX_FILES_PER_SKILL`) and symlink-skip discipline
 * (`Dirent.isSymbolicLink()` checked and skipped outright during `readdir`,
 * never stat-ed or resolved — a symlink inside a skill directory could point
 * outside it, or outside the workspace entirely, turning a bounded walk
 * unbounded) — but is its own implementation, not a shared import. This
 * module has no dependency on `tools/cli`; `collectSkills` already
 * re-implements skill-directory discovery independently of the CLI's
 * `discoverSkillFiles` for the same reason, and this walk follows that same
 * precedent rather than introducing a new cross-package dependency for it.
 *
 * Returns `undefined` (not `{total: 0, scanned: 0, flagged: 0}`) when the
 * skill has no bundled files at all, so `collectSkills` can omit `scripts`
 * entirely for the common case of a skill that is only a `SKILL.md` — see
 * that field's own doc comment on the `AgentFacets['skills']` item type.
 */
async function collectSkillScripts(
  skillDir: string,
): Promise<{ total: number; scanned: number; flagged: number } | undefined> {
  const files: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_DIR_DEPTH || files.length >= MAX_FILES_PER_SKILL) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_SKILL) return
      if (entry.isSymbolicLink()) continue // never follow — see this function's doc comment
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (depth === 0 && entry.name === 'SKILL.md') continue
        files.push(full)
      }
    }
  }

  await walk(skillDir, 0)
  if (files.length === 0) return undefined

  let scanned = 0
  let flagged = 0
  for (const filePath of files) {
    let buffer: Buffer
    try {
      buffer = await readFile(filePath)
    } catch {
      continue // unreadable — counted in `total`, not `scanned`
    }
    if (buffer.length > MAX_SCRIPT_SCAN_BYTES) continue // refused, not silently skipped or scanned
    const firstLine = buffer.toString('utf8', 0, Math.min(buffer.length, 200)).split('\n')[0]
    const language = detectScriptLanguage(filePath, firstLine)
    if (language === 'unknown') continue // not a script language this scanner understands
    const result = scanScriptContent(buffer.toString('utf8'), language)
    scanned++
    if (!result.clean) flagged++
  }

  return { total: files.length, scanned, flagged }
}

/**
 * Bundled skills under `<root>/.agents/skills/<name>/SKILL.md`, content-
 * scanned via `scanSkillContent` (`@intutic/shared-types`) on every cycle,
 * plus (TD-356, Phase S2) a bounded enumeration of each skill's bundled
 * scripts via `collectSkillScripts`, attached as the `scripts` facet.
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
 * better than what is actually known. The `scripts` enumeration runs
 * regardless of whether `SKILL.md` itself was readable — a script bundled
 * next to an unreadable `SKILL.md` is still on disk and still a surface to
 * report on.
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
    const skillDir = join(dir, e.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    const scripts = await collectSkillScripts(skillDir)

    try {
      const content = await readFile(skillMdPath, 'utf8')
      const result = scanSkillContent(content)
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
      out.push({
        name: e.name,
        source: '.agents/skills',
        scanned: true,
        clean: result.clean,
        findingsCount: result.findings.length,
        sha256,
        ...(scripts ? { scripts } : {}),
      })
    } catch {
      out.push({
        name: e.name,
        source: '.agents/skills',
        scanned: false,
        clean: false,
        findingsCount: 0,
        ...(scripts ? { scripts } : {}),
      })
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
 * how to parse (see `mcpAutoWrite.ts`'s `discoverMcpServers` — 11 config paths
 * across 9 harnesses), with each server's proxy-wrapped status. Previously
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
  const [wasmRules, sops, skills, mcpTools, vaults, egress, guardProbes] = await Promise.all([
    countWasmRules(),
    collectSops(opts.workspaceRoot),
    collectSkills(opts.workspaceRoot),
    collectMcpTools(opts.workspaceRoot),
    detectLocalVaults(opts.workspaceRoot),
    fetchEgressStatus(),
    fetchGuardProbes(),
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
        // Computed per-harness rather than hardcoded true — see gateKind.ts's
        // module doc for why "the daemon writes the hook gate for every
        // harness it supports" was never actually true (langgraph, aider).
        hook_gate: gateKindForHarness(opts.harnessType) === 'hook',
        gate_kind: gateKindForHarness(opts.harnessType),
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
      ...(guardProbes ? { guardProbes } : {}),
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
