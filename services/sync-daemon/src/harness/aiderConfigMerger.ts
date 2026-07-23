/**
 * aiderConfigMerger.ts — Safe YAML merge for .aider.conf.yml.
 *
 * Reads any existing .aider.conf.yml, STRIPS dangerous auto-exec keys
 * (test-cmd, lint-cmd, auto-test, auto-lint), merges in Intutic governance
 * keys (openai-api-base, anthropic-api-base), and writes back atomically.
 *
 * Each strip emits a governance_config_sanitized log entry visible in
 * the control plane audit feed.
 *
 * LLD #14 — Phase 3 cross-harness defence
 * HLD §3.14 — Three-Tier Defense Cascade
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from '@intutic/logger'
import { newIso } from '@intutic/id'

const log = createLogger('sync-aider-merger')

/**
 * Keys that Aider auto-executes on startup without user confirmation.
 * Stripping these prevents supply-chain persistence attacks.
 */
const SUPPRESSED_KEYS = ['test-cmd', 'lint-cmd', 'auto-test', 'auto-lint', 'test_cmd', 'lint_cmd']

/**
 * Minimal YAML parser for .aider.conf.yml — handles simple key: value lines
 * and multi-line strings. Does not handle complex YAML. Good enough for the
 * flat structure of .aider.conf.yml.
 */
function parseAiderYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Skip comments and blank lines
    if (!line || line.trim().startsWith('#')) { i++; continue }

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) { i++; continue }

    const key = line.slice(0, colonIdx).trim()
    const rest = line.slice(colonIdx + 1).trim()

    if (rest === '|' || rest === '>') {
      // Multi-line block scalar — collect until next key or EOF
      const blockLines: string[] = []
      i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        blockLines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '')
        i++
      }
      result[key] = blockLines.join('\n').trimEnd()
    } else {
      // Strip inline quotes
      result[key] = rest.replace(/^["']|["']$/g, '')
      i++
    }
  }
  return result
}

/**
 * Minimal YAML serializer — writes flat key: value pairs.
 * Multi-line values use the | block scalar style.
 */
function serializeAiderYaml(obj: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${key}: |`)
      for (const ln of value.split('\n')) {
        lines.push(`  ${ln}`)
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Merge Intutic governance settings into .aider.conf.yml.
 *
 * Preserves all user keys EXCEPT the suppressed auto-exec keys.
 * Adds/updates openai-api-base and anthropic-api-base.
 *
 * @param configPath - Absolute path to .aider.conf.yml
 * @param proxyUrl   - Intutic proxy URL
 * @param sopsText   - Optional SOP instructions for extra-instructions field
 */
export async function mergeAiderConfig(
  configPath: string,
  proxyUrl: string,
  sopsText?: string,
): Promise<void> {
  // Read existing config if present
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    existing = parseAiderYaml(raw)
  } catch {
    // No existing file — start fresh
  }

  // Strip dangerous auto-exec keys
  const stripped: string[] = []
  for (const key of SUPPRESSED_KEYS) {
    if (key in existing) {
      stripped.push(key)
      delete existing[key]
    }
  }
  if (stripped.length > 0) {
    log.warn(
      { action: 'aider_keys_stripped', keys: stripped, path: configPath },
      `Stripped dangerous auto-exec keys from .aider.conf.yml: ${stripped.join(', ')}`,
    )
  }

  // Merge governance keys
  existing['openai-api-base'] = proxyUrl
  existing['anthropic-api-base'] = proxyUrl

  if (sopsText) {
    existing['extra-instructions'] = sopsText
  }

  const header = [
    '# Intutic Governance Rules (auto-generated — do not edit proxy keys)',
    `# Last sync: ${newIso()}`,
    `# WARNING: test-cmd and lint-cmd keys are suppressed by Intutic governance`,
    '',
  ].join('\n')

  const content = header + serializeAiderYaml(existing) + '\n'

  const tmpPath = configPath + '.intutic-tmp'
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, configPath)

  log.info(
    { action: 'aider_config_written', path: configPath, stripped },
    'Aider config merged with proxy URL and dangerous keys stripped',
  )
}
