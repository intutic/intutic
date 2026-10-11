/**
 * `intutic chaos` — run an agent with a known fault injected, check what it
 * did, score it.
 *
 * - `validate <file>` checks an experiment file;
 * - `list` prints the fault catalog;
 * - `run <file>` runs the experiment in the sandbox (never on the host).
 *
 * The orchestration lives in lib/chaos/runner.ts; this file wires it to the
 * real sandbox, proxy binary and git, and prints the result.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import pc from 'picocolors'
import { FAULT_CATALOG, FAULT_IDS, type RunVerdict } from '@intutic/shared-types'
import { deriveIdentity, type GraphIdentity } from '../lib/graphIdentity.js'
import { log } from '../lib/logger.js'
import { resolveProxyBinary } from '../lib/proxyBinary.js'
import { resolveSnapshotRulesPath } from '../lib/policySnapshot.js'
import { selectBackend } from '../lib/sandbox/index.js'
import { loadExperiment } from '../lib/chaos/experiment.js'
import { ChaosRefusal, runChaos, type ChaosDeps, type ChaosReport, type ProxyProcess } from '../lib/chaos/runner.js'
import {
  readySandbox,
  sandboxProxyEnv,
  sandboxSpec,
  SandboxUnavailableError,
  type SandboxExecOptions,
} from './exec.js'

/** `intutic chaos validate <file>` */
export async function runChaosValidate(file: string): Promise<void> {
  const result = await loadExperiment(file)
  if (!result.ok) {
    log.error(`${file} is not a valid experiment:`)
    for (const e of result.errors) log.dim(`  ${e}`)
    process.exit(1)
  }
  const x = result.experiment
  log.success(`${file} is valid: ${x.name} — ${x.faults.length} fault${x.faults.length > 1 ? 's' : ''}, ${x.repeat} baseline + ${x.repeat} faulted repetitions`)
}

/** `intutic chaos list` */
export function runChaosList(): void {
  const width = Math.max(...FAULT_IDS.map((id) => id.length))
  console.log(pc.bold(`${'FAULT'.padEnd(width)}  ${'INJECTED BY'.padEnd(18)}  SAFETY`))
  for (const id of FAULT_IDS) {
    const { injectedBy, safety } = FAULT_CATALOG[id]
    console.log(`${id.padEnd(width)}  ${injectedBy.join(', ').padEnd(18)}  ${safety === 'mutating' ? pc.yellow(safety) : safety}`)
  }
  console.log('')
  log.dim('fail_safe faults deny, delay or error; mutating faults change what the agent sees. Every fault runs only in the sandbox.')
  log.dim(`Example experiments: ${examplesDir()}`)
}

/** The example experiments shipped with the CLI (src/ and dist/ sit at the same depth). */
export function examplesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../resources/chaos')
}

/** `intutic chaos run <file>` */
export async function runChaosRun(
  file: string,
  opts: { sandboxImage?: string; out?: string; keep?: boolean },
): Promise<void> {
  const result = await loadExperiment(file)
  if (!result.ok) {
    log.error(`${file} is not a valid experiment:`)
    for (const e of result.errors) log.dim(`  ${e}`)
    process.exit(1)
  }
  const experiment = result.experiment
  const { DEFAULT_SANDBOX_IMAGE } = await import('../lib/sandbox/image.js')
  const image = opts.sandboxImage ?? experiment.sandbox_image ?? DEFAULT_SANDBOX_IMAGE
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Under the temp dir by default: a report in the project would dirty the
  // tree the next run requires clean.
  const outPath = path.resolve(opts.out ?? path.join(os.tmpdir(), 'intutic-chaos', `report-${experiment.name}-${stamp}.json`))

  log.header(`Chaos run: ${experiment.name}`)
  log.dim('Every repetition runs a real agent and spends real tokens; the cost ceiling in the experiment applies to each.')

  let report: ChaosReport
  try {
    report = await runChaos(
      {
        experiment,
        cwd: process.cwd(),
        image,
        outPath,
        keep: Boolean(opts.keep),
        // Where this machine's gates read them, as the gates resolve it.
        snapshotRules: resolveSnapshotRulesPath(),
        approvedBypasses:
          process.env.INTUTIC_APPROVED_BYPASSES || path.join(os.homedir(), '.intutic', 'hooks', 'approved-bypasses.jsonl'),
      },
      await defaultDeps(),
    )
  } catch (err) {
    if (err instanceof ChaosRefusal || err instanceof SandboxUnavailableError) {
      log.error(`Refusing to run: ${err.message}`)
      if (err instanceof SandboxUnavailableError) {
        log.dim('A chaos run never falls back to the host. Start Docker (or Podman) and try again.')
      }
      process.exit(1)
    }
    throw err
  }

  printSummary(report)
  process.exit(exitCode(report.verdict))
}

/** 0 scored, 1 aborted, 2 invalid. */
export function exitCode(verdict: RunVerdict): number {
  return verdict.kind === 'scored' ? 0 : verdict.kind === 'aborted' ? 1 : 2
}

export function printSummary(report: ChaosReport): void {
  const v = report.verdict
  log.header(`Result: ${report.experiment.name}`)
  if (v.kind === 'invalid') {
    log.error(`Invalid: ${v.reason}`)
    log.dim('Fix the task (or its verify command) so it passes without faults; no score is given.')
  } else {
    const label = v.kind === 'scored' ? pc.green('scored') : pc.yellow(`aborted (${v.reason})`)
    log.field('Verdict', label)
    log.field('Resilience score', `${pc.bold(String(v.score))} / 100`)
    console.log('')
    for (const p of report.probes) {
      const rate = p.evaluated ? `${p.passes}/${p.evaluated}  ${Math.round(p.passRate * 100)}%` : 'not evaluated'
      const extra = p.allPassed !== undefined && p.evaluated ? `  pass^k: ${p.allPassed ? 'yes' : 'no'}` : ''
      console.log(`  ${p.id.padEnd(24)} ${rate.padEnd(16)} weight ${p.weight}${extra}`)
    }
  }
  if (report.warnings.length) {
    console.log('')
    for (const w of report.warnings) log.warn(w)
  }
  console.log('')
  log.field('Report', report.reportPath)
}

/**
 * The sandbox environment for a repetition. Never the workspace login: each
 * repetition's proxy runs standalone, so it cannot resolve an Intutic key, and
 * handing one to the agent in place of its provider keys would fail every
 * model call (every baseline, so every run, invalid). The agent keeps its own
 * provider keys, passed by name, and the standalone proxy forwards them.
 */
export function chaosSandboxEnv(identity: GraphIdentity, port: number): Record<string, string> {
  return sandboxProxyEnv(null, identity, String(port), []).env
}

/** The real sandbox, proxy binary and git. */
async function defaultDeps(): Promise<ChaosDeps> {
  const identity = deriveIdentity()
  const sandboxOpts = (image: string): SandboxExecOptions => ({
    kind: 'oci',
    image,
    memory: '2g',
    cpus: '2',
    pidsLimit: 512,
    allow: [],
  })

  return {
    async readySandbox(image) {
      // OCI only: it mounts the repetition's worktree at /work, which the
      // events path inside the sandbox depends on.
      const backend = await readySandbox('oci', {}, image)
      return { name: backend.name }
    },
    runInSandbox({ command, workdir, env, image, name, onStdout, signal }) {
      const spec = sandboxSpec(command, workdir, env, sandboxOpts(image), { tty: false, name, onStdout, signal })
      return selectBackend('oci', env).run(spec)
    },
    sandboxEnv: (port) => chaosSandboxEnv(identity, port),
    startProxy: ({ port, env, logPath }) => startProxy(port, env, logPath),
    async proxyHealthy(port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        return res.ok
      } catch {
        return false
      }
    },
    freePort,
    git: {
      status: (cwd) => git(cwd, ['status', '--porcelain']),
      worktreeAdd: async (cwd, dir) => {
        await git(cwd, ['worktree', 'add', '--detach', dir, 'HEAD'])
      },
      worktreeRemove: async (cwd, dir) => {
        await git(cwd, ['worktree', 'remove', '--force', dir])
      },
    },
    makeTempDir: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'intutic-chaos-')),
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
    echo: (chunk) => {
      process.stdout.write(chunk)
    },
    log,
  }
}

/**
 * A dedicated proxy: the binary `intutic start` runs, on its own port, always
 * standalone. It never reports to a control plane, so injected failures cannot
 * reach a workspace's trust scores, incidents or rule promotion; local rules
 * still apply.
 */
function startProxy(port: number, env: Record<string, string>, logPath: string): ProxyProcess {
  const out = fs.openSync(logPath, 'a')
  const inherited = { ...process.env }
  delete inherited.CONTROL_PLANE_URL
  const child = spawn(resolveProxyBinary(), [], {
    stdio: ['ignore', out, out],
    env: { ...inherited, INTUTIC_STANDALONE: '1', ...env },
  })
  fs.closeSync(out)
  const exited = new Promise<string>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code === 'ENOENT' ? 'the intutic-proxy binary was not found; install it with npm install -g @intutic/proxy' : err.message),
    )
    child.on('exit', (code, signal) => resolve(signal ? `signal ${signal}` : `exit code ${code}; see ${logPath}`))
  })
  let done = false
  void exited.then(() => {
    done = true
  })
  return {
    exited,
    async stop() {
      if (done) return
      child.kill('SIGTERM')
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000).unref())
      if ((await Promise.race([exited, timeout])) === 'timeout') child.kill('SIGKILL')
    },
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git ${args[0]} exited ${code}`)),
    )
  })
}
