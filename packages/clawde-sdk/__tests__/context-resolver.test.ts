import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { resolveContext } from '../src/context-resolver'

describe('context-resolver', () => {
  const dotIntuticDir = join(homedir(), '.intutic')
  const configPath = join(dotIntuticDir, 'config.json')
  let backupConfig: string | null = null

  beforeAll(() => {
    // Backup existing config if it exists
    if (existsSync(configPath)) {
      backupConfig = readFileSync(configPath, 'utf-8')
    }
    if (!existsSync(dotIntuticDir)) {
      mkdirSync(dotIntuticDir, { recursive: true })
    }
  })

  afterAll(() => {
    // Restore backup or delete temporary file
    if (backupConfig !== null) {
      writeFileSync(configPath, backupConfig, 'utf-8')
    } else if (existsSync(configPath)) {
      unlinkSync(configPath)
    }
  })

  it('resolves context from sync-daemon config file when present', async () => {
    const mockConfig = {
      gitBranch: 'feature/T4-sdk-wrapper',
      jiraTicket: 'INT-404',
      pagerdutyIncident: 'pd_999',
      ciPipeline: 'run-888',
      workingDirectory: '/some/dir',
      workspaceId: 'ws_test123',
      sessionId: 'sess_test456',
    }

    writeFileSync(configPath, JSON.stringify(mockConfig), 'utf-8')

    const context = await resolveContext()
    expect(context.gitBranch).toBe('feature/T4-sdk-wrapper')
    expect(context.jiraTicket).toBe('INT-404')
    expect(context.pagerdutyIncident).toBe('pd_999')
    expect(context.ciPipeline).toBe('run-888')
    expect(context.workingDirectory).toBe('/some/dir')
    expect(context.workspaceId).toBe('ws_test123')
    expect(context.sessionId).toBe('sess_test456')
  })

  it('falls back to environment variables when config file is not present', async () => {
    // Remove the config file to trigger fallback
    if (existsSync(configPath)) {
      unlinkSync(configPath)
    }

    process.env.INTUTIC_WORKSPACE_ID = 'ws_env_vars'
    process.env.INTUTIC_SESSION_ID = 'sess_env_vars'
    process.env.GIT_BRANCH = 'main'
    process.env.GITHUB_RUN_ID = 'run-github-vars'
    process.env.PD_INCIDENT_ID = 'pd_env_vars'

    const context = await resolveContext()

    expect(context.workspaceId).toBe('ws_env_vars')
    expect(context.sessionId).toBe('sess_env_vars')
    expect(context.gitBranch).toBe('main')
    expect(context.ciPipeline).toBe('run-github-vars')
    expect(context.pagerdutyIncident).toBe('pd_env_vars')

    // Clean up env vars
    delete process.env.INTUTIC_WORKSPACE_ID
    delete process.env.INTUTIC_SESSION_ID
    delete process.env.GIT_BRANCH
    delete process.env.GITHUB_RUN_ID
    delete process.env.PD_INCIDENT_ID
  })
})
