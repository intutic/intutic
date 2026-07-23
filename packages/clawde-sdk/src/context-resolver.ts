import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ResolvedContext } from './types'

export async function resolveContext(): Promise<ResolvedContext> {
  const configPath = join(homedir(), '.intutic', 'config.json')

  // 1. Primary: Read from sync-daemon's config (written every 30s)
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      return {
        gitBranch: config.gitBranch,
        jiraTicket: config.jiraTicket,
        pagerdutyIncident: config.pagerdutyIncident,
        ciPipeline: config.ciPipeline,
        workingDirectory: config.workingDirectory || process.cwd(),
        workspaceId: config.workspaceId,
        sessionId: config.sessionId,
      }
    } catch {
      // JSON parse failed or config locked, fallback to env vars
    }
  }

  // 2. Fallback: Environment variables (if sync-daemon not running)
  return {
    workspaceId: process.env.INTUTIC_WORKSPACE_ID,
    sessionId: process.env.INTUTIC_SESSION_ID,
    gitBranch: process.env.GIT_BRANCH,
    ciPipeline: process.env.GITHUB_RUN_ID
      || process.env.BUILDKITE_BUILD_ID
      || process.env.CIRCLE_BUILD_NUM,
    pagerdutyIncident: process.env.PD_INCIDENT_ID,
    workingDirectory: process.cwd(),
  }
}
