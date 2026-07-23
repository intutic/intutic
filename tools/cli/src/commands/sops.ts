import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'

async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  const controlPlaneUrl = resolveControlPlaneUrl(devMode)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

export async function runSopsPush(name: string, opts: { dev?: boolean }): Promise<void> {
  log.header(`Intutic — Push SOP: ${name}`)

  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const sopsDir = join(workspaceRoot, '.intutic', 'sops', name)

  // 1. Verify directory exists
  try {
    const stat = await fs.stat(sopsDir)
    if (!stat.isDirectory()) {
      log.error(`Path is not a directory: ${sopsDir}`)
      process.exit(1)
    }
  } catch {
    log.error(`Local SOP folder not found: ${sopsDir}`)
    process.exit(1)
  }

  // 2. Read all markdown files
  let markdownContent = ''
  try {
    const entries = await fs.readdir(sopsDir)
    const mdFiles = entries.filter((e) => e.endsWith('.md'))
    if (mdFiles.length === 0) {
      log.error(`No markdown (.md) files found in local SOP folder: ${sopsDir}`)
      process.exit(1)
    }

    for (const file of mdFiles) {
      const content = await fs.readFile(join(sopsDir, file), 'utf-8')
      markdownContent += content + '\n\n'
    }
  } catch (err: any) {
    log.error(`Error reading SOP files: ${err.message}`)
    process.exit(1)
  }

  const cleanContent = markdownContent.trim()
  if (!cleanContent) {
    log.error('Combined markdown content is empty.')
    process.exit(1)
  }

  // 3. Format title (e.g. "postgres-migration" -> "Postgres Migration")
  const title = name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  // 4. Submit to control plane
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; sopId?: string }>(
      '/api/v1/sops',
      {
        title,
        markdown_content: cleanContent,
        risk_tier: 'LOW',
        complexity_tier: 'TIER_0',
        version: '1.0.0',
      }
    )

    if (res && res.sopId) {
      log.info(`Successfully promoted local SOP "${name}" to global Workspace SOP!`)
      log.field('SOP ID', res.sopId)
      log.field('Title', title)
    } else {
      log.error('Failed to create SOP on the control plane.')
      process.exit(1)
    }
  } catch (err: any) {
    log.error(`Failed to push SOP to control plane: ${err.message}`)
    process.exit(1)
  }
}
