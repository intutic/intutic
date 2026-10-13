import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ResolvedContext } from './types'

/** A non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * Each field comes from `~/.intutic/config.json` when that file carries it,
 * and from the environment otherwise. The file `intutic init` writes holds
 * none of these fields, so reading it must not hide the environment.
 */
export async function resolveContext(): Promise<ResolvedContext> {
  const configPath = join(homedir(), '.intutic', 'config.json')

  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (parsed !== null && typeof parsed === 'object') config = parsed as Record<string, unknown>
    } catch {
      // JSON parse failed or config locked: the environment alone decides.
    }
  }

  return {
    workspaceId: str(config.workspaceId) ?? process.env.INTUTIC_WORKSPACE_ID,
    sessionId: str(config.sessionId) ?? process.env.INTUTIC_SESSION_ID,
    gitBranch: str(config.gitBranch) ?? process.env.GIT_BRANCH,
    jiraTicket: str(config.jiraTicket),
    ciPipeline: str(config.ciPipeline)
      ?? (process.env.GITHUB_RUN_ID
      || process.env.BUILDKITE_BUILD_ID
      || process.env.CIRCLE_BUILD_NUM),
    pagerdutyIncident: str(config.pagerdutyIncident) ?? process.env.PD_INCIDENT_ID,
    workingDirectory: str(config.workingDirectory) ?? process.cwd(),
  }
}
