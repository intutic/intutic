/**
 * `intutic rules build|test` — Rego policies as Intutic rules.
 *
 * `build` compiles Rego with OPA (`opa build -t wasm`) and packages the module
 * with the metadata the hosts read: the entrypoint to evaluate, the ABI
 * (`opa`) and a default risk tier, in an `intutic.rule` custom section, so
 * the result is still one `.wasm` file that installs and uploads like any
 * rule. `test` runs a rule against sample inputs through the same Rego host
 * the MCP proxy uses (`@intutic/shared-types`), which decides as the Rust
 * proxy does: both are checked against `opa eval` on the same cases.
 *
 * Installing is `intutic policy install --wasm <file>`, the same command as
 * for any rule; uploading is the dashboard or `POST /api/v1/wasm-rules`.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import {
  boundedRegoInput,
  evaluateRegoRule,
  loadRegoRule,
  regoDecision,
  withRegoMetadata,
  type RegoDecision,
  type RegoHostOptions,
  type RegoRule,
} from '@intutic/shared-types'
import { log } from '../lib/logger.js'

/** The OPA binary: `INTUTIC_OPA_BIN`, else `opa` on the PATH. */
export function opaBinary(): string {
  return process.env['INTUTIC_OPA_BIN'] || 'opa'
}

export const REGO_HOST: RegoHostOptions = {
  digest: (algorithm, data) => createHash(algorithm).update(data).digest('hex'),
}

const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

/**
 * `/policy.wasm` out of the gzipped tar `opa build` writes. Read here rather
 * than by a `tar` binary, which a Windows machine may not have.
 */
export function extractPolicyWasm(bundle: Buffer): Buffer {
  const tar = gunzipSync(bundle)
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start: number, len: number): string =>
      header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '')
    const name = `${field(345, 155)}${field(0, 100)}`
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const body = offset + 512
    if (name.replace(/^\/+/, '') === 'policy.wasm') return Buffer.from(tar.subarray(body, body + size))
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error('the OPA bundle has no policy.wasm')
}

/** Default output: `build/<entrypoint with / as _>.wasm`. */
export function defaultOutPath(entrypoint: string): string {
  return path.join('build', `${entrypoint.replace(/[^A-Za-z0-9_-]+/g, '_')}.wasm`)
}

export async function runRulesBuild(opts: {
  rego: string
  entrypoint: string
  out?: string
  riskTier?: string
}): Promise<void> {
  log.header('Intutic — Build Rego Rule')

  const riskTier = opts.riskTier?.toLowerCase()
  if (riskTier !== undefined && !(RISK_TIERS as readonly string[]).includes(riskTier)) {
    log.error(`Invalid risk tier "${opts.riskTier}". Use one of: ${RISK_TIERS.join(', ')}.`)
    process.exit(1)
  }
  if (!/^[A-Za-z_][\w.]*(\/[A-Za-z_][\w]*)+$/.test(opts.entrypoint)) {
    log.error(`Invalid entrypoint "${opts.entrypoint}". Use package/rule, e.g. intutic/shell/deny.`)
    process.exit(1)
  }

  const opa = opaBinary()
  try {
    await run(opa, ['version'])
  } catch {
    log.error(
      `OPA is required to compile Rego and "${opa}" was not found. Install it ` +
        '(https://www.openpolicyagent.org/docs/latest/#1-download-opa) or set INTUTIC_OPA_BIN to its path.',
    )
    process.exit(1)
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rego-'))
  let module: Uint8Array
  try {
    const bundle = path.join(work, 'bundle.tar.gz')
    const built = await run(opa, ['build', '-t', 'wasm', '-e', opts.entrypoint, opts.rego, '-o', bundle])
    if (built.code !== 0) {
      log.error(`opa build failed:\n${built.stderr || built.stdout}`)
      process.exit(1)
    }
    module = withRegoMetadata(extractPolicyWasm(await fs.readFile(bundle)), {
      v: 1,
      abi: 'opa',
      entrypoint: opts.entrypoint,
      ...(riskTier ? { risk_tier: riskTier } : {}),
    })
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }

  // Refuse here what a host would refuse at load: a builtin it lacks, an old
  // ABI. Building a rule that every proxy then skips helps nobody.
  try {
    loadRegoRule(module, undefined, REGO_HOST)
  } catch (err) {
    log.error(`The policy compiled, but Intutic cannot run it: ${(err as Error).message}`)
    process.exit(1)
  }

  const out = opts.out ?? defaultOutPath(opts.entrypoint)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, module)
  log.success(`Built ${out}`)
  log.field('Entrypoint', opts.entrypoint)
  log.field('Risk tier', riskTier ?? '(none)')
  log.field('Size', `${(module.length / 1024).toFixed(0)} KB`)
  log.field('SHA-256', createHash('sha256').update(module).digest('hex'))
  log.info(`Test it: intutic rules test ${out} --input <cases.json>`)
  log.info(`Install it: intutic policy install --wasm ${out}`)
}

/** One sample: an input document, and optionally the decision it should get. */
export interface RegoCase {
  name?: string
  input: Record<string, unknown>
  expect?: RegoDecision['decision']
}

/** A file of cases `[{name?, input, expect?}]`, or one bare input document. */
export function parseCases(text: string): RegoCase[] {
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) {
    return parsed.map((c, i) => {
      if (c === null || typeof c !== 'object' || typeof (c as RegoCase).input !== 'object') {
        throw new Error(`case ${i + 1} has no "input" object`)
      }
      return c as RegoCase
    })
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('expected an input object or an array of cases')
  return [{ input: parsed as Record<string, unknown> }]
}

/** The decision `rule` reaches on one input, as a proxy would reach it. */
export function decideCase(rule: RegoRule, input: Record<string, unknown>): RegoDecision {
  const decision = regoDecision(
    evaluateRegoRule(rule, boundedRegoInput({ v: 1, ...input }), REGO_HOST),
    rule.entrypoint,
  )
  return decision.riskTier || !rule.riskTier ? decision : { ...decision, riskTier: rule.riskTier }
}

export async function runRulesTest(modulePath: string, opts: { input: string[] }): Promise<void> {
  log.header('Intutic — Test Rego Rule')

  let rule: RegoRule | null
  try {
    rule = loadRegoRule(await fs.readFile(modulePath), undefined, REGO_HOST)
  } catch (err) {
    log.error(`Cannot load "${modulePath}": ${(err as Error).message}`)
    process.exit(1)
  }
  if (!rule) {
    log.error(`"${modulePath}" is a native rule, not a Rego one. Test it with: intutic policy test --wasm ${modulePath} --mock <context.json>`)
    process.exit(1)
  }
  log.field('Entrypoint', rule.entrypoint)

  let failed = 0
  let total = 0
  for (const file of opts.input) {
    let cases: RegoCase[]
    try {
      cases = parseCases(await fs.readFile(file, 'utf-8'))
    } catch (err) {
      log.error(`Cannot read cases from "${file}": ${(err as Error).message}`)
      process.exit(1)
    }
    for (const [i, c] of cases.entries()) {
      total += 1
      const label = c.name ?? `${path.basename(file)} #${i + 1}`
      let decision: RegoDecision
      try {
        decision = decideCase(rule, c.input)
      } catch (err) {
        failed += 1
        log.error(`${label}: evaluation failed (a proxy allows the call): ${(err as Error).message}`)
        continue
      }
      const detail = [
        decision.decision.toUpperCase(),
        'reason' in decision ? `— ${decision.reason}` : '',
        decision.riskTier ? `[${decision.riskTier}]` : '',
      ]
        .filter(Boolean)
        .join(' ')
      if (c.expect && c.expect !== decision.decision) {
        failed += 1
        log.error(`${label}: expected ${c.expect.toUpperCase()}, got ${detail}`)
      } else if (c.expect) {
        log.success(`${label}: ${detail}`)
      } else {
        log.info(`${label}: ${detail}`)
      }
    }
  }
  if (failed > 0) {
    log.error(`${failed} of ${total} case${total === 1 ? '' : 's'} failed`)
    process.exit(1)
  }
  log.success(`${total} case${total === 1 ? '' : 's'} evaluated`)
}
