/**
 * Every command picks the control plane the same way: flag, then
 * INTUTIC_CONTROL_PLANE_URL, then a workspace set up with `init --dev`, then
 * the URL saved by `intutic login`. Each command below runs for real against
 * a temporary ~/.intutic, and the first request it makes shows which control
 * plane it chose.
 *
 * Before, about half the commands ignored the workspace's dev setting, and
 * the other half put it ahead of the environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runFindingsList } from '../commands/findings.js'
import { runTracesList } from '../commands/traces.js'
import { runIntegrityRoots } from '../commands/integrity.js'
import { runGatewayList } from '../commands/gateway.js'
import { runTeamList } from '../commands/team.js'
import { runOrgCreate } from '../commands/org.js'
import { runWhoami } from '../commands/whoami.js'
import { runCredentialsList } from '../commands/credentials.js'
import { runPredictCost } from '../commands/predict-cost.js'
import { runRoutingAdoptionReport } from '../commands/routing.js'
import { runSopsPull } from '../commands/sops.js'
import { runBudget } from '../commands/budget.js'
import { runPolicyReplay } from '../commands/policy.js'
import { runGuardrailsSourcesList } from '../commands/guardrails.js'
import { getClient as getSkillClient } from '../commands/skill.js'
import { runStatus } from '../commands/status.js'

vi.mock('../lib/process.js', () => ({ getActiveAgentProcesses: () => [], isSyncDaemonRunning: () => false }))

type Run = (dev?: boolean) => Promise<unknown>

const COMMANDS: Array<[string, Run]> = [
  ['findings list', (dev) => runFindingsList({ dev })],
  ['traces list', (dev) => runTracesList({ dev })],
  ['integrity roots', (dev) => runIntegrityRoots({ dev })],
  ['gateway list', (dev) => runGatewayList({ dev })],
  ['team list', (dev) => runTeamList({ dev, org: 'org_test' })],
  ['org create', (dev) => runOrgCreate({ dev, orgName: 'Acme', domain: 'acme.example' })],
  ['whoami', (dev) => runWhoami({ dev })],
  ['credentials list', (dev) => runCredentialsList({ dev })],
  ['predict-cost', (dev) => runPredictCost({ dev, model: 'm', tokens: '10' })],
  ['routing adoption-report', (dev) => runRoutingAdoptionReport({ dev, candidateModel: 'm' })],
  ['sops pull', (dev) => runSopsPull({ dev })],
  ['budget', (dev) => runBudget({ dev })],
  ['policy replay', (dev) => runPolicyReplay('wasm_1', { dev })],
  ['guardrails sources list', (dev) => runGuardrailsSourcesList({ dev })],
  ['loop (skill client)', async (dev) => (await getSkillClient(dev)).get('/api/v1/probe')],
]

const LOCAL = 'http://localhost:3001'
const STORED = 'https://cp.stored.example'
const ENV = 'https://cp.env.example'

describe('every command resolves the control plane the same way', () => {
  const saved = { HOME: process.env.HOME, url: process.env.INTUTIC_CONTROL_PLANE_URL, dev: process.env.INTUTIC_DEV }
  let home: string
  let fetchMock: ReturnType<typeof vi.fn>

  function writeIntutic(file: string, body: object): void {
    mkdirSync(join(home, '.intutic'), { recursive: true })
    writeFileSync(join(home, '.intutic', file), JSON.stringify(body))
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'intutic-cp-resolution-'))
    process.env.HOME = home
    delete process.env.INTUTIC_CONTROL_PLANE_URL
    delete process.env.INTUTIC_DEV
    // A plain key in the file is used as is, without the keychain.
    writeIntutic('credentials.json', {
      apiKey: ['vk', 'test', 'resolution'].join('_'),
      workspaceId: 'ws_test',
      email: 'dev@example.com',
      controlPlaneUrl: STORED,
    })
    writeIntutic('config.json', { harnesses: [], configVersion: 0, devMode: true, workspaceRoot: home })

    fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
    for (const [key, value] of [['HOME', saved.HOME], ['INTUTIC_CONTROL_PLANE_URL', saved.url], ['INTUTIC_DEV', saved.dev]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  async function firstOrigin(run: Run, dev?: boolean): Promise<string> {
    await run(dev).catch(() => {})
    expect(fetchMock).toHaveBeenCalled()
    return new URL(String(fetchMock.mock.calls[0][0])).origin
  }

  it.each(COMMANDS)('%s: a workspace set up with --dev beats the saved login', async (_name, run) => {
    expect(await firstOrigin(run)).toBe(LOCAL)
  })

  it.each(COMMANDS)('%s: INTUTIC_CONTROL_PLANE_URL beats the workspace dev setting', async (_name, run) => {
    process.env.INTUTIC_CONTROL_PLANE_URL = ENV
    expect(await firstOrigin(run)).toBe(ENV)
  })

  it.each(COMMANDS)('%s: --dev beats INTUTIC_CONTROL_PLANE_URL', async (_name, run) => {
    process.env.INTUTIC_CONTROL_PLANE_URL = ENV
    expect(await firstOrigin(run, true)).toBe(LOCAL)
  })

  it('status shows the control plane commands will use, not just the saved one', async () => {
    const lines: string[] = []
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')))
    await runStatus()
    const field = lines.find((l) => l.includes('Control Plane'))
    expect(field).toContain(LOCAL)
    expect(field).not.toContain(STORED)
  })

  it.each(COMMANDS)('%s: the saved login is used when nothing else is set', async (_name, run) => {
    writeIntutic('config.json', { harnesses: [], configVersion: 0, devMode: false, workspaceRoot: home })
    expect(await firstOrigin(run)).toBe(STORED)
  })
})
