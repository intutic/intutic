/**
 * Intutic CLI — Skill Management and Loop Engineering Governance Commands.
 *
 * LLD Phase 8 — Loop Engineering & Ingestion Proposals
 */

import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { getIntuticDir, resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import {
  scanSkillContent,
  SKILL_SCAN_PATTERNS,
  scanScriptContent,
  SCRIPT_SCAN_PATTERNS,
  detectScriptLanguage,
  MAX_SKILL_DIR_DEPTH,
  MAX_FILES_PER_SKILL,
  MAX_SCRIPT_SCAN_BYTES,
  type SkillScanFinding,
  type SkillScanCategory,
  type ScriptLanguage,
} from '@intutic/shared-types'
import {
  ciscoScannerOnPath,
  runCiscoScan,
  combineCiscoSarifRuns,
  type CiscoDirScanResult,
} from '../lib/ciscoScanner.js'
import pc from 'picocolors'

// ─── Shared response shapes ──────────────────────────────────────────

/**
 * One row of the local skill/rule-file inventory reported to the control
 * plane by `POST /api/v1/workspaces/:id/skills/report`.
 */
export interface SkillReportEntry {
  /** Path relative to the workspace root, e.g. `CLAUDE.md`. */
  filePath: string
  /** Line count of the file as scanned. */
  linesCount: number
  /** Audit findings in this file; always 0 for `skill list`, which only counts. */
  issuesDetected: number
  /**
   * Bounded findings from `scanSkillContent` (`@intutic/shared-types`), for
   * real `.agents/skills/**\/SKILL.md` / `.claude/skills/**\/SKILL.md` skill
   * files. Absent for the legacy rule-file rows, which keep the coarse
   * regex audit above — never full skill content, see `scanSkillContent`'s
   * own doc comment.
   */
  findings?: SkillScanFinding[]
  /** sha256 of the file content at scan time, so a consumer can tell which
   *  content a set of findings refers to without re-uploading it. */
  sha256?: string
  /**
   * `false` when the file could not be read (permissions, vanished between
   * discovery and read, etc). Refusal-not-pass: an unscanned file MUST NOT
   * be reported as `issuesDetected: 0` implying safety — that would read as
   * "scanned and clean" to anything downstream. Omitted (not `false`) for
   * the legacy rule-file rows and for successfully scanned skill files, so
   * `scanned === false` unambiguously means "we could not tell."
   */
  scanned?: boolean
  /**
   * Which surface this row describes. `'skill_md'` for a skill's
   * `SKILL.md`, `'script'` for a bundled file discovered by
   * `discoverSkillBundledFiles` and audited by `auditScriptFile`. Absent for
   * the legacy rule-file rows (`.cursorrules`, `CLAUDE.md`, etc), which
   * predate this distinction and are neither.
   */
  kind?: 'skill_md' | 'script'
  /**
   * The script language `detectScriptLanguage` (`@intutic/shared-types`)
   * inferred for a `kind: 'script'` row — `'unknown'` when neither the
   * extension nor a shebang resolved (still hashed, never scanned; see
   * `auditScriptFile`). Absent for anything that isn't a script row.
   */
  language?: string
  /**
   * Phase S5 (TD-357). FULL content of a `kind: 'skill_md'` file, attached
   * ONLY when the workspace has `semanticSkillAnalysisEnabled` on (read from
   * `client.fetchConfig`'s resolved `settings`, the same way
   * `enableLocalSkillAuditDelete` already is below) — never for `kind:
   * 'script'` rows, which stay S2/S3/S4's domain. Capped client-side to the
   * same 65536-char bound `SkillFileReportSchema` enforces server-side
   * (`services/control-plane/src/routes/harnessConfig.ts`), so an oversized
   * file 400s never a request; it is silently capped, the same
   * refusal-vs-cap posture `capContentForTransport`'s own doc comment
   * explains.
   */
  content?: string
}

/**
 * Cap a skill's content to the same bound the control plane's
 * `SkillFileReportSchema` enforces (`z.string().max(65536)`) before it ever
 * leaves this machine — truncating client-side rather than letting an
 * oversized file 400 the whole report. `content` is judged, then stripped
 * before persistence server-side either way (see that schema's own doc
 * comment); a truncated judge input is a weaker signal, never a stored
 * artifact, so silent truncation here is the same tradeoff
 * `mirrorAdoptionService.ts`'s own `capBytes` makes for judge prompt fields.
 */
const MAX_SKILL_CONTENT_TRANSPORT_CHARS = 65536

export function capContentForTransport(content: string): string {
  return content.length > MAX_SKILL_CONTENT_TRANSPORT_CHARS
    ? content.slice(0, MAX_SKILL_CONTENT_TRANSPORT_CHARS)
    : content
}

/** Where bundled skill directories live, mirroring the conventions
 *  `services/sync-daemon/src/agentReporter.ts`'s `collectSkills` already
 *  uses for `.agents/skills`, plus Claude Code's own `.claude/skills`. Each
 *  entry directly under the root is a skill; `SKILL.md` is its content. */
const SKILL_DIRECTORY_ROOTS: ReadonlyArray<{ dir: string; source: string }> = [
  { dir: '.agents/skills', source: '.agents/skills' },
  { dir: '.claude/skills', source: '.claude/skills' },
]

export interface DiscoveredSkillFile {
  /** Path relative to the workspace root, e.g. `.agents/skills/foo/SKILL.md`. */
  filePath: string
  fullPath: string
  source: string
}

/**
 * Read, content-scan, and (if `prune` is set and the scan is not clean)
 * auto-prune one real skill file. Extracted from `runSkillAudit` so the
 * discovery/read/scan/report path is testable without the network and
 * credentials setup the full command does.
 *
 * Refusal-not-pass: a read failure returns `scanned: false` with
 * `issuesDetected: 0` — the zero is not a clean bill of health, it is "we
 * never got to look." Callers must treat `scanned: false` as its own status,
 * never as `clean`.
 */
export async function auditSkillFile(
  filePath: string,
  fullPath: string,
  prune: boolean,
  /** Suppresses the per-finding `log.warn` narrative. Used by `--sarif`
   *  (`runSkillAudit`), whose stdout contract is a single JSON document — a
   *  CI tool piping that into a SARIF parser must not see decorated text
   *  interleaved with it. Findings are still returned; only the console
   *  narration is skipped. Defaults to `false` so every existing caller
   *  (including the tests that assert on `log.warn` output indirectly via
   *  behaviour) is unaffected. */
  quiet = false,
  /**
   * Phase S5 (TD-357). Attach the file's full content to the returned entry
   * — only ever set by a caller that already confirmed
   * `semanticSkillAnalysisEnabled` for this workspace (`runSkillAudit`
   * below reads it off `client.fetchConfig`'s resolved settings, the same
   * way it already reads `enableLocalSkillAuditDelete`). Defaults to
   * `false` so every existing caller/test is unaffected. */
  attachContent = false,
): Promise<SkillReportEntry> {
  let content: string
  try {
    content = await fs.readFile(fullPath, 'utf8')
  } catch (err) {
    if (!quiet) {
      log.warn(
        `[${filePath}] Could not be read (${err instanceof Error ? err.message : String(err)}) — reported as unscanned, not clean.`,
      )
    }
    return { filePath, linesCount: 0, issuesDetected: 0, scanned: false, kind: 'skill_md' }
  }

  const contentLines = content.split('\n')
  const result = scanSkillContent(content)
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')

  if (!result.clean && !quiet) {
    for (const finding of result.findings) {
      log.warn(
        `[${filePath}] ${finding.category} finding (${finding.patternId})${finding.excerpt ? `: ${finding.excerpt}` : ''}`,
      )
    }
  }

  // Auto-prune worthy findings, same opt-in as the legacy rule-file audit:
  // drop any LINE that itself trips a pattern, line-by-line — mirroring the
  // existing per-line re-scan below rather than deleting the whole file,
  // since a skill missing a few flagged lines still functions.
  if (!result.clean && prune) {
    let fileUpdated = false
    const filteredLines = contentLines.filter((line) => {
      if (!scanSkillContent(line).clean) {
        fileUpdated = true
        return false
      }
      return true
    })
    if (fileUpdated) {
      await fs.writeFile(fullPath, filteredLines.join('\n'), 'utf8')
      if (!quiet) log.success(`[${filePath}] Auto-pruned lines flagged by the skill-content scan.`)
    }
  }

  return {
    filePath,
    linesCount: contentLines.length,
    issuesDetected: result.findings.length,
    findings: result.findings,
    sha256,
    scanned: true,
    kind: 'skill_md',
    ...(attachContent ? { content: capContentForTransport(content) } : {}),
  }
}

/** Enumerate real `SKILL.md` files under both skill directory roots. A
 *  missing root is not an error — most workspaces have neither. Exported so
 *  tests can walk a fixture directory tree without going through the full
 *  `skill audit`/`skill list` command (credentials, network, etc). */
export async function discoverSkillFiles(workspaceRoot: string): Promise<DiscoveredSkillFile[]> {
  const out: DiscoveredSkillFile[] = []
  for (const root of SKILL_DIRECTORY_ROOTS) {
    const dir = join(workspaceRoot, root.dir)
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filePath = join(root.dir, entry.name, 'SKILL.md')
      const fullPath = join(workspaceRoot, filePath)
      if (existsSync(fullPath)) {
        out.push({ filePath, fullPath, source: root.source })
      }
    }
  }
  return out
}

/** One bundled file discovered alongside a skill's `SKILL.md`. */
export interface DiscoveredScriptFile {
  /** Path relative to the workspace root. */
  filePath: string
  fullPath: string
}

/**
 * Bounded, symlink-skipping recursive walk of a skill directory's sibling
 * files — everything alongside `SKILL.md`, the surface TD-356
 * (`docs/TECH_DEBT.md`) named as unenumerated. `SKILL.md` itself is excluded
 * (it is already covered by `discoverSkillFiles`/`auditSkillFile` above);
 * everything else found, at any depth up to the cap, is a candidate for
 * `auditScriptFile`.
 *
 * Bounded by `MAX_SKILL_DIR_DEPTH` and `MAX_FILES_PER_SKILL`
 * (`@intutic/shared-types`) — a skill directory is developer-authored
 * content, not something this command should ever walk unboundedly. Depth 0
 * is the skill directory itself; nested subdirectories increment from
 * there, and the walk stops recursing once depth exceeds the cap.
 *
 * Symlinks are never followed: `Dirent.isSymbolicLink()` is checked during
 * `readdir` and skipped outright, without ever stat-ing or resolving where
 * the link points. A symlink inside a skill directory could point outside
 * that directory — or outside the workspace entirely — which would turn a
 * bounded, skill-scoped walk into an effectively unbounded one, and would
 * let a skill directory "bundle" a script that does not actually live on
 * disk inside it.
 */
export async function discoverSkillBundledFiles(
  workspaceRoot: string,
  /** Path to the skill directory (not `SKILL.md` itself), relative to
   *  `workspaceRoot`, e.g. `.agents/skills/my-skill`. */
  skillDirPath: string,
): Promise<DiscoveredScriptFile[]> {
  const out: DiscoveredScriptFile[] = []

  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_DIR_DEPTH || out.length >= MAX_FILES_PER_SKILL) return

    let entries
    try {
      entries = await fs.readdir(join(workspaceRoot, relDir), { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_SKILL) return
      if (entry.isSymbolicLink()) continue // never follow — see doc comment above

      const relPath = join(relDir, entry.name)
      if (entry.isDirectory()) {
        await walk(relPath, depth + 1)
      } else if (entry.isFile()) {
        if (depth === 0 && entry.name === 'SKILL.md') continue
        out.push({ filePath: relPath, fullPath: join(workspaceRoot, relPath) })
      }
    }
  }

  await walk(skillDirPath, 0)
  return out
}

/**
 * Read, hash, and — when recognized and within the byte cap — content-scan
 * one bundled script file discovered by `discoverSkillBundledFiles`.
 *
 * The sha256 hash is ALWAYS computed, even for a file this scanner cannot
 * itself interpret (a binary, an unrecognized extension with no useful
 * shebang) — that is deliberate, not a leftover from a simpler version of
 * this function. A later, separate, opt-in phase (Cisco `skill-scanner` /
 * VirusTotal-style hash lookup, Phase S3) needs the hash of every bundled
 * file regardless of whether THIS scanner's regex patterns can say anything
 * about its content.
 *
 * Refusal-not-pass, same contract as `auditSkillFile`: a read failure, a
 * file over `MAX_SCRIPT_SCAN_BYTES`, or an unrecognized language all return
 * `scanned: false` — never folded into `issuesDetected: 0` implying safety.
 * A file over the byte cap is a REFUSAL to look, reported as such, not a
 * silent skip and not a false "clean".
 */
export async function auditScriptFile(
  filePath: string,
  fullPath: string,
  quiet = false,
): Promise<SkillReportEntry> {
  let buffer: Buffer
  try {
    buffer = await fs.readFile(fullPath)
  } catch (err) {
    if (!quiet) {
      log.warn(
        `[${filePath}] Could not be read (${err instanceof Error ? err.message : String(err)}) — reported as unscanned, not clean.`,
      )
    }
    return { filePath, linesCount: 0, issuesDetected: 0, scanned: false, kind: 'script' }
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const firstLine = buffer.toString('utf8', 0, Math.min(buffer.length, 200)).split('\n')[0]
  const language: ScriptLanguage = detectScriptLanguage(filePath, firstLine)

  if (buffer.length > MAX_SCRIPT_SCAN_BYTES) {
    if (!quiet) {
      log.warn(
        `[${filePath}] Exceeds the ${MAX_SCRIPT_SCAN_BYTES}-byte script scan cap — refusing to scan (hash recorded).`,
      )
    }
    return { filePath, linesCount: 0, issuesDetected: 0, sha256, scanned: false, kind: 'script', language }
  }

  if (language === 'unknown') {
    // Not a script language this scanner understands (binary, data file,
    // unrecognized extension with no useful shebang) — hash-only, same
    // refusal-not-pass status as an over-cap file.
    return { filePath, linesCount: 0, issuesDetected: 0, sha256, scanned: false, kind: 'script', language }
  }

  const content = buffer.toString('utf8')
  const contentLines = content.split('\n')
  const result = scanScriptContent(content, language)

  if (!result.clean && !quiet) {
    for (const finding of result.findings) {
      log.warn(
        `[${filePath}] ${finding.category} finding (${finding.patternId})${finding.excerpt ? `: ${finding.excerpt}` : ''}`,
      )
    }
  }

  return {
    filePath,
    linesCount: contentLines.length,
    issuesDetected: result.findings.length,
    findings: result.findings,
    sha256,
    scanned: true,
    kind: 'script',
    language,
  }
}

/**
 * A loop run as returned by `GET /api/v1/loops`.
 *
 * `totalTokenCostUsd` and `budgetLimitUsd` are strings, not numbers: both are
 * Postgres `numeric` columns, which the driver hands back as strings to keep
 * the scale exact — hence the `parseFloat` at every use site.
 */
export interface LoopRunSummary {
  loopRunId: string
  name: string
  /**
   * PENDING_REVIEW is the only non-ACTIVE status that is not terminal — see
   * `LoopRunDetails` in the control plane's loopGovernanceService.
   */
  status: 'ACTIVE' | 'PENDING_REVIEW' | 'COMPLETED' | 'FAILED' | 'KILLED'
  totalTokenCostUsd: string
  budgetLimitUsd: string
}

/** Envelope of `GET /api/v1/loops`. */
export interface LoopListResponse {
  ok: boolean
  loops: LoopRunSummary[]
}

// ─── Skill Commands ──────────────────────────────────────────────────

export async function runSkillList(): Promise<void> {
  log.header('Intutic — Skill Discovery')
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()

  const filesToScan = [
    '.cursorrules',
    'CLAUDE.md',
    '.windsurfrules',
    '.clauderules',
    'rules.md',
  ]

  const skillsReport: SkillReportEntry[] = []
  let found = 0

  for (const file of filesToScan) {
    const fullPath = join(workspaceRoot, file)
    if (existsSync(fullPath)) {
      found++
      const content = await fs.readFile(fullPath, 'utf8')
      const lines = content.split('\n')
      console.log(`  ${pc.green('✔')} ${pc.bold(file)} (${lines.length} lines)`)
      skillsReport.push({
        filePath: file,
        linesCount: lines.length,
        issuesDetected: 0,
      })
    }
  }

  // Real skill directories (`.agents/skills`, `.claude/skills`) — discovery
  // only here, matching the existing "list only counts" contract for this
  // command; content scanning happens in `skill audit` below.
  const skillFiles = await discoverSkillFiles(workspaceRoot)
  for (const { filePath } of skillFiles) {
    found++
    let lines = 0
    try {
      lines = (await fs.readFile(join(workspaceRoot, filePath), 'utf8')).split('\n').length
    } catch {
      // Discovery already found the directory entry; a read failure here
      // just means we can't report a line count.
    }
    console.log(`  ${pc.green('✔')} ${pc.bold(filePath)} (${lines} lines)`)
    skillsReport.push({ filePath, linesCount: lines, issuesDetected: 0 })
  }

  if (found === 0) {
    log.info('No active skill or rule files found in workspace root.')
  } else {
    log.success(`Discovered ${found} local harness configuration/skill files.`)
  }

  // Report discovered skills to the Control Plane
  const creds = await loadCredentials().catch(() => null)
  if (creds && skillsReport.length > 0) {
    try {
      const client = await getClient(config?.devMode)
      await client.post(`/api/v1/workspaces/${creds.workspaceId}/skills/report`, { skills: skillsReport })
      log.dim('Reported local skills to Intutic control plane.')
    } catch {
      // Non-blocking: discovery already printed everything the user asked for,
      // and the report is a convenience for the dashboard.
    }
  }
}

/**
 * A minimal, valid SARIF 2.1.0 document for CI/code-scanning interop.
 *
 * Built for GitHub Code Scanning and any other consumer of the format — not
 * for Cisco's open-source `skill-scanner` project specifically, but so that
 * tool's findings and ours can land in the same code-scanning pane on a repo
 * that runs both. We do not shell out to or depend on that project; this is
 * only a compatible OUTPUT shape.
 *
 * `rules` lists every pattern `scanSkillContent` knows how to report —
 * SARIF's convention is the tool's full rule catalog, not only the ids that
 * fired in this run, so a code-scanning UI can show a rule as "0 findings"
 * rather than "unknown rule". `results` is built only from real skill files
 * (`SkillReportEntry.findings`, populated by `auditSkillFile`); the legacy
 * `.cursorrules`/`CLAUDE.md` regex checks above have no pattern ids and stay
 * out of SARIF for that reason — see the entries' own `findings` being
 * absent, not an omission here.
 *
 * `locations` deliberately carries no `region`: `SkillScanFinding` bounds an
 * excerpt (see `skillScan.ts`'s `excerptFor`) but not a line/column, and
 * SARIF's `region` is optional — fabricating `startLine: 1` would claim a
 * precision this scanner does not have.
 *
 * `additionalRuns` (Phase S3): zero or more extra SARIF `runs[]`-shaped
 * objects appended AFTER this codebase's own run — the Cisco skill-scanner
 * integration's combined run, when that engine ran. SARIF is explicitly
 * designed to carry multiple runs from different tools in one document, so
 * these are appended AS-IS, never translated or merged into this function's
 * own `results`/`rules` — that translation only happens for the internal
 * `SkillScanFinding` representation (`mergeCiscoFindings`), never for this
 * output mode.
 */
export function buildSarifLog(entries: readonly SkillReportEntry[], additionalRuns: readonly unknown[] = []): object {
  const results = entries.flatMap((entry) =>
    (entry.findings ?? []).map((finding) => ({
      ruleId: finding.patternId,
      level: 'warning',
      message: {
        text: finding.excerpt
          ? `${finding.category} finding: ${finding.excerpt}`
          : `${finding.category} finding (${finding.patternId})`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: entry.filePath },
          },
        },
      ],
    })),
  )

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'intutic-skill-scan',
            informationUri: 'https://intutic.ai',
            // The rule catalog is the union of both pattern tables — SARIF's
            // convention is one driver's full rule set, not just the ids
            // that fired this run, so a code-scanning UI can show a rule as
            // "0 findings" rather than "unknown rule". Bundled-script
            // findings (Phase S2, `SCRIPT_SCAN_PATTERNS`) land in the same
            // `intutic-skill-scan` driver as `SKILL.md` content findings —
            // one driver name, not a second tool, since both are the same
            // "scan agent-loaded content for these threat shapes" capability.
            rules: [...SKILL_SCAN_PATTERNS, ...SCRIPT_SCAN_PATTERNS].map((pattern) => ({
              id: pattern.id,
              shortDescription: { text: pattern.description },
              defaultConfiguration: { level: 'warning' },
              properties: { category: pattern.category },
            })),
          },
        },
        // Present and empty, never omitted, when nothing was flagged — a
        // missing `results` key reads to some SARIF consumers as "the tool
        // did not run" rather than "the tool ran and found nothing".
        results,
      },
      ...additionalRuns,
    ],
  }
}

/**
 * Longest excerpt a Cisco finding's `message` is trimmed to before becoming
 * a `SkillScanFinding.excerpt`. Matches the control plane's
 * `SkillScanFindingSchema.excerpt` cap (`harnessConfig.ts`) — this codebase's
 * own findings bound their excerpt to ~40 chars of surrounding context
 * (`EXCERPT_RADIUS`, `skillScan.ts`), but a Cisco `message.text` is a full
 * LLM-authored sentence, not a regex match window, so this cap is generous
 * rather than matching that radius — it exists to reject an attempt to
 * smuggle something much larger through this field, not to enforce a tight
 * budget on a legitimate finding description.
 */
const CISCO_EXCERPT_CAP = 2000

/**
 * Maps the real `skill-scanner` category taxonomy — the `ThreatCategory`
 * enum in the installed 2.0.13 package's `skill_scanner/core/models.py`,
 * carried on each SARIF result's `properties.category` (see
 * `lib/ciscoScanner.ts`'s module doc comment for how it's extracted) — onto
 * this codebase's own three-category taxonomy. `prompt_injection` covers
 * deception/manipulation vectors (including ones aimed at a human or the
 * discovery/trust mechanism itself, not just the model); `data_exfiltration`
 * covers anything about data or credentials leaving; everything else
 * (execution, abuse, supply-chain, or genuinely uncategorizable) falls back
 * to `'malicious_code'`, the broadest of the three buckets.
 */
const CISCO_CATEGORY_MAP: Readonly<Record<string, SkillScanCategory>> = {
  prompt_injection: 'prompt_injection',
  social_engineering: 'prompt_injection',
  harmful_content: 'prompt_injection',
  skill_discovery_abuse: 'prompt_injection',
  transitive_trust_abuse: 'prompt_injection',
  unicode_steganography: 'prompt_injection',
  data_exfiltration: 'data_exfiltration',
  hardcoded_secrets: 'data_exfiltration',
  command_injection: 'malicious_code',
  unauthorized_tool_use: 'malicious_code',
  obfuscation: 'malicious_code',
  resource_abuse: 'malicious_code',
  policy_violation: 'malicious_code',
  malware: 'malicious_code',
  autonomy_abuse: 'malicious_code',
  tool_chaining_abuse: 'malicious_code',
  supply_chain_attack: 'malicious_code',
}

/** See {@link CISCO_CATEGORY_MAP}. Exported for tests. */
export function mapCiscoCategory(category: string | undefined): SkillScanCategory {
  if (!category) return 'malicious_code'
  return CISCO_CATEGORY_MAP[category] ?? 'malicious_code'
}

/**
 * Merges one skill directory's Cisco findings into that skill's existing
 * report entries — the `SKILL.md` row, or a bundled-script row when a
 * finding's own location matches one of `candidateEntries` exactly. Falls
 * back to `fallbackEntry` (always the skill's `SKILL.md` row) when no
 * location match is found — this codebase does not assume `skill-scanner`
 * always attributes a finding to a specific bundled file, so an
 * unmatched/absent location is treated as "belongs to the skill as a
 * whole," not an error.
 *
 * Each Cisco finding becomes a `SkillScanFinding` with `patternId: 'cisco.'
 * + ruleId`, a category from {@link mapCiscoCategory} (mapped from the
 * finding's own `category`, not its `ruleId`), an excerpt capped at
 * {@link CISCO_EXCERPT_CAP}, and `engine: 'cisco-skill-scanner'` — this
 * codebase's own findings stamp `engine: 'native'` at construction
 * (`skillScan.ts`/`scriptScan.ts`), so every finding in a report entry now
 * carries its provenance.
 *
 * Returns the number of findings merged, for the caller's running `issues`
 * count.
 */
export function mergeCiscoFindings(
  candidateEntries: readonly SkillReportEntry[],
  fallbackEntry: SkillReportEntry,
  ciscoResult: CiscoDirScanResult,
  workspaceRoot: string,
): number {
  if (!ciscoResult.ok) return 0

  for (const finding of ciscoResult.findings) {
    const mapped: SkillScanFinding = {
      patternId: `cisco.${finding.ruleId}`,
      category: mapCiscoCategory(finding.category),
      excerpt: finding.message.slice(0, CISCO_EXCERPT_CAP) || undefined,
      engine: 'cisco-skill-scanner',
    }

    let target: SkillReportEntry | undefined
    if (finding.filePath) {
      const relPath = finding.filePath.startsWith(workspaceRoot)
        ? finding.filePath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
        : finding.filePath
      target = candidateEntries.find((e) => e.filePath === relPath)
    }
    target ??= fallbackEntry

    target.findings = [...(target.findings ?? []), mapped]
    target.issuesDetected += 1
  }

  return ciscoResult.findings.length
}

export async function runSkillAudit(opts: { sarif?: boolean; engine?: 'native' | 'cisco' } = {}): Promise<void> {
  const sarif = opts.sarif === true
  // SARIF's contract is a single JSON document on stdout — a CI tool piping
  // this into a code-scanning upload must not see decorated progress text
  // interleaved with it. Every narrative call below is gated on `!sarif`;
  // findings are still collected and reported identically either way.
  if (!sarif) log.header('Intutic — Skill Security Audit')
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()

  const creds = await loadCredentials().catch(() => null)
  let enableLocalSkillAuditDelete = false
  let ciscoSkillScannerEnabled = false
  // Phase S5 (TD-357): gates whether `auditSkillFile` below attaches full
  // `SKILL.md` content to its report entry. Off unless the workspace opted
  // in — see `WorkspaceSettings.semanticSkillAnalysisEnabled`'s own doc
  // comment for what turning it on transmits.
  let semanticSkillAnalysisEnabled = false

  // Fetch workspace settings to see if auto-delete / the Cisco auto-run /
  // semantic analysis are enabled
  if (creds) {
    try {
      const client = await getClient(config?.devMode)
      const syncConfig = await client.fetchConfig(creds.workspaceId)
      enableLocalSkillAuditDelete = syncConfig.settings?.enableLocalSkillAuditDelete ?? false
      ciscoSkillScannerEnabled = syncConfig.settings?.ciscoSkillScannerEnabled ?? false
      semanticSkillAnalysisEnabled = syncConfig.settings?.semanticSkillAnalysisEnabled ?? false
    } catch {
      // fallback to false
    }
  }

  // ── Cisco skill-scanner engine resolution (Phase S3) ──────────────────
  //
  // Native scanning always runs — it is this command's baseline and always
  // available. The Cisco engine additionally runs when EITHER:
  //   - `--engine cisco` was explicitly passed: a LOUD failure (non-zero
  //     exit) if the binary is absent, since the user explicitly asked for
  //     this engine and a silent skip would look like a clean scan.
  //   - the `ciscoSkillScannerEnabled` workspace setting is on: a graceful,
  //     info-level skip if the binary is absent, since this is an opt-in
  //     AUTO-run path, not an explicit request.
  if (opts.engine !== undefined && opts.engine !== 'native' && opts.engine !== 'cisco') {
    log.error(`Unknown --engine value '${opts.engine}'. Expected 'native' or 'cisco'.`)
    process.exit(1)
  }
  const requestedCisco = opts.engine === 'cisco'
  let runCisco = false
  if (requestedCisco || ciscoSkillScannerEnabled) {
    const available = await ciscoScannerOnPath()
    if (available) {
      runCisco = true
    } else if (requestedCisco) {
      log.error(
        "Cisco skill-scanner engine requested (--engine cisco) but the 'skill-scanner' binary " +
          'is not on PATH. Install it with `pipx install cisco-ai-skill-scanner`.',
      )
      process.exit(1)
    } else if (!sarif) {
      log.info(
        "ciscoSkillScannerEnabled is on, but the 'skill-scanner' binary is not on PATH — " +
          'skipping the Cisco engine for this run (native scanning still ran).',
      )
    }
  }
  const ciscoRawSarifRuns: unknown[] = []

  const filesToScan = [
    '.cursorrules',
    'CLAUDE.md',
    '.windsurfrules',
    '.clauderules',
  ]

  let issues = 0
  const skillsReport: SkillReportEntry[] = []

  for (const file of filesToScan) {
    const fullPath = join(workspaceRoot, file)
    if (existsSync(fullPath)) {
      const content = await fs.readFile(fullPath, 'utf8')
      let fileIssues = 0
      const contentLines = content.split('\n')
      let fileUpdated = false

      // 1. Audit for secrets (AWS, Intutic, generic keys)
      if (content.match(/vk_[a-zA-Z0-9]{30,}/)) {
        if (!sarif) log.error(`[${file}] Hardcoded Intutic virtual key prefix detected.`)
        fileIssues++
      }
      if (content.match(/sk-live-[a-zA-Z0-9]{30,}/)) {
        if (!sarif) log.error(`[${file}] Hardcoded API secrets detected.`)
        fileIssues++
      }

      // 2. Audit for unsafe wildcard commands (e.g. rm -rf *, sh *)
      if (content.match(/rm\s+-rf\s+[*/]/)) {
        if (!sarif) log.warn(`[${file}] Unsafe recursive delete wildcard patterns (rm -rf *) found.`)
        fileIssues++
      }
      if (content.match(/curl\s+|wget\s+/)) {
        if (!sarif) log.warn(`[${file}] Network retrieval commands (curl, wget) found inside rules instructions.`)
        fileIssues++
      }

      // 3. Auto-delete/prune unsafe lines if setting is enabled
      if (fileIssues > 0 && enableLocalSkillAuditDelete) {
        const filteredLines = contentLines.filter((line) => {
          const isSecret = line.match(/vk_[a-zA-Z0-9]{30,}/) || line.match(/sk-live-[a-zA-Z0-9]{30,}/)
          const isUnsafeCmd = line.match(/rm\s+-rf\s+[*/]/) || line.match(/curl\s+|wget\s+/)
          if (isSecret || isUnsafeCmd) {
            fileUpdated = true
            return false
          }
          return true
        })

        if (fileUpdated) {
          await fs.writeFile(fullPath, filteredLines.join('\n'), 'utf8')
          if (!sarif) log.success(`[${file}] Auto-pruned unsafe lines/rules during security audit.`)
        }
      }

      issues += fileIssues
      skillsReport.push({
        filePath: file,
        linesCount: contentLines.length,
        issuesDetected: fileIssues,
      })
    }
  }

  // ── Real skill directories (`.agents/skills`, `.claude/skills`) ──────
  //
  // Content-aware scan via `scanSkillContent` (`@intutic/shared-types`),
  // report-only per that module's doc comment — a finding here is never
  // treated as ground truth, only surfaced. `enableLocalSkillAuditDelete`
  // gates pruning here exactly as it already gates the legacy rule-file
  // pruning above: the same opt-in, now covering both audit paths.
  const skillFiles = await discoverSkillFiles(workspaceRoot)
  for (const { filePath, fullPath } of skillFiles) {
    const entry = await auditSkillFile(filePath, fullPath, enableLocalSkillAuditDelete, sarif, semanticSkillAnalysisEnabled)
    issues += entry.issuesDetected
    skillsReport.push(entry)

    // ── Bundled scripts alongside this skill's SKILL.md (TD-356, Phase S2) ─
    //
    // `discoverSkillFiles` only ever found `SKILL.md`; a sibling `setup.sh`
    // or `helper.py` was invisible to every consumer before this. Enumerate
    // (bounded, symlink-skipping — see `discoverSkillBundledFiles`) and
    // audit each one the same way: always hashed, content-scanned only when
    // the language is recognized and the file is within the byte cap.
    const skillDirPath = dirname(filePath)
    const bundledFiles = await discoverSkillBundledFiles(workspaceRoot, skillDirPath)
    const bundledEntries: SkillReportEntry[] = []
    for (const script of bundledFiles) {
      const scriptEntry = await auditScriptFile(script.filePath, script.fullPath, sarif)
      issues += scriptEntry.issuesDetected
      skillsReport.push(scriptEntry)
      bundledEntries.push(scriptEntry)
    }

    // ── Cisco skill-scanner engine (Phase S3, opt-in) ───────────────────
    //
    // One invocation per skill directory — see `lib/ciscoScanner.ts`'s
    // module doc comment for why the real CLI cannot take more than one
    // `--path` per invocation. Findings merge into this skill's existing
    // entries (SKILL.md or a matching bundled-script row); the raw SARIF
    // run is kept separately for verbatim passthrough below.
    if (runCisco) {
      const [ciscoResult] = await runCiscoScan([join(workspaceRoot, skillDirPath)])
      if (ciscoResult.ok) {
        issues += mergeCiscoFindings([entry, ...bundledEntries], entry, ciscoResult, workspaceRoot)
        ciscoRawSarifRuns.push(...ciscoResult.sarifRuns)
      } else if (!sarif) {
        log.warn(`[cisco] ${skillDirPath}: ${ciscoResult.error}`)
      }
    }
  }

  if (sarif) {
    // The whole point: one JSON document, nothing else, on stdout. Cisco's
    // combined run (if the engine ran) appends as a second `runs[]` entry,
    // verbatim — see `buildSarifLog`'s doc comment.
    const combinedCiscoRun = combineCiscoSarifRuns(ciscoRawSarifRuns)
    console.log(JSON.stringify(buildSarifLog(skillsReport, combinedCiscoRun ? [combinedCiscoRun] : []), null, 2))
  } else if (issues === 0) {
    log.success('Skill security audit passed. No credentials or critical safety risks detected.')
  } else {
    log.warn(`Security audit completed with ${issues} findings. Review warnings above.`)
  }

  // Report findings to Control Plane
  if (creds && skillsReport.length > 0) {
    try {
      const client = await getClient(config?.devMode)
      await client.post(`/api/v1/workspaces/${creds.workspaceId}/skills/report`, { skills: skillsReport })
    } catch {
      // Non-blocking
    }
  }
}

/**
 * Lists staged files under the skill surface (`.agents/skills/**`,
 * `.claude/skills/**`), ADDED/COPIED/MODIFIED only — mirroring the secret
 * pre-commit scan's `git diff --cached` scope in `lib/gitHooks.ts`, so both
 * checks agree on what "staged" means. A deleted skill file has nothing to
 * scan.
 *
 * `execFileSync`, matching this package's existing git-invocation
 * convention (`config/keychain.ts`, `commands/install-daemon.ts`) rather
 * than a shelled-out string — no quoting to get wrong.
 */
function listStagedSkillSurfaceFiles(workspaceRoot: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', '.agents/skills', '.claude/skills'],
      { cwd: workspaceRoot, encoding: 'utf8' },
    )
    return out.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    // Not a git repo, no staged changes, or git not on PATH — nothing to scan.
    return []
  }
}

/**
 * Reads the STAGED content of a path via `git show :<path>` — the blob that
 * will actually be committed, not whatever is currently on disk. A file
 * edited again after `git add` would otherwise be scanned in a state that
 * does not match what `git commit` is about to record.
 */
function readStagedBlob(workspaceRoot: string, filePath: string): string | null {
  try {
    return execFileSync('git', ['show', `:${filePath}`], { cwd: workspaceRoot, encoding: 'utf8' })
  } catch {
    return null
  }
}

/**
 * Warn-only skill-content scan over staged additions in the skill surface.
 *
 * TD-358. This is the CLI entry point `lib/gitHooks.ts`'s pre-commit hook
 * shells out to (`intutic skill scan-staged`) — deliberately separate from
 * `skill audit` above, which scans the whole workspace and is too slow and
 * too broad for a commit-time check that must stay fast.
 *
 * Never refuses a commit and never throws: `scanSkillContent`'s
 * false-positive rate against real, benign skill markdown is unmeasured (see
 * `skillScan.ts`'s module doc comment), so this phase stages the signal as
 * an advisory only. Contrast `lib/gitHooks.ts`'s secret scan, which DOES
 * refuse — that check is high-precision, prefixed credential shapes with no
 * known false positives; this one is not, and must not borrow that check's
 * authority until it has earned it the same way.
 */
export async function runSkillScanStaged(): Promise<void> {
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()

  const staged = listStagedSkillSurfaceFiles(workspaceRoot)
  if (staged.length === 0) return

  let flaggedFiles = 0
  for (const filePath of staged) {
    const content = readStagedBlob(workspaceRoot, filePath)
    if (content === null) continue // vanished between diff and show — nothing to scan
    const result = scanSkillContent(content)
    if (result.clean) continue
    flaggedFiles++
    for (const finding of result.findings) {
      log.warn(
        `[${filePath}] ${finding.category} finding (${finding.patternId})` +
          `${finding.excerpt ? `: ${finding.excerpt}` : ''} — advisory only, not blocking this commit.`,
      )
    }
  }

  if (flaggedFiles > 0) {
    log.warn(
      `Skill-content scan flagged ${flaggedFiles} staged file(s) under .agents/skills or ` +
        '.claude/skills. This is advisory only (TD-358) — the commit proceeds. Run ' +
        '`intutic skill audit` for the full report.',
    )
  }
  // No exit code is ever set here — the caller (the pre-commit hook) always
  // treats this check as successful, by construction.
}

// ─── Loop Commands ───────────────────────────────────────────────────

// Exported so `commands/decision.ts` can share the exact same client
// resolution (creds, dev-mode precedence, base URL) rather than growing a
// second, easily-drifting copy of it.
export async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. This command needs an Intutic control plane, which open core does not include. To run the proxy without one: `intutic start`.')
    process.exit(1)
  }
  // `config?.devMode` is load-bearing and was missing here.
  //
  // Every other command that talks to the control plane resolves dev mode as
  // `flag || config.devMode || INTUTIC_DEV` (sops, policy, budget, connect, exec).
  // This one read only the flag and the env var, so a workspace configured with
  // `devMode: true` still had `intutic loop start` resolve to https://api.intutic.ai
  // — the loop commands, which are the governance feature, were the one family that
  // ignored the workspace's own setting and silently addressed production.
  //
  // It went unnoticed because tools/cli/dist was stale: the built CLI predated this
  // code and still read the config, so the bug only appeared once a workspace build
  // regenerated dist from source.
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  const controlPlaneUrl = resolveControlPlaneUrl(devMode)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

async function resolveLocalSops(sopsArg?: string): Promise<string[]> {
  if (!sopsArg) return []
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops')

  let dirs: string[]
  try {
    const entries = await fs.readdir(sopsDir, { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }

  const selectedSops: string[] = []
  const parts = sopsArg.split(',').map((p) => p.trim())
  for (const part of parts) {
    const optIndex = parseInt(part, 10) - 1
    if (!isNaN(optIndex) && optIndex >= 0 && optIndex < dirs.length) {
      selectedSops.push(dirs[optIndex])
    } else {
      const partLower = part.toLowerCase()
      const matched = dirs.find((d) => d.toLowerCase() === partLower) ||
                      dirs.find((d) => d.toLowerCase().includes(partLower))
      if (matched && !selectedSops.includes(matched)) {
        selectedSops.push(matched)
      }
    }
  }
  return selectedSops
}

export async function runLoopStart(opts: { 
  name: string; 
  budget?: string; 
  sops?: string; 
  autoJudge?: boolean; 
  dev?: boolean; 
}): Promise<void> {
  log.header('Intutic — Start Loop Run')
  if (!opts.name) {
    log.error('Loop run name is required (--name <name>)')
    process.exit(1)
  }

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const resolvedSops = await resolveLocalSops(opts.sops)

  if (resolvedSops.length > 0) {
    const sessionContextPath = join(workspaceRoot, '.intutic', 'session-context.json')
    await fs.mkdir(join(workspaceRoot, '.intutic'), { recursive: true }).catch(() => {})
    await fs.writeFile(
      sessionContextPath,
      JSON.stringify({ activeLocalSops: resolvedSops }, null, 2) + '\n',
      'utf-8'
    )
    log.info(`Active local SOPs configuration updated: ${resolvedSops.join(', ')}`)
  }

  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; loop: { loopRunId: string; budgetLimitUsd: string } }>(
      '/api/v1/loops/start',
      { 
        name: opts.name, 
        budgetLimitUsd: opts.budget,
        sops: resolvedSops,
        autoJudge: opts.autoJudge
      }
    )

    if (res.ok && res.loop) {
      log.success(`Loop run active: ${pc.bold(res.loop.loopRunId)}`)
      log.info(`Budget limit: $${res.loop.budgetLimitUsd} USD`)

      // Write loop env file locally
      const loopEnvPath = join(getIntuticDir(), 'env', 'loop.env')
      await fs.mkdir(dirname(loopEnvPath), { recursive: true }).catch(() => {})
      await fs.writeFile(loopEnvPath, `INTUTIC_LOOP_RUN_ID=${res.loop.loopRunId}\n`)
      log.dim(`Wrote run context to ~/.intutic/env/loop.env`)
    }
  } catch (err) {
    log.error(`Failed to register loop: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runLoopComplete(loopRunId: string, opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Complete Loop')
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean }>(`/api/v1/loops/${loopRunId}/complete`)
    if (res.ok) {
      log.success(`Loop run ${loopRunId} completed.`)
      // Clean env
      const loopEnvPath = join(getIntuticDir(), 'env', 'loop.env')
      await fs.rm(loopEnvPath, { force: true })
    }
  } catch (err) {
    log.error(`Failed to complete loop: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runLoopKill(loopRunId: string, opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Kill Loop')
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean }>(`/api/v1/loops/${loopRunId}/kill`)
    if (res.ok) {
      log.warn(`Loop run ${loopRunId} marked as KILLED.`)
      const loopEnvPath = join(getIntuticDir(), 'env', 'loop.env')
      await fs.rm(loopEnvPath, { force: true })
    }
  } catch (err) {
    log.error(`Failed to kill loop: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runLoopList(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Workspace Loop Runs')
  const client = await getClient(opts.dev)
  try {
    const res = await client.get<LoopListResponse>('/api/v1/loops')
    if (res.ok && res.loops) {
      console.log(`  ${pc.bold('Loop Run ID')}           | ${pc.bold('Name')}           | ${pc.bold('Status')}    | ${pc.bold('Token Spend')} | ${pc.bold('Budget Limit')}`)
      console.log('  ' + '-'.repeat(85))
      for (const loop of res.loops) {
        // PENDING_REVIEW is amber, not red: it needs a person, but nothing has
        // gone wrong. Falling through to the red branch made a held run look
        // killed, which is the opposite of "waiting for you".
        const statusStr =
          loop.status === 'ACTIVE'
            ? pc.green(loop.status)
            : loop.status === 'COMPLETED'
              ? pc.cyan(loop.status)
              : loop.status === 'PENDING_REVIEW'
                ? pc.yellow(loop.status)
                : pc.red(loop.status)
        console.log(`  ${loop.loopRunId.padEnd(21)} | ${loop.name.padEnd(14)} | ${statusStr.padEnd(17)} | $${parseFloat(loop.totalTokenCostUsd).toFixed(4).padEnd(10)} | $${parseFloat(loop.budgetLimitUsd).toFixed(2)}`)
      }
    }
  } catch (err) {
    log.error(`Failed to list loops: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Approve or reject a run held for human review.
 *
 * The other half of `review_before:`. Without it a hold has no resolution from
 * the terminal, and the hold is deliberately permanent — there is no reaper, so
 * an unreviewed run stays blocked until a person acts.
 */
export async function runLoopReview(
  loopRunId: string,
  opts: { approve?: boolean; reject?: boolean; note?: string; dev?: boolean },
): Promise<void> {
  if (opts.approve === opts.reject) {
    log.error('Specify exactly one of --approve or --reject.')
    process.exit(1)
  }
  const action = opts.approve ? 'approve' : 'reject'
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; status: string }>(
      `/api/v1/loops/${loopRunId}/review`,
      { action, note: opts.note },
    )
    if (res.ok) {
      log.success(
        action === 'approve'
          ? `Loop run ${loopRunId} approved — it is ACTIVE again.`
          : `Loop run ${loopRunId} rejected — it is KILLED.`,
      )
    }
  } catch (err) {
    log.error(`Failed to resolve review: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

export async function runLoopExec(
  commandAndArgs: string[], 
  opts: { 
    name?: string; 
    budget?: string; 
    sops?: string; 
    autoJudge?: boolean; 
    dev?: boolean; 
  }
): Promise<void> {
  if (commandAndArgs.length === 0) {
    log.error('No command provided. Use: intutic loop exec -- <command> [args...]')
    process.exit(1)
  }

  const loopName = opts.name || `exec-${commandAndArgs[0]}`
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const resolvedSops = await resolveLocalSops(opts.sops)

  if (resolvedSops.length > 0) {
    const sessionContextPath = join(workspaceRoot, '.intutic', 'session-context.json')
    await fs.mkdir(join(workspaceRoot, '.intutic'), { recursive: true }).catch(() => {})
    await fs.writeFile(
      sessionContextPath,
      JSON.stringify({ activeLocalSops: resolvedSops }, null, 2) + '\n',
      'utf-8'
    )
    log.info(`Active local SOPs configuration updated: ${resolvedSops.join(', ')}`)
  }

  const client = await getClient(opts.dev)

  log.header(`Intutic — Execute Loop Wrapper: ${loopName}`)
  try {
    const res = await client.post<{ ok: boolean; loop: { loopRunId: string } }>(
      '/api/v1/loops/start',
      { 
        name: loopName, 
        budgetLimitUsd: opts.budget,
        sops: resolvedSops,
        autoJudge: opts.autoJudge
      }
    )

    if (!res.ok || !res.loop) {
      log.error('Failed to start loop wrapper')
      process.exit(1)
    }

    const loopRunId = res.loop.loopRunId
    log.success(`Loop run registered: ${loopRunId}`)

    // Execute process with INTUTIC_LOOP_RUN_ID in environment
    const childEnv = {
      ...process.env,
      INTUTIC_LOOP_RUN_ID: loopRunId,
      // For dynamic header routing
      HTTP_X_LOOP_RUN_ID: loopRunId,
    }

    const command = commandAndArgs[0]
    const args = commandAndArgs.slice(1)

    log.info(`Executing wrapper command: ${command} ${args.join(' ')}`)

    const child = spawn(command, args, {
      env: childEnv,
      stdio: 'inherit',
      shell: true,
    })

    child.on('close', async (code) => {
      // A non-zero exit is the agent failing, not governance stopping it. This used
      // to POST /kill for that case, which conflated the two: KILLED means the
      // circuit breaker or an operator intervened, and a run marked KILLED because
      // the wrapped process returned 1 makes budget-breach data unreadable. It also
      // meant the outcome was never recorded anywhere — the exit code was known
      // right here and thrown away, leaving no way to tell a successful trajectory
      // from a failed one afterwards.
      // A held run is not finished, it is waiting. Completing it would close the
      // review by side effect, with nothing recorded about who decided what — and
      // the route refuses it anyway (400). The agent exits non-zero when the proxy
      // returns 403, so without this check every hold ends in a confusing error.
      try {
        const current = await client.get<{ ok: boolean; loop?: { status?: string } }>(
          `/api/v1/loops/${loopRunId}`,
        )
        if (current?.loop?.status === 'PENDING_REVIEW') {
          log.warn('This loop run is held for human review — it has not finished.')
          log.info(`Approve or reject it:  intutic loop review ${loopRunId} --approve`)
          // loop.env is deliberately left in place: the resumed agent needs the
          // run id, and removing it here would orphan the run.
          process.exit(code || 0)
          return
        }
      } catch {
        // Status unknown — fall through and record the outcome as usual rather
        // than leaving the run open on a transient error.
      }

      if (code === 0) {
        await client
          .post(`/api/v1/loops/${loopRunId}/complete`, { outcome: 'SUCCEEDED' })
          .catch(() => {})
        log.success('Loop command execution succeeded. Wrapper loop marked COMPLETED.')
      } else {
        await client
          .post(`/api/v1/loops/${loopRunId}/complete`, { outcome: 'FAILED' })
          .catch(() => {})
        log.warn(`Loop command execution exited with code ${code}. Wrapper loop marked FAILED.`)
      }
      process.exit(code || 0)
    })
  } catch (err) {
    log.error(`Loop execution wrapper failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
