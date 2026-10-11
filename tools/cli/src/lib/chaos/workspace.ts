/**
 * Carrying the project's gates into a repetition's workspace.
 *
 * A repetition runs in a fresh worktree of HEAD, mounted in the sandbox at
 * `/work`. What `intutic connect` generated for the project is usually not in
 * it, and what is in it points at the host:
 *
 * - the gate scripts under `.intutic/hooks/` are normally untracked, so the
 *   worktree has none;
 * - the harness hook settings name the gate by its absolute host path
 *   (`node /Users/me/proj/.intutic/hooks/claude-code-check.js`), and the gate
 *   scripts name their event logs the same way; neither path exists in the
 *   sandbox;
 * - the policy snapshot the gates enforce, and the approved-bypass list they
 *   consult, live in the host's `~/.intutic/hooks/`, while the sandbox has an
 *   empty home of its own.
 *
 * {@link prepareWorkspace} copies the generated gates and any untracked hook
 * settings from the host project into the worktree (never over a file the
 * commit already has), rewrites the host project root to `/work` in the
 * worktree's copies, copies the snapshot and the bypass list next to the
 * runner's events, and returns the environment that points the gates at
 * them. It writes only inside the worktree; the project is read, never
 * changed.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Where the worktree is mounted in the sandbox. */
export const SANDBOX_ROOT = '/work'

/** The generated gate scripts, relative to the project root. */
export const GATE_DIR = '.intutic/hooks'

/** Where a gate writes its decision and review logs, relative to the project root. */
export const GATE_EVENTS_DIR = '.intutic/events'

/**
 * Project-level hook settings that register a gate by path: Claude Code's
 * shared and local settings, Codex's and Cursor's project hooks. User-level
 * settings (`~/.claude/settings.json` and the like) are not carried: the
 * sandbox home is empty.
 */
export const HARNESS_SETTINGS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/hooks.json',
  '.cursor/hooks.json',
] as const

export interface PrepareOptions {
  /** The project the run started in (the host side of the worktree). */
  hostRoot: string
  /** The repetition's worktree. */
  workspace: string
  /** Directory, relative to the worktree, that receives the snapshot and bypass list. */
  policyDir: string
  /** The host's policy snapshot (`.rules`), when the gates there have one. */
  snapshotRules?: string
  /** The host's approved-bypass list, when it has one. */
  approvedBypasses?: string
}

export interface PreparedWorkspace {
  /** Files copied from the host project, relative to the root. */
  copied: string[]
  /** Files in the worktree whose host paths were rewritten to {@link SANDBOX_ROOT}. */
  rewritten: string[]
  /** Harness settings files present in the worktree after copying. */
  settings: string[]
  /** Gate files in the worktree's {@link GATE_DIR}. */
  gates: number
  /** The snapshot copied in, as the host path it came from. */
  snapshot?: string
  /** Environment for the sandbox: where the gates find the snapshot and the bypass list. */
  env: Record<string, string>
  warnings: string[]
}

const SNAPSHOT_BASENAME = 'policy-snapshot.rules'
const BYPASSES_BASENAME = 'approved-bypasses.jsonl'

/** Prepare one repetition's worktree so a harness inside the sandbox finds its gates. */
export async function prepareWorkspace(opts: PrepareOptions): Promise<PreparedWorkspace> {
  const { hostRoot, workspace } = opts
  const out: PreparedWorkspace = { copied: [], rewritten: [], settings: [], gates: 0, env: {}, warnings: [] }

  // 1. The generated gates, where the commit does not carry them.
  for (const rel of await filesUnder(hostRoot, GATE_DIR)) {
    if (await copyIfAbsent(path.join(hostRoot, rel), path.join(workspace, rel))) out.copied.push(rel)
  }
  // 2. Hook settings the commit does not carry (settings.local.json is
  //    normally ignored).
  for (const rel of HARNESS_SETTINGS) {
    if (await copyIfAbsent(path.join(hostRoot, rel), path.join(workspace, rel))) out.copied.push(rel)
    if (await isFile(path.join(workspace, rel))) out.settings.push(rel)
  }

  // 3. Host paths to sandbox paths, in the worktree's copies only.
  const gateFiles = await filesUnder(workspace, GATE_DIR)
  out.gates = gateFiles.length
  const targets = [...out.settings, ...gateFiles]
  const pattern = hostRootPattern(await hostRoots(hostRoot, targets.map((rel) => path.join(workspace, rel))))
  for (const rel of targets) {
    if (await rewriteFile(path.join(workspace, rel), pattern)) out.rewritten.push(rel)
  }

  // 4. Where the gates write. The sandbox user is not the host user, so the
  //    directory must be writable by anyone; made here so the runner (and
  //    not that user) owns it and can remove it afterwards.
  if (out.gates > 0) {
    const events = path.join(workspace, GATE_EVENTS_DIR)
    await fs.mkdir(events, { recursive: true })
    await fs.chmod(events, 0o777)
  }

  // 5. What the gates read from the host's home.
  const policyDir = path.join(workspace, opts.policyDir)
  const sandboxPolicyDir = `${SANDBOX_ROOT}/${opts.policyDir.split(path.sep).join('/')}`
  if (opts.snapshotRules && (await isFile(opts.snapshotRules))) {
    await fs.mkdir(policyDir, { recursive: true })
    await fs.copyFile(opts.snapshotRules, path.join(policyDir, SNAPSHOT_BASENAME))
    out.snapshot = opts.snapshotRules
    out.env.INTUTIC_SNAPSHOT_RULES = `${sandboxPolicyDir}/${SNAPSHOT_BASENAME}`
  }
  if (opts.approvedBypasses && (await isFile(opts.approvedBypasses))) {
    await fs.mkdir(policyDir, { recursive: true })
    await fs.copyFile(opts.approvedBypasses, path.join(policyDir, BYPASSES_BASENAME))
    out.env.INTUTIC_APPROVED_BYPASSES = `${sandboxPolicyDir}/${BYPASSES_BASENAME}`
  }

  if (out.gates === 0) {
    out.warnings.push(
      `no generated gates in ${path.join(hostRoot, GATE_DIR)} (has \`intutic connect\` run in this project?): ` +
        'a harness in the sandbox runs ungoverned, so the gate faults and the destructive-command tier cannot fire',
    )
  } else if (!out.snapshot) {
    out.warnings.push(
      `no policy snapshot at ${opts.snapshotRules ?? '~/.intutic/hooks/' + SNAPSHOT_BASENAME}: the gates in the sandbox ` +
        'enforce their built-in protections only, without the destructive-command tier or your rules',
    )
  }
  return out
}

/**
 * Every spelling of the project root the files use: as given, as resolved,
 * and any other absolute path in front of `/.intutic/` in `files` that
 * resolves to the same directory. A project reached through a symlink (or
 * macOS's /var, which is /private/var) was connected under one spelling and
 * may be run from another.
 */
async function hostRoots(hostRoot: string, files: readonly string[]): Promise<string[]> {
  const real = await realpathOr(hostRoot)
  const roots = new Set([path.resolve(hostRoot), real])
  const candidates = new Set<string>()
  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf-8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/(\/[^\s"'`:;,()[\]{}]*?)\/\.intutic\//g)) candidates.add(m[1]!)
  }
  for (const c of candidates) if (!roots.has(c) && (await realpathOr(c)) === real) roots.add(c)
  return [...roots].map((r) => r.replace(/[/\\]+$/, '')).filter(Boolean)
}

async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** Any of the roots, as a whole path component: `/a/proj` and `/a/proj/x`, never `/a/project`. */
function hostRootPattern(roots: string[]): RegExp {
  const alternatives = roots
    .sort((a, b) => b.length - a.length)
    .map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?:${alternatives.join('|')})(?![^/\\\\"'\\s:;,)\\]}])`, 'g')
}

/** Replace the host root in a text file; true when it changed. Binary files are left alone. */
async function rewriteFile(file: string, pattern: RegExp): Promise<boolean> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return false
  }
  if (text.includes('\0')) return false
  const next = text.replace(pattern, SANDBOX_ROOT)
  if (next === text) return false
  const { mode } = await fs.stat(file)
  await fs.writeFile(file, next)
  await fs.chmod(file, mode & 0o7777)
  return true
}

/** Copy `from` to `to` unless `to` exists or `from` does not; true when copied. */
async function copyIfAbsent(from: string, to: string): Promise<boolean> {
  if (!(await isFile(from)) || (await exists(to))) return false
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return true
}

/** Regular files under `root/dir`, relative to `root`, with `/` separators. */
async function filesUnder(root: string, dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) await walk(child)
      else if (e.isFile()) out.push(child)
    }
  }
  await walk(dir)
  return out.sort()
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}
