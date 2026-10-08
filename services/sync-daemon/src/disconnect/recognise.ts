/**
 * recognise.ts — how disconnect tells Intutic's entries from the user's.
 *
 * Every test here is on content Intutic writes and nothing else: a hook
 * command that runs a gate script from an `.intutic/hooks/` directory, a
 * rules file that starts with the generated header, a URL on the origin of
 * the proxy connect pointed the harness at.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { proxyHost } from '@intutic/shared-types'
import { isObject } from './plan.js'

/** First line of every rules file Intutic generates. */
export const RULES_HEADER = '# Intutic Governance Rules (auto-generated)'

export function startsWithRulesHeader(text: string): boolean {
  return text.startsWith(RULES_HEADER)
}

/** Whether `text` mentions `marker`, for owned files recognised by a line Intutic writes in them. */
export function contains(marker: string): (text: string) => boolean {
  return (text) => text.includes(marker)
}

/**
 * Whether `command` runs the gate script `script` from an `.intutic/hooks/`
 * directory (any workspace's, or the home one) — however it is quoted or
 * whichever interpreter runs it.
 */
export function runsGate(command: unknown, script: string): boolean {
  if (typeof command !== 'string') return false
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`[\\\\/]\\.intutic[\\\\/]hooks[\\\\/]${escaped}(?=["'\\s]|$)`).test(command)
}

/**
 * Whether a `{ matcher, hooks: [{ command }] }` entry is Intutic's: every
 * hook in it runs `script`. The shape Claude Code, Codex, Continue, Muse,
 * Gemini CLI and Pi share.
 */
export function isGateEntry(script: string): (entry: unknown) => boolean {
  return (entry) => {
    if (!isObject(entry) || !Array.isArray(entry.hooks) || entry.hooks.length === 0) return false
    return entry.hooks.every((h) => isObject(h) && runsGate(h.command, script))
  }
}

/** Whether a `{ command }` entry (Cursor, Windsurf) runs `script`. */
export function isGateCommandEntry(script: string): (entry: unknown) => boolean {
  return (entry) => isObject(entry) && runsGate(entry.command, script)
}

/** Loopback hosts compare equal: connect writes `localhost` in one place and `127.0.0.1` in another. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value)
    const host = url.hostname === 'localhost' || url.hostname === '[::1]' ? '127.0.0.1' : url.hostname
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `${url.protocol}//${host}:${port}`
  } catch {
    return null
  }
}

/**
 * A test for "this value is a URL on the Intutic proxy", given the proxy
 * URLs connect is known to have written. Any path on the proxy's origin
 * counts: connect writes the bare host for Anthropic SDKs, `/v1` for OpenAI
 * ones, and a trailing slash for Continue.
 */
export function proxyUrlMatcher(proxyUrls: readonly string[]): (value: unknown) => boolean {
  const origins = new Set(proxyUrls.map((u) => originOf(proxyHost(u))).filter((o): o is string => o !== null))
  return (value) => typeof value === 'string' && origins.size > 0 && origins.has(originOf(value) ?? '')
}

/**
 * Proxy URLs an earlier connect left in a workspace's own generated files:
 * the "Proxy URL" line of a rules file and `INTUTIC_PROXY_URL` in
 * `.env.intutic`. Used when connect predates the recorded list.
 */
export async function proxyUrlsInWorkspace(workspaceRoot: string): Promise<string[]> {
  const found = new Set<string>()
  const files = ['CLAUDE.md', '.cursorrules', '.windsurfrules', 'AGENTS.md', '.github/copilot-instructions.md', '.env.intutic']
  for (const rel of files) {
    let text: string
    try {
      text = await node_fs.readFile(node_path.join(workspaceRoot, rel), 'utf-8')
    } catch {
      continue
    }
    if (!startsWithRulesHeader(text)) continue
    for (const m of text.matchAll(/^> \*\*Proxy URL:\*\* `([^`]+)`$/gm)) found.add(m[1]!)
    for (const m of text.matchAll(/^export INTUTIC_PROXY_URL="([^"]+)"$/gm)) found.add(m[1]!)
  }
  return [...found]
}
