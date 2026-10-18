/**
 * The local SOPs' `decide:` rules as `intutic decide` sees them: each line
 * with its file and line number, parsed as the snapshot writer parses it
 * (`localDecideRules`), and the snapshot rewritten after a pin or the
 * disable marker changes.
 *
 * @module
 */

import * as node_path from 'node:path'
import {
  decideRuleHash,
  decideRuleRef,
  parseDecideLines,
  splitFrontMatter,
  type DecideDecl,
  type HarnessType,
} from '@intutic/shared-types'
import { homedir } from 'node:os'
import { loadLocalSopEntries, localDecideRules, localHoldTokensFor, writeLocalPolicySnapshot } from '@intutic/sync-daemon'
import { loadConfig, loadCredentials } from '../config/store.js'
import { decideDir, sha256Hex } from './decideLocal.js'
import { gatesSource } from './localGates.js'

export interface LocalDecideLine {
  sopId: string
  /** `.intutic/sops/<file>` or `.intutic/sops/<folder>/<file>`. */
  file: string
  /** 1-based line number in the file. */
  line: number
  sopTitle: string
  ruleText: string
  decl: DecideDecl
  /** `<sopId>#<id>` for a readable rule. */
  ref: string | null
  ruleHash: string | null
}

/** The workspace the decide commands read: the recorded one, else the current directory. */
export function decideWorkspaceRoot(override?: string): string {
  if (override) return node_path.resolve(override)
  return loadConfig()?.workspaceRoot ?? process.cwd()
}

function sopFile(sopId: string): string {
  return `.intutic/sops/${sopId.replace(/^local:/, '').replace(':', '/')}`
}

/** Every local SOP's `decide:` lines, in snapshot order, each parsed with its SOP's other lines. */
export async function loadLocalDecideLines(root: string): Promise<LocalDecideLine[]> {
  const entries = await loadLocalSopEntries(root, [], { ignoreSelection: true })
  const served = await localDecideRules(entries, { decideDir: decideDir() })
  const out: LocalDecideLine[] = []
  for (const entry of entries) {
    const { front } = splitFrontMatter(entry.content)
    const numbered = front
      .split('\n')
      .map((l, k) => ({ text: l.trim(), line: k + 1 }))
      .filter((l) => l.text.startsWith('decide:'))
    if (numbered.length === 0) continue
    const mine = served.filter((s) => s.sopId === entry.sopId)
    const decls = parseDecideLines(numbered.map((l) => l.text.slice('decide:'.length)))
    decls.forEach((decl, i) => {
      const s = mine[i]
      out.push({
        sopId: entry.sopId,
        file: sopFile(entry.sopId),
        line: numbered[i]!.line,
        sopTitle: s?.sopTitle ?? entry.title,
        ruleText: s?.ruleText ?? '',
        decl,
        ref: decl.kind === 'rule' ? decideRuleRef(entry.sopId, decl.rule.id) : null,
        ruleHash: decl.kind === 'rule' ? decideRuleHash(decl.rule, sha256Hex) : null,
      })
    })
  }
  return out
}

/**
 * The rule `spec` names: its ref (`local:data.md#prod-data-export`), its id
 * when only one local rule has it, or `<file>#<id>` / `<file>` for a SOP
 * file with one rule. Throws a message for the user otherwise.
 */
export function findDecideRule(lines: readonly LocalDecideLine[], spec: string): LocalDecideLine & { decl: Extract<DecideDecl, { kind: 'rule' }> } {
  const readable = lines.filter((l): l is LocalDecideLine & { decl: Extract<DecideDecl, { kind: 'rule' }> } => l.decl.kind === 'rule')
  let hits = readable.filter((l) => l.ref === spec)
  if (hits.length === 0) hits = readable.filter((l) => l.decl.rule.id === spec)
  if (hits.length === 0) {
    const [file, id] = spec.split('#')
    const base = node_path.basename(file!)
    hits = readable.filter((l) => (l.file === file || l.file.endsWith(`/${file}`) || node_path.basename(l.file) === base) && (id === undefined || l.decl.rule.id === id))
  }
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0) {
    const broken = lines.find((l) => l.decl.kind === 'unreadable' && (l.decl.id === spec || spec.endsWith(`#${l.decl.id}`)))
    if (broken && broken.decl.kind === 'unreadable') throw new Error(`${broken.file}:${broken.line}: ${broken.decl.error}`)
    throw new Error(`No local decide rule named ${spec}. \`intutic decide lint\` lists them.`)
  }
  throw new Error(`${spec} names ${hits.length} rules: use one of ${hits.map((h) => h.ref).join(', ')}`)
}

/**
 * Writes the policy snapshot again so a changed pin or the disable marker
 * applies now: the local snapshot (`intutic gates install`'s) is rewritten
 * here; a connected machine's sync daemon rewrites its own on its next poll.
 */
export async function rewriteDecideSnapshot(): Promise<'local' | 'connected' | 'none'> {
  if ((await loadCredentials()) !== null) return 'connected'
  if ((await gatesSource()) !== 'local') return 'none'
  const config = loadConfig()
  if (!config) return 'none'
  const disconnected = new Set<string>(config.disconnectedHarnesses ?? [])
  const harnesses = config.harnesses.filter((h) => !disconnected.has(h)) as HarnessType[]
  const root = config.workspaceRoot
  const holdTokens = await localHoldTokensFor(root, [], undefined, harnesses)
  const decideRules = await localDecideRules(await loadLocalSopEntries(root, harnesses, { ignoreSelection: true }), { decideDir: decideDir() })
  await writeLocalPolicySnapshot({ localHoldTokens: holdTokens, snapshotDir: node_path.join(homedir(), '.intutic', 'hooks'), decideRules })
  return 'local'
}
