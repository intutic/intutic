import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveContext } from '../src/context-resolver'

// HOME points at a scratch directory, so the developer's own
// ~/.intutic/config.json is never read, written or deleted by these tests.
const ENV_KEYS = [
  'HOME',
  'INTUTIC_WORKSPACE_ID',
  'INTUTIC_SESSION_ID',
  'GIT_BRANCH',
  'GITHUB_RUN_ID',
  'BUILDKITE_BUILD_ID',
  'CIRCLE_BUILD_NUM',
  'PD_INCIDENT_ID',
] as const

describe('context-resolver', () => {
  let home: string
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

  function writeConfig(config: unknown): void {
    mkdirSync(join(home, '.intutic'), { recursive: true })
    writeFileSync(join(home, '.intutic', 'config.json'), JSON.stringify(config), 'utf-8')
  }

  function setEnv(): void {
    process.env.INTUTIC_WORKSPACE_ID = 'ws_env_vars'
    process.env.INTUTIC_SESSION_ID = 'sess_env_vars'
    process.env.GIT_BRANCH = 'main'
    process.env.GITHUB_RUN_ID = 'run-github-vars'
    process.env.PD_INCIDENT_ID = 'pd_env_vars'
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    home = mkdtempSync(join(tmpdir(), 'clawde-context-'))
    process.env.HOME = home
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('resolves context from the config file when it carries the fields', async () => {
    setEnv()
    writeConfig({
      gitBranch: 'feature/T4-sdk-wrapper',
      jiraTicket: 'INT-404',
      pagerdutyIncident: 'pd_999',
      ciPipeline: 'run-888',
      workingDirectory: '/some/dir',
      workspaceId: 'ws_test123',
      sessionId: 'sess_test456',
    })

    const context = await resolveContext()
    expect(context).toEqual({
      gitBranch: 'feature/T4-sdk-wrapper',
      jiraTicket: 'INT-404',
      pagerdutyIncident: 'pd_999',
      ciPipeline: 'run-888',
      workingDirectory: '/some/dir',
      workspaceId: 'ws_test123',
      sessionId: 'sess_test456',
    })
  })

  it('falls back to environment variables when the config file is not present', async () => {
    setEnv()
    const context = await resolveContext()

    expect(context.workspaceId).toBe('ws_env_vars')
    expect(context.sessionId).toBe('sess_env_vars')
    expect(context.gitBranch).toBe('main')
    expect(context.ciPipeline).toBe('run-github-vars')
    expect(context.pagerdutyIncident).toBe('pd_env_vars')
    expect(context.workingDirectory).toBe(process.cwd())
  })

  it('still reads the environment once `intutic init` has written its config file', async () => {
    // The shape `intutic init` writes: none of the context fields.
    writeConfig({ workspaceRoot: '/repo', harnesses: ['claude_code'], configVersion: 3, devMode: false })
    setEnv()

    const context = await resolveContext()
    expect(context.workspaceId).toBe('ws_env_vars')
    expect(context.sessionId).toBe('sess_env_vars')
    expect(context.gitBranch).toBe('main')
    expect(context.ciPipeline).toBe('run-github-vars')
    expect(context.pagerdutyIncident).toBe('pd_env_vars')
    expect(context.workingDirectory).toBe(process.cwd())
  })

  it('merges field by field: config values where present, environment otherwise', async () => {
    writeConfig({ workspaceId: 'ws_from_config', gitBranch: '' })
    setEnv()

    const context = await resolveContext()
    expect(context.workspaceId).toBe('ws_from_config')
    expect(context.sessionId).toBe('sess_env_vars')
    expect(context.gitBranch).toBe('main') // an empty string is not a value
  })

  it('reads the environment when the config file is not valid JSON', async () => {
    mkdirSync(join(home, '.intutic'), { recursive: true })
    writeFileSync(join(home, '.intutic', 'config.json'), '{not json', 'utf-8')
    setEnv()

    expect((await resolveContext()).workspaceId).toBe('ws_env_vars')
  })
})
