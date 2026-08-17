/**
 * Cisco `skill-scanner` integration — OPTIONAL, opt-in shell-out to an
 * external Python-packaged CLI that does full AST/dataflow analysis of
 * skill-bundled scripts, genuinely deeper than this codebase's own
 * regex-genre scanning (`packages/shared-types/src/scriptScan.ts`, Phase
 * S2). TD-356 (`docs/TECH_DEBT.md`) named this integration as the follow-up
 * to that phase's deliberately-scoped pattern matching.
 *
 * # Why a shell-out, not a dependency
 *
 * `apps/docs/guide/skill-scanning.md` previously declined adopting a Python
 * runtime dependency for this codebase — that decision stands. This module
 * does not embed, vendor, or depend on `skill-scanner`; it shells out to it
 * via `execFile` when the operator has separately installed it (`pipx
 * install skill-scanner`), and degrades gracefully — never throws, never
 * silently passes — when it is absent. OUR runtime stays Python-free; the
 * binary is entirely the operator's own installation.
 *
 * # CLI invocation shape — VERIFIED against the real published tool
 *
 * Unlike most shell-outs in this codebase, this integration was written
 * against the actual `skill-scanner` CLI (PyPI package `skill-scanner`,
 * installed via `pipx install skill-scanner` and inspected with `--help` and
 * by reading its installed source, not guessed from a "typical SARIF
 * scanner" shape):
 *
 *   skill-scanner scan --path <dir> --format sarif --output <file>
 *
 * Load-bearing details confirmed from the installed 0.3.3 source
 * (`skill_scanner/output/sarif_export.py`, `skill_scanner/models/findings.py`):
 * - `--path` is SINGLE-VALUED (not `--target`, which the tool's own `--help`
 *   marks "repeat for multiple" — `--path` carries no such note, and passing
 *   it twice silently keeps only the last value, confirmed empirically).
 *   {@link runCiscoScan} therefore invokes the binary ONCE PER skill
 *   directory, exactly the shape this phase's caller (`commands/skill.ts`)
 *   already iterates in.
 * - `ruleId` in the tool's own SARIF output is `skill-scanner/<category>`
 *   (e.g. `skill-scanner/exfiltration`), and `category` is one of:
 *   `external_download | prompt_injection | ssrf_cloud | command_execution |
 *   supply_chain | exfiltration | credential_leak | indirect_injection |
 *   toxic_flow | third_party_content | configuration_risk` (plus compat
 *   aliases the tool itself resolves before emitting SARIF) — this is the
 *   real taxonomy {@link mapCiscoCategory} in `commands/skill.ts` maps
 *   from, not a guess.
 *
 * # What was NOT possible to verify, and matters for how this ships
 *
 * The installed tool's actual analysis mechanism is **LLM analysis +
 * VirusTotal**, gated on `SKILLSCAN_API_KEY`/`SKILLSCAN_BASE_URL` (LLM) or
 * `VT_API_KEY` (VirusTotal) being configured in the operator's environment —
 * NOT static AST/dataflow analysis that runs standalone offline the way this
 * module's doc comment (and `docs/TECH_DEBT.md`'s TD-356/`scriptScan.ts`)
 * describe "Cisco's skill-scanner" as doing. With neither configured, the
 * installed binary exits non-zero with "No analyzers enabled for scan" and
 * writes NO output file at all — confirmed by actually invoking it in this
 * sandbox. {@link runCiscoScan} treats that as a scan failure (surfaced via
 * `error`, never silently "clean"), not a hard binary-absent error, since
 * the binary genuinely is present and ran.
 *
 * Separately, nothing in the installed package's PyPI metadata (author,
 * project URLs, license) names Cisco as the publisher — it ships from
 * `thedevappsecguy/skill-scanner` on GitHub. This module integrates with
 * whatever binary is literally named `skill-scanner` on PATH, per the
 * existing doctor-check remediation text (`pipx install skill-scanner`)
 * this phase's brief specified; it does not itself assert Cisco authorship.
 * See the final report for this phase for why this is flagged rather than
 * silently resolved either way.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { binaryOnPath } from './binaryOnPath.js'

const execFileAsync = promisify(execFile)

/** The binary name this integration shells out to. Matches the doctor-check
 *  remediation (`pipx install skill-scanner`) and the PyPI package name. */
export const CISCO_SCANNER_BINARY = 'skill-scanner'

/**
 * Bounded timeout per scanned directory. Generous relative to every other
 * shell-out in this codebase (`elevation.ts`'s `net session` probe: 3s;
 * `process.ts`'s `ps`/`tasklist`: 5s) because this invocation can involve a
 * live LLM call and/or a polled VirusTotal analysis (the installed tool's
 * own `--vt-timeout` defaults to 300s for VT alone) — 60s is a floor meant
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
  /** The tool's own `ruleId`, e.g. `skill-scanner/exfiltration`. */
  ruleId: string
  level: string
  message: string
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
   *  absent, timed out, or exited without a parseable SARIF file (which,
   *  per this module's doc comment, includes the tool's own "no analyzer
   *  configured" failure mode). Refusal-not-pass: never treat `!ok` as
   *  "clean". */
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
    '`pipx install skill-scanner`, or drop `--engine cisco` / disable the ' +
    "'ciscoSkillScannerEnabled' workspace setting to use native scanning only."
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
 * (`--output`) rather than parsing stdout — stdout can carry progress/log
 * text the tool itself does not suppress, and the SARIF exporter writes
 * plain JSON to the file regardless (verified from source; `--no-color` is
 * still passed for defense in depth).
 *
 * A non-zero exit is NOT immediately treated as failure: the tool's
 * `--fail-on` flag deliberately exits non-zero when a finding crosses a
 * severity threshold while still writing a valid SARIF file, so this
 * function always attempts to read the output file first and only reports
 * `ok: false` when that file is absent or unparseable.
 */
async function scanOneDir(dir: string): Promise<CiscoDirScanResult> {
  const outFile = join(tmpdir(), `intutic-cisco-scan-${randomBytes(8).toString('hex')}.sarif.json`)
  let execError: ExecFileError | undefined

  try {
    await execFileAsync(
      CISCO_SCANNER_BINARY,
      ['scan', '--path', dir, '--format', 'sarif', '--output', outFile, '--no-color'],
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
    // giving up (see doc comment: --fail-on exits non-zero on real findings).
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
        (stderrHint
          ? `: ${stderrHint}`
          : ' — it requires SKILLSCAN_API_KEY/SKILLSCAN_BASE_URL or VT_API_KEY to be ' +
            "configured (run `skill-scanner doctor` to check)."),
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
        locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } }>
      }
      const location = r.locations?.[0]?.physicalLocation
      findings.push({
        ruleId: typeof r.ruleId === 'string' ? r.ruleId : 'unknown',
        level: typeof r.level === 'string' ? r.level : 'warning',
        message: typeof r.message?.text === 'string' ? r.message.text : '',
        filePath: typeof location?.artifactLocation?.uri === 'string' ? location.artifactLocation.uri : undefined,
        line: typeof location?.region?.startLine === 'number' ? location.region.startLine : undefined,
      })
    }
  }

  return { dir, ok: true, sarifRuns: runs, findings }
}

/**
 * Scan each of `skillDirs` with `skill-scanner`, one invocation per
 * directory (see this module's doc comment for why `--path` cannot take
 * more than one directory per invocation). Directories are ABSOLUTE paths —
 * callers resolve against the workspace root before calling, the same
 * convention `oci.ts`/`firecracker.ts` use for the paths they hand external
 * tools.
 *
 * Never throws: every failure mode (binary absent, timeout, no analyzer
 * configured, unparseable output) is reported per-directory via
 * `CiscoDirScanResult.ok`/`.error`, so one skill's scan failing does not
 * abort the rest.
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
