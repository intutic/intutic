/**
 * The chaos run: baseline repetitions, then faulted ones, each in its own git
 * worktree, behind its own proxy, inside the sandbox.
 *
 * Per repetition the runner
 *   1. adds a detached worktree of HEAD (so every repetition starts from the
 *      same commit) and carries the project's generated gates, hook settings
 *      and policy snapshot into it, host paths rewritten to `/work`
 *      ({@link prepareWorkspace}),
 *   2. starts a dedicated proxy on a free port with the plan and the host path
 *      of the events file, and waits for its health endpoint,
 *   3. runs the agent in the sandbox with the plan, the in-sandbox events
 *      path and the proxy URL passed by name, tailing the events file every
 *      second for an abort condition,
 *   4. runs `verify` the same way (its exit code is task success),
 *   5. stops the proxy, copies `.intutic-chaos/` next to the report and
 *      removes the worktree (unless kept).
 *
 * Everything with a side effect comes in through {@link ChaosDeps}, so the
 * orchestration is tested without Docker, a proxy binary or git.
 *
 * @module
 */

import { createWriteStream, type WriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  CHAOS_EVENTS_ENV,
  CHAOS_PLAN_ENV,
  CHAOS_PLAN_VERSION,
  encodeChaosPlan,
  parseChaosEvents,
  type ChaosEvent,
  type Experiment,
  type ProbeId,
  type RunVerdict,
} from '@intutic/shared-types'
import {
  abortReason,
  aggregateProbes,
  decideVerdict,
  evaluateRepetition,
  repetitionCost,
  silenceWarnings,
  type ProbeReport,
  type ProbeResult,
} from './probes.js'
import { prepareWorkspace, SANDBOX_ROOT, type PreparedWorkspace } from './workspace.js'

/** Where the runner's files live inside a repetition's workspace. */
export const CHAOS_DIR = '.intutic-chaos'
/** The events file as the sandbox sees it (the workspace is mounted at /work). */
export const SANDBOX_EVENTS_PATH = `/work/${CHAOS_DIR}/events.jsonl`

/** A running dedicated proxy. */
export interface ProxyProcess {
  /** Resolves with a description of how the process ended. */
  exited: Promise<string>
  stop(): Promise<void>
}

/** A run refused before any repetition started. */
export class ChaosRefusal extends Error {}

/** Everything the run does to the outside world. */
export interface ChaosDeps {
  /** Select the sandbox backend, check its health, prepare the image. Throws when unavailable. */
  readySandbox(image: string): Promise<{ name: string }>
  /** Run one command in the sandbox; resolves with its exit code. */
  runInSandbox(args: {
    command: string[]
    workdir: string
    env: Record<string, string>
    image: string
    name: string
    onStdout: (chunk: Buffer) => void
    signal?: AbortSignal
  }): Promise<number>
  /** The proxy env the sandboxed agent gets for a proxy on the host's `port`. */
  sandboxEnv(port: number): Record<string, string>
  /** Start the proxy binary `intutic start` runs, with this env and its output in `logPath`. */
  startProxy(args: { port: number; env: Record<string, string>; logPath: string }): ProxyProcess
  /** True when the proxy's health endpoint answers. */
  proxyHealthy(port: number): Promise<boolean>
  freePort(): Promise<number>
  git: {
    /** `git status --porcelain` output; throws outside a repository. */
    status(cwd: string): Promise<string>
    worktreeAdd(cwd: string, dir: string): Promise<void>
    worktreeRemove(cwd: string, dir: string): Promise<void>
  }
  /** A fresh empty directory for a repetition's worktree to live under. */
  makeTempDir(): Promise<string>
  randomHex(bytes: number): string
  /** Where the agent's and verify's stdout is echoed (the terminal). */
  echo(chunk: Buffer): void
  log: { info(msg: string): void; warn(msg: string): void; dim(msg: string): void }
}

export interface ChaosRunOptions {
  experiment: Experiment
  cwd: string
  image: string
  outPath: string
  keep: boolean
  /** How often the events file is tailed for abort conditions. */
  pollMs?: number
  /** How long the proxy gets to answer its health endpoint. */
  healthTimeoutMs?: number
  /** The host's policy snapshot, copied into each repetition for its gates. */
  snapshotRules?: string
  /** The host's approved-bypass list, copied in the same way. */
  approvedBypasses?: string
}

export interface RepetitionReport {
  repetition: number
  baseline: boolean
  runId: string
  canary: string
  agentExitCode: number | null
  verifyExitCode: number | null
  costUsd: number
  durationS: number
  malformedEvents: number
  aborted?: string
  error?: string
  probes?: Partial<Record<ProbeId, ProbeResult>>
  eventsPath: string
  agentOutPath: string
  /** Set with --keep: the worktree left in place. */
  workspace?: string
}

export interface ChaosReport {
  version: 1
  experiment: Experiment
  startedAt: string
  finishedAt: string
  sandbox: string
  repetitions: RepetitionReport[]
  probes: ProbeReport[]
  verdict: RunVerdict
  warnings: string[]
  malformedEvents: number
  reportPath: string
}

interface RepetitionOutcome {
  report: RepetitionReport
  events: ChaosEvent[]
  /** What carrying the gates in did; absent when the worktree was never made. */
  prepared?: PreparedWorkspace
}

/** Run an experiment end to end and write its report. */
export async function runChaos(opts: ChaosRunOptions, deps: ChaosDeps): Promise<ChaosReport> {
  const { experiment, cwd } = opts
  const startedAt = new Date().toISOString()

  // Each repetition is a worktree of HEAD: uncommitted changes would reach
  // none of them, and the baseline and faulted runs must start from the same
  // commit for the comparison to mean anything.
  let status: string
  try {
    status = await deps.git.status(cwd)
  } catch (err) {
    throw new ChaosRefusal(`chaos run needs a git repository: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (status.trim()) {
    throw new ChaosRefusal(
      'the working tree has uncommitted changes. Every repetition starts from a fresh worktree of HEAD, ' +
        'so commit or stash them first — otherwise the agent would run against code you are not looking at.',
    )
  }

  // Never falls back to the host: an unavailable sandbox refuses the run.
  const sandbox = await deps.readySandbox(opts.image)

  const artifactsRoot = opts.outPath.replace(/\.json$/i, '')
  const repetitions: RepetitionOutcome[] = []
  let stopReason: string | undefined
  let skippedFaulted = false

  for (let i = 0; i < experiment.repeat * 2; i++) {
    const baseline = i < experiment.repeat
    if (!baseline && repetitions.some((r) => r.report.baseline && r.report.verifyExitCode !== 0)) {
      // The run is invalid already; faulted repetitions would only spend tokens.
      skippedFaulted = true
      break
    }
    deps.log.info(`Repetition ${i + 1}/${experiment.repeat * 2} (${baseline ? 'baseline' : 'faulted'})`)
    const outcome = await runRepetition(i, baseline, opts, deps, path.join(artifactsRoot, `rep-${i}`))
    repetitions.push(outcome)
    if (outcome.prepared && !repetitions.some((r) => r !== outcome && r.prepared)) logPrepared(outcome.prepared, deps)
    if (outcome.report.error) {
      stopReason = `runner error in repetition ${i}: ${outcome.report.error}`
      break
    }
    if (outcome.report.aborted) {
      // An aborted run is not resumed.
      stopReason = `repetition ${i}: ${outcome.report.aborted}`
      break
    }
  }

  // ── Scoring ──
  const warnings: string[] = []
  const usable = repetitions.filter((r) => !r.report.error)
  const baselines = usable.filter((r) => r.report.baseline)
  const faulted = usable.filter((r) => !r.report.baseline)
  const baselineMeanCost = baselines.length
    ? baselines.reduce((s, r) => s + r.report.costUsd, 0) / baselines.length
    : null

  for (const r of faulted) {
    r.report.probes = evaluateRepetition(
      experiment.probes,
      {
        events: r.events,
        agentOut: await readOr(r.report.agentOutPath, ''),
        verifyExitCode: r.report.verifyExitCode,
        canary: r.report.canary,
      },
      baselineMeanCost,
    )
  }
  const probes = aggregateProbes(experiment.probes, faulted.map((r) => r.report.probes ?? {}))

  warnings.push(
    ...silenceWarnings(
      experiment.faults,
      faulted.map((r) => ({ repetition: r.report.repetition, events: r.events })),
    ),
  )
  if (experiment.probes.some((p) => p.id === 'cost_multiplier_below') && faulted.length && !(baselineMeanCost && baselineMeanCost > 0)) {
    warnings.push('cost_multiplier_below: the baseline cost was 0 (no llm_usage events), so the probe was not evaluated')
  }
  // Every repetition is prepared from the same project, so one says it.
  warnings.push(...(repetitions.find((r) => r.prepared)?.prepared?.warnings ?? []))
  const malformed = repetitions.reduce((s, r) => s + r.report.malformedEvents, 0)
  if (malformed) warnings.push(`${malformed} malformed event line${malformed > 1 ? 's' : ''} ignored`)
  if (skippedFaulted) warnings.push('faulted repetitions skipped: a baseline repetition failed verify')

  const verdict = decideVerdict({
    baselineVerify: baselines.map((r) => ({ repetition: r.report.repetition, code: r.report.verifyExitCode })),
    probes,
    faultsInjected: faulted.reduce((n, r) => n + r.events.filter((e) => e.type === 'fault_injected').length, 0),
    abortReason: stopReason,
  })

  const report: ChaosReport = {
    version: 1,
    experiment,
    startedAt,
    finishedAt: new Date().toISOString(),
    sandbox: sandbox.name,
    repetitions: repetitions.map((r) => r.report),
    probes,
    verdict,
    warnings,
    malformedEvents: malformed,
    reportPath: opts.outPath,
  }
  await fs.mkdir(path.dirname(opts.outPath), { recursive: true })
  await fs.writeFile(opts.outPath, JSON.stringify(report, null, 2) + '\n')
  return report
}

async function runRepetition(
  index: number,
  baseline: boolean,
  opts: ChaosRunOptions,
  deps: ChaosDeps,
  artifactsDir: string,
): Promise<RepetitionOutcome> {
  const { experiment } = opts
  const runId = `${experiment.name.slice(0, 40)}-r${index}-${deps.randomHex(4)}`
  const canary = `E-INTUTIC-${deps.randomHex(4).toUpperCase()}`
  const plan = encodeChaosPlan({
    v: CHAOS_PLAN_VERSION,
    runId,
    repetition: index,
    canary,
    faults: baseline ? [] : experiment.faults,
  })

  const report: RepetitionReport = {
    repetition: index,
    baseline,
    runId,
    canary,
    agentExitCode: null,
    verifyExitCode: null,
    costUsd: 0,
    durationS: 0,
    malformedEvents: 0,
    eventsPath: path.join(artifactsDir, 'events.jsonl'),
    agentOutPath: path.join(artifactsDir, 'agent.out'),
  }

  const started = Date.now()
  const tempDir = await deps.makeTempDir()
  const workspace = path.join(tempDir, 'work')
  const chaosDir = path.join(workspace, CHAOS_DIR)
  const eventsPath = path.join(chaosDir, 'events.jsonl')
  let worktreeAdded = false
  let proxy: ProxyProcess | undefined
  let prepared: PreparedWorkspace | undefined

  try {
    await deps.git.worktreeAdd(opts.cwd, workspace)
    worktreeAdded = true
    // World-writable: the sandboxed agent (and the gates inside it) run as an
    // unprivileged user that must append to the events file.
    await fs.mkdir(chaosDir, { recursive: true, mode: 0o777 })
    await fs.chmod(chaosDir, 0o777)
    await fs.writeFile(eventsPath, '', { mode: 0o666 })
    await fs.chmod(eventsPath, 0o666)
    // The gates count calls in files under `<events>.gate-counters/`
    // (chaosGate.ts). Made here for the same reason: a directory the sandbox
    // user creates is its own, and on a Linux host the runner, another uid,
    // could not then delete what is in it, so the worktree would stay behind.
    await fs.mkdir(`${eventsPath}.gate-counters`, { mode: 0o777 })
    await fs.chmod(`${eventsPath}.gate-counters`, 0o777)
    prepared = await prepareWorkspace({
      hostRoot: opts.cwd,
      workspace,
      policyDir: path.join(CHAOS_DIR, 'policy'),
      snapshotRules: opts.snapshotRules,
      approvedBypasses: opts.approvedBypasses,
    })

    const port = await deps.freePort()
    proxy = deps.startProxy({
      port,
      env: { PORT: String(port), [CHAOS_PLAN_ENV]: plan, [CHAOS_EVENTS_ENV]: eventsPath },
      logPath: path.join(chaosDir, 'proxy.log'),
    })
    await waitHealthy(proxy, port, deps, opts.healthTimeoutMs ?? 30_000)

    const base = deps.sandboxEnv(port)
    const env: Record<string, string> = {
      ...base,
      // Anything inside the sandbox that asks where the proxy is (the gates,
      // a nested `intutic`) reaches this repetition's proxy.
      INTUTIC_PROXY_URL: `http://${base.INTUTIC_SANDBOX_PROXY_HOST ?? 'host.docker.internal'}:${port}`,
      // Where the gates find the snapshot and bypass list carried in.
      ...prepared.env,
      [CHAOS_PLAN_ENV]: plan,
      [CHAOS_EVENTS_ENV]: SANDBOX_EVENTS_PATH,
    }

    // ── The agent, watched for abort conditions ──
    const agentOut = createWriteStream(path.join(chaosDir, 'agent.out'))
    const controller = new AbortController()
    const agentStarted = Date.now()
    const check = async (): Promise<void> => {
      if (report.aborted) return
      const { events } = parseChaosEvents(await readOr(eventsPath, ''))
      const reason = abortReason(experiment.abort, events, (Date.now() - agentStarted) / 1000)
      if (!reason) return
      report.aborted = reason
      await fs.appendFile(
        eventsPath,
        JSON.stringify({ ts: new Date().toISOString(), runId, component: 'runner', type: 'abort', reason }) + '\n',
      )
      deps.log.warn(`Aborting repetition ${index}: ${reason}`)
      controller.abort()
    }
    let checking: Promise<void> = Promise.resolve()
    const timer = setInterval(() => {
      checking = checking.then(check).catch(() => {})
    }, opts.pollMs ?? 1000)
    try {
      report.agentExitCode = await deps.runInSandbox({
        command: ['sh', '-c', experiment.agent],
        workdir: workspace,
        env,
        image: opts.image,
        name: `intutic-chaos-${runId}-agent`,
        onStdout: (chunk) => {
          agentOut.write(chunk)
          deps.echo(chunk)
        },
        signal: controller.signal,
      })
    } finally {
      clearInterval(timer)
      await checking
      await closeStream(agentOut)
    }
    // A condition met in the agent's last second counts too.
    await check()

    if (!report.aborted) {
      const verifyOut = createWriteStream(path.join(chaosDir, 'verify.out'))
      try {
        report.verifyExitCode = await deps.runInSandbox({
          command: ['sh', '-c', experiment.verify],
          workdir: workspace,
          env,
          image: opts.image,
          name: `intutic-chaos-${runId}-verify`,
          onStdout: (chunk) => {
            verifyOut.write(chunk)
            deps.echo(chunk)
          },
        })
      } finally {
        await closeStream(verifyOut)
      }
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
  } finally {
    if (proxy) await proxy.stop()
    report.durationS = Math.round((Date.now() - started) / 100) / 10
    // Keep what the repetition left behind next to the report: the worktree
    // that holds it is about to go.
    await fs.cp(chaosDir, artifactsDir, { recursive: true }).catch(() => {})
    if (worktreeAdded && !opts.keep) {
      await deps.git.worktreeRemove(opts.cwd, workspace).catch((err) => {
        deps.log.warn(`Could not remove worktree ${workspace}: ${err instanceof Error ? err.message : String(err)}`)
      })
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    } else if (worktreeAdded) {
      report.workspace = workspace
    } else {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const { events, malformed } = parseChaosEvents(await readOr(report.eventsPath, await readOr(eventsPath, '')))
  report.malformedEvents = malformed
  report.costUsd = repetitionCost(events)
  return { report, events, prepared }
}

/** Say what carrying the gates in did, once per run. */
function logPrepared(p: PreparedWorkspace, deps: ChaosDeps): void {
  if (p.copied.length) deps.log.info(`Carried into each repetition from the project: ${p.copied.join(', ')}`)
  if (p.rewritten.length) {
    deps.log.info(`Rewrote host paths to ${SANDBOX_ROOT} in each repetition's copy of: ${p.rewritten.join(', ')}`)
  }
  if (p.settings.length && !p.settings.some((s) => p.rewritten.includes(s))) {
    deps.log.dim(`Hook settings carried unchanged (no host paths in them): ${p.settings.join(', ')}`)
  }
  if (p.snapshot) deps.log.info(`Policy snapshot for the gates: ${p.snapshot}`)
  for (const w of p.warnings) deps.log.warn(w)
}

/** Wait for the proxy's health endpoint; fail if it exits first or never answers. */
async function waitHealthy(proxy: ProxyProcess, port: number, deps: ChaosDeps, timeoutMs: number): Promise<void> {
  let exited: string | undefined
  void proxy.exited.then((how) => {
    exited = how
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`the proxy exited before becoming healthy (${exited})`)
    if (await deps.proxyHealthy(port)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  if (exited !== undefined) throw new Error(`the proxy exited before becoming healthy (${exited})`)
  throw new Error(`the proxy never became healthy on port ${port} within ${Math.round(timeoutMs / 1000)}s`)
}

/** End a write stream and wait until everything written is on disk. */
function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()))
}

async function readOr(file: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return fallback
  }
}
