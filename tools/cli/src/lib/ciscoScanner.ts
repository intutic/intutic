/**
 * Cisco `skill-scanner` integration — OPTIONAL, opt-in shell-out to
 * `cisco-ai-defense/skill-scanner`, a Cisco AI Defense open-source CLI that
 * does static YARA/pattern detection, Python bytecode integrity checks,
 * command-pipeline taint analysis, and (with `--use-behavioral`) full
 * AST/dataflow analysis of skill content — genuinely deeper than this
 * codebase's own regex-genre scanning (`packages/shared-types/src/scriptScan.ts`,
 * Phase S2). TD-356 (`docs/TECH_DEBT.md`) named this integration as the
 * follow-up to that phase's deliberately-scoped pattern matching.
 *
 * # Why a shell-out, not a dependency
 *
 * `apps/docs/guide/skill-scanning.md` previously declined adopting a Python
 * runtime dependency for this codebase — that decision stands. This module
 * does not embed, vendor, or depend on `skill-scanner`; it shells out to it
 * via `execFile` when the operator has separately installed it (`pipx
 * install cisco-ai-skill-scanner`), and degrades gracefully — never throws,
 * never silently passes — when it is absent. OUR runtime stays Python-free;
 * the binary is entirely the operator's own installation.
 *
 * # CLI invocation shape — VERIFIED against the real published tool
 *
 * This integration was written against the actual Cisco tool: PyPI package
 * `cisco-ai-skill-scanner` (installs a binary named `skill-scanner` on
 * PATH — same binary name as a DIFFERENT, unrelated PyPI package also
 * called `skill-scanner`; see the correction note below), installed via
 * `pipx install cisco-ai-skill-scanner` and inspected with `--help` and by
 * reading its installed source, not guessed from a "typical SARIF scanner"
 * shape:
 *
 *   skill-scanner scan <dir> --use-behavioral --format sarif --output-sarif <file>
 *
 * Load-bearing details confirmed from the installed 2.0.13 source
 * (`skill_scanner/core/models.py`, `skill_scanner/cli/cli.py`) and by
 * actually running the binary against test fixtures:
 * - `skill_directory` is a POSITIONAL argument, not a `--path` flag, and
 *   takes exactly one directory — {@link runCiscoScan} therefore invokes
 *   the binary ONCE PER skill directory, exactly the shape this phase's
 *   caller (`commands/skill.ts`) already iterates in.
 * - `static_analyzer`, `bytecode_analyzer`, and `pipeline_analyzer` run BY
 *   DEFAULT, no flag or API key required. `--use-behavioral` additionally
 *   enables `behavioral_analyzer` (AST + taint tracking) — still fully
 *   offline, no key — which is the analyzer this integration wants for the
 *   "genuinely deeper than regex" claim, so it is always passed.
 *   `--use-llm`, `--use-virustotal`, and `--use-aidefense` each require a
 *   separately-configured API key and are NEVER passed by this module —
 *   this integration only exercises skill-scanner's offline analyzers.
 * - Each SARIF `result` carries `properties.category` (one of an 18-value
 *   enum — `prompt_injection`, `command_injection`, `data_exfiltration`,
 *   `unauthorized_tool_use`, `obfuscation`, `hardcoded_secrets`,
 *   `social_engineering`, `resource_abuse`, `policy_violation`, `malware`,
 *   `harmful_content`, `skill_discovery_abuse`, `transitive_trust_abuse`,
 *   `autonomy_abuse`, `tool_chaining_abuse`, `unicode_steganography`,
 *   `supply_chain_attack` — `skill_scanner/core/models.py`'s
 *   `ThreatCategory` enum) and `properties.severity` DIRECTLY, not encoded
 *   into `ruleId` — `ruleId` is a plain identifier like
 *   `PIPELINE_TAINT_FLOW`, not `skill-scanner/<category>`. `mapCiscoCategory`
 *   in `commands/skill.ts` maps from this real taxonomy, not a guess.
 * - `artifactLocation.uri` is RELATIVE to the scanned directory (e.g.
 *   `"SKILL.md"`, with `uriBaseId: "%SRCROOT%"` signalling exactly that) —
 *   NOT absolute, confirmed by actually running the binary. {@link
 *   scanOneDir} joins it against `dir` before returning it, honoring this
 *   module's own `CiscoScanFinding.filePath` contract ("ABSOLUTE").
 * - A `--fail-on-severity`/`--fail-on-findings` threshold crossing still
 *   exits non-zero WHILE writing a valid SARIF file — confirmed
 *   empirically — so {@link scanOneDir} always attempts to read the output
 *   file first and only reports `ok: false` when that file is absent or
 *   unparseable.
 *
 * # Correction: an earlier version of this integration shelled out to the
 * # WRONG package
 *
 * `skill-scanner` is claimed on PyPI's generic namespace by an unrelated,
 * unaffiliated project (`thedevappsecguy/skill-scanner`, MIT-licensed, no
 * Cisco affiliation) that requires an LLM or VirusTotal API key to do
 * anything at all — it has no offline analysis path. `pipx install
 * skill-scanner` installs THAT package, not Cisco's. The real Cisco tool
 * publishes under `cisco-ai-skill-scanner` on PyPI
 * (github.com/cisco-ai-defense/skill-scanner, Apache 2.0, Cisco Systems
 * Inc.) — install it with `pipx install cisco-ai-skill-scanner`. Once
 * installed, its binary is ALSO named `skill-scanner` on PATH, so no other
 * part of this integration (binary-name detection, doctor check) needed to
 * change — only the install instructions and this module's invocation
 * shape/category taxonomy, which were verified against the wrong package.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { binaryOnPath } from './binaryOnPath.js'

const execFileAsync = promisify(execFile)

/** The binary name this integration shells out to. Matches the doctor-check
 *  remediation (`pipx install cisco-ai-skill-scanner`) — the PyPI package
 *  name differs from the binary name it installs; see this module's doc
 *  comment. */
export const CISCO_SCANNER_BINARY = 'skill-scanner'

/**
 * Bounded timeout per scanned directory. Generous relative to every other
 * shell-out in this codebase (`elevation.ts`'s `net session` probe: 3s;
 * `process.ts`'s `ps`/`tasklist`: 5s) because `--use-behavioral` runs a
 * full AST/dataflow pass, not a fast pattern match — 60s is a floor meant
 * to catch a genuinely hung process, not a tight budget for a fast local
 * check.
 */
export const CISCO_SCAN_TIMEOUT_MS = 60_000

/** Resolves `true` iff the `skill-scanner` binary is present on PATH. */
export function ciscoScannerOnPath(): Promise<boolean> {
  return binaryOnPath(CISCO_SCANNER_BINARY)
}

/**
 * `skill-scanner --version`'s stdout, trimmed, or `null` if the binary is
 * absent or the invocation itself fails. Used only by the doctor check —
 * never assumed non-null by any caller that gates on {@link ciscoScannerOnPath}.
 */
export async function ciscoScannerVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(CISCO_SCANNER_BINARY, ['--version'], { timeout: 5_000 })
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** One parsed SARIF result from a `skill-scanner` run, flattened out of
 *  `runs[].results` for the internal finding-merge path. Bounded fields
 *  only — never the tool's full result object — matching this codebase's
 *  own findings' "never carry more than a caller needs" discipline. */
export interface CiscoScanFinding {
  /** The tool's own `ruleId`, e.g. `PIPELINE_TAINT_FLOW`. Not itself a
   *  category — see {@link category}. */
  ruleId: string
  level: string
  message: string
  /** The tool's own `properties.category` on this result, e.g.
   *  `command_injection` — one of the `ThreatCategory` enum values
   *  documented in this module's doc comment. Absent only for a
   *  malformed/unexpected result shape. */
  category?: string
  /** SARIF `artifactLocation.uri` — the tool's own path, ABSOLUTE (whatever
   *  form `runCiscoScan`'s caller passed as the scanned directory), not yet
   *  relativized to a workspace root. */
  filePath?: string
  line?: number
}

/** Result of scanning ONE directory with `skill-scanner`. */
export interface CiscoDirScanResult {
  /** The directory that was scanned — echoes the caller's input. */
  dir: string
  /** `false` means this directory produced no usable result — binary
   *  absent, timed out, or exited without a parseable SARIF file. Refusal-
   *  not-pass: never treat `!ok` as "clean". */
  ok: boolean
  /** Populated only when `!ok`. Human-readable — safe to log or surface to
   *  the user directly. */
  error?: string
  /** The RAW SARIF `runs[]` entries this invocation produced, exactly as
   *  the tool emitted them — for verbatim passthrough into `--sarif` output.
   *  Usually zero or one entry per directory; never edited or re-shaped. */
  sarifRuns: unknown[]
  /** Findings flattened out of `sarifRuns[].results`, for the internal
   *  `SkillScanFinding` merge path (`commands/skill.ts`). */
  findings: CiscoScanFinding[]
}

function friendlyMissingBinaryError(): string {
  return (
    `'${CISCO_SCANNER_BINARY}' not found on PATH. Install it with ` +
    '`pipx install cisco-ai-skill-scanner`, or drop `--engine cisco` / ' +
    "disable the 'ciscoSkillScannerEnabled' workspace setting to use native " +
    'scanning only.'
  )
}

/** Narrow shape of the error `execFile`/its promisified form reject with —
 *  only the fields this module actually reads. */
interface ExecFileError extends Error {
  code?: string | number
  killed?: boolean
  signal?: string | null
  stderr?: string
}

/**
 * Scan ONE directory with `skill-scanner`, writing SARIF to a scratch file
 * (`--output-sarif`) rather than parsing stdout — stdout carries a
 * human-readable summary this integration never needs to parse, and the
 * SARIF exporter writes plain JSON to the file regardless of `--format`
 * also being requested for stdout.
 *
 * A non-zero exit is NOT immediately treated as failure: `--fail-on-*`
 * deliberately exits non-zero when a finding crosses a severity threshold
 * while still writing a valid SARIF file (verified empirically), so this
 * function always attempts to read the output file first and only reports
 * `ok: false` when that file is absent or unparseable.
 */
async function scanOneDir(dir: string): Promise<CiscoDirScanResult> {
  const outFile = join(tmpdir(), `intutic-cisco-scan-${randomBytes(8).toString('hex')}.sarif.json`)
  let execError: ExecFileError | undefined

  try {
    await execFileAsync(
      CISCO_SCANNER_BINARY,
      ['scan', dir, '--use-behavioral', '--format', 'sarif', '--output-sarif', outFile],
      { timeout: CISCO_SCAN_TIMEOUT_MS },
    )
  } catch (err) {
    const nodeErr = err as ExecFileError
    if (nodeErr.code === 'ENOENT') {
      return { dir, ok: false, sarifRuns: [], findings: [], error: friendlyMissingBinaryError() }
    }
    if (nodeErr.killed || nodeErr.signal) {
      return {
        dir,
        ok: false,
        sarifRuns: [],
        findings: [],
        error: `cisco skill-scanner timed out after ${CISCO_SCAN_TIMEOUT_MS}ms scanning ${dir}`,
      }
    }
    // Any other non-zero exit — fall through and try the output file before
    // giving up (see doc comment: --fail-on-* exits non-zero on real findings).
    execError = nodeErr
  }

  let raw: string
  try {
    raw = await fs.readFile(outFile, 'utf8')
  } catch {
    const stderrHint = execError?.stderr?.trim()
    return {
      dir,
      ok: false,
      sarifRuns: [],
      findings: [],
      error:
        `cisco skill-scanner produced no output scanning ${dir}` +
        (stderrHint ? `: ${stderrHint}` : ' — the scan did not complete.'),
    }
  } finally {
    await fs.rm(outFile, { force: true })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      dir,
      ok: false,
      sarifRuns: [],
      findings: [],
      error: `cisco skill-scanner output for ${dir} was not valid JSON`,
    }
  }

  const runs = Array.isArray((parsed as { runs?: unknown }).runs) ? (parsed as { runs: unknown[] }).runs : []
  const findings: CiscoScanFinding[] = []
  for (const run of runs) {
    const results = (run as { results?: unknown[] })?.results
    if (!Array.isArray(results)) continue
    for (const result of results) {
      const r = result as {
        ruleId?: unknown
        level?: unknown
        message?: { text?: unknown }
        properties?: { category?: unknown }
        locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } }>
      }
      const location = r.locations?.[0]?.physicalLocation
      const uri = typeof location?.artifactLocation?.uri === 'string' ? location.artifactLocation.uri : undefined
      // The tool's own URIs are RELATIVE to the scanned directory (verified
      // empirically: `artifactLocation.uri` is `"SKILL.md"`, not an
      // absolute path, with `uriBaseId: "%SRCROOT%"` signalling exactly
      // that) — join against `dir` so this module's own contract
      // ("filePath is ABSOLUTE") holds regardless of what the tool emits.
      // Already-absolute URIs (a future tool version, or a result with no
      // location at all) pass through unchanged.
      const filePath = uri === undefined ? undefined : isAbsolute(uri) ? uri : join(dir, uri)
      findings.push({
        ruleId: typeof r.ruleId === 'string' ? r.ruleId : 'unknown',
        level: typeof r.level === 'string' ? r.level : 'warning',
        message: typeof r.message?.text === 'string' ? r.message.text : '',
        category: typeof r.properties?.category === 'string' ? r.properties.category : undefined,
        filePath,
        line: typeof location?.region?.startLine === 'number' ? location.region.startLine : undefined,
      })
    }
  }

  return { dir, ok: true, sarifRuns: runs, findings }
}

/**
 * Scan each of `skillDirs` with `skill-scanner`, one invocation per
 * directory (see this module's doc comment for why the tool takes exactly
 * one directory per invocation). Directories are ABSOLUTE paths — callers
 * resolve against the workspace root before calling, the same convention
 * `oci.ts`/`firecracker.ts` use for the paths they hand external tools.
 *
 * Never throws: every failure mode (binary absent, timeout, unparseable
 * output) is reported per-directory via `CiscoDirScanResult.ok`/`.error`,
 * so one skill's scan failing does not abort the rest.
 */
export async function runCiscoScan(skillDirs: readonly string[]): Promise<CiscoDirScanResult[]> {
  const results: CiscoDirScanResult[] = []
  for (const dir of skillDirs) {
    results.push(await scanOneDir(dir))
  }
  return results
}

/**
 * Combine the raw SARIF `runs[0]`-shaped objects from multiple
 * `skill-scanner` invocations (one per scanned skill directory) into a
 * SINGLE run, so `skill audit --sarif` appends Cisco's output as one
 * additional entry in `runs[]`, not one per skill scanned — the multiple
 * invocations are an artifact of this integration's own per-directory
 * invocation strategy, not something the SARIF consumer should see.
 *
 * Only the CONTAINER is merged: rule catalogs are de-duplicated by `id`,
 * results are concatenated. Every individual rule/result object is passed
 * through unmodified — never rewritten — preserving the "append verbatim"
 * contract this integration promises for `--sarif` output.
 *
 * Returns `null` when given no runs (nothing to append).
 */
export function combineCiscoSarifRuns(runs: readonly unknown[]): unknown | null {
  if (runs.length === 0) return null

  const base = runs[0] as { tool?: { driver?: { name?: unknown; informationUri?: unknown } } }
  const rulesById = new Map<string, unknown>()
  const results: unknown[] = []

  for (const run of runs) {
    const r = run as { tool?: { driver?: { rules?: unknown[] } }; results?: unknown[] }
    for (const rule of r.tool?.driver?.rules ?? []) {
      const id = (rule as { id?: unknown })?.id
      if (typeof id === 'string') rulesById.set(id, rule)
    }
    if (Array.isArray(r.results)) results.push(...r.results)
  }

  return {
    tool: {
      driver: {
        name: typeof base.tool?.driver?.name === 'string' ? base.tool.driver.name : CISCO_SCANNER_BINARY,
        rules: [...rulesById.values()],
      },
    },
    results,
  }
}
