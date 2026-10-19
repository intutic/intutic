/**
 * Scope and plan semantics, ported from the proxy so every surface answers
 * "is this change inside the scope?" and "is this run on its plan?" the same
 * way.
 *
 * | Function | Port of |
 * |---|---|
 * | {@link isWithinScope} | `is_within_scope`, `plugins/anomaly/detectors.rs` |
 * | {@link collectScopePaths} | `collect_scope_paths`, `sops.rs`, the org ceiling included |
 * | {@link planOffSteps} | `PlanAdherenceDetector`, `detectors.rs`, with {@link PLAN_DEVIATION_TOLERANCE} |
 * | {@link changeTargets} | `manifest_from_invocations`, `manifest.rs`: the mutation entries of one call |
 * | {@link diffChangedPaths} | (new) the paths a unified or git diff changes |
 *
 * Beside them, what only the gates need: {@link scopeRelativePath} makes a
 * gate's target relative to its workspace root (a path outside the root is
 * out of scope), {@link isPlanExemptTool} names the calls `plan_approval:`
 * never refuses, and {@link isFileWriteCall} says whether a call changed files,
 * which makes an earlier passing test run stale (Q1).
 *
 * Self-contained but for `./phrases.ts`, so `@intutic/gate` keeps a
 * byte-identical copy and the JavaScript hook gates embed
 * {@link SCOPE_MATCH_JS_SOURCE} beside the phrase matcher's source. The
 * Python port is `intutic_clawde/gate/scope_match.py`; the proxy's Rust runs
 * the same `fixtures/scope-plan-vectors.json`. `manifestParity.test.ts`
 * holds the tool and key lists to `manifest.rs` and `actions.rs`.
 *
 * @module
 */

import { hasPhrase, phraseText } from './phrases.js'

/** The share of off-plan steps a plan forgives under `plan_steps_mode: advise` (`PLAN_DEVIATION_TOLERANCE` in detectors.rs). */
export const PLAN_DEVIATION_TOLERANCE = 0.4

/** What an org ceiling disjoint from the workspace list leaves (`NARROWED_TO_NOTHING`, sops.rs): no path is inside it. */
export const NARROWED_TO_NOTHING = '<none: workspace list disjoint from org ceiling>'

/** `WRITE_TOOLS`, manifest.rs. */
export const SCOPE_WRITE_TOOLS: readonly string[] = ['write', 'write_file', 'writefile', 'create_file', 'createfile']
/** `EDIT_TOOLS`, manifest.rs. */
export const SCOPE_EDIT_TOOLS: readonly string[] = ['edit', 'edit_file', 'editfile', 'multiedit', 'apply_patch', 'str_replace', 'notebookedit']
/** `DELETE_TOOLS`, manifest.rs. */
export const SCOPE_DELETE_TOOLS: readonly string[] = ['delete_file', 'deletefile', 'remove_file', 'rm_file']
/** `MOVE_TOOLS`, manifest.rs. */
export const SCOPE_MOVE_TOOLS: readonly string[] = ['move_file', 'movefile', 'rename_file', 'rename']
/** `EDITOR_TOOLS`, actions.rs: the text editor, whose `command` decides whether it writes. */
export const SCOPE_EDITOR_TOOLS: readonly string[] = ['str_replace_editor', 'text_editor', 'texteditor', 'str_replace_based_edit_tool']
/** `PATH_KEYS`, manifest.rs. */
export const SCOPE_PATH_KEYS: readonly string[] = ['file_path', 'filepath', 'path', 'filename', 'target_file', 'notebook_path']
/** `COMMAND_KEYS`, manifest.rs. */
export const SCOPE_COMMAND_KEYS: readonly string[] = ['command', 'cmd', 'script']
/** `SHELL_TOOLS`, actions.rs. */
export const SCOPE_SHELL_TOOLS: readonly string[] = ['bash', 'shell', 'run_command', 'runcommand', 'execute_command', 'run_shell_command', 'terminal', 'execute', 'exec']
/** `READ_TOOLS`, actions.rs. */
export const SCOPE_READ_TOOLS: readonly string[] = ['read', 'readfile', 'view', 'cat', 'open_file']
/** A move's source and destination keys, manifest.rs. */
export const SCOPE_MOVE_FROM_KEYS: readonly string[] = ['source', 'source_path', 'from', 'old_path']
export const SCOPE_MOVE_TO_KEYS: readonly string[] = ['destination', 'destination_path', 'to', 'new_path']
/** A target is cut to this many bytes, and marked with `…` when it was (`TARGET_MAX`, manifest.rs). */
export const SCOPE_TARGET_MAX_BYTES = 512

/**
 * Tools `plan_approval:` never refuses: the read tools and the search and
 * listing tools an agent needs to write a plan in the first place.
 */
export const PLAN_EXEMPT_TOOLS: readonly string[] = ['read', 'readfile', 'view', 'cat', 'open_file', 'glob', 'grep', 'ls', 'list_dir', 'search', 'todowrite']

/**
 * Shell phrases that change files in the working tree. With the mutation
 * tools ({@link changeTargets}), a call matching one makes an earlier passing
 * test run stale ({@link isFileWriteCall}).
 */
export const FILE_WRITE_SHELL_PHRASES: readonly string[] = [
  'sed -i',
  'perl -i',
  'perl -pi',
  'git apply',
  'git am',
  'git checkout',
  'git switch',
  'git restore',
  'git reset',
  'git merge',
  'git pull',
  'git rebase',
  'git cherry-pick',
  'git revert',
  'git stash pop',
  'git stash apply',
  'patch -p',
]

/** A mutation one call makes: what it does and the path it names. */
export interface ChangeTarget {
  op: 'write' | 'edit' | 'delete' | 'move'
  target: string
}

/** ASCII lower case, as Rust's `to_ascii_lowercase`. */
function scopeAsciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase())
}

/** `tool_is`, actions.rs: the name, lower-cased, is one of `group` or ends with one. */
function scopeToolIs(name: string, group: readonly string[]): boolean {
  const lower = name.toLowerCase()
  for (const t of group) if (lower === t || lower.slice(-t.length) === t) return true
  return false
}

/** The first of `keys` whose value in `input` is a non-empty string. */
function scopeKeyed(input: unknown, keys: readonly string[]): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/** `clip`, manifest.rs: the first {@link SCOPE_TARGET_MAX_BYTES} bytes, and `…` when cut. */
function scopeClip(s: string): string {
  let bytes = 0
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    let n = 3
    let w = 1
    if (c < 0x80) n = 1
    else if (c < 0x800) n = 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const l = s.charCodeAt(i + 1)
      if (l >= 0xdc00 && l <= 0xdfff) {
        n = 4
        w = 2
      }
    }
    if (bytes + n > 512) return s.slice(0, i) + '…'
    bytes += n
    i += w
  }
  return s
}

/**
 * Is `target` inside any of `scopes`? Segment-prefix match: `packages/proxy`
 * covers `packages/proxy/src/main.rs`, not `packages/proxy-extras/x.rs`.
 * Leading `./` and `/` and trailing `/` are dropped, and the comparison
 * ignores ASCII case. An empty scope covers everything.
 */
export function isWithinScope(target: string, scopes: readonly string[]): boolean {
  const norm = (s: string): string => {
    let t = s
    while (t.slice(0, 2) === './') t = t.slice(2)
    let a = 0
    while (a < t.length && t.charAt(a) === '/') a++
    t = t.slice(a)
    let b = t.length
    while (b > 0 && t.charAt(b - 1) === '/') b--
    return scopeAsciiLower(t.slice(0, b))
  }
  const t = norm(target)
  for (const raw of scopes) {
    const s = norm(raw)
    if (s === '' || t === s || t.slice(0, s.length + 1) === s + '/') return true
  }
  return false
}

/** A SOP as {@link collectScopePaths} reads it. `roles` are lower case, as the parser keeps them. */
export interface ScopeSop {
  scope: 'workspace' | 'org'
  roles: readonly string[]
  scopePaths: readonly string[]
}

/** `applies_to`, sops.rs: an unscoped SOP applies to everyone; a scoped one only to its roles, and never to a caller with no role. */
export function sopAppliesToRole(roles: readonly string[], role: string): boolean {
  if (roles.length === 0) return true
  if (role === '') return false
  return roles.indexOf(scopeAsciiLower(role)) !== -1
}

/**
 * The path scope in force for `role` (`collect_scope_paths`): the workspace
 * SOPs' scopes, narrowed by the org SOPs' (a workspace scope survives when it
 * is inside an org one; none surviving is {@link NARROWED_TO_NOTHING}; no
 * workspace scope takes the org's), sorted and deduplicated. Empty means
 * unrestricted.
 */
export function collectScopePaths(sops: readonly ScopeSop[], role: string): string[] {
  const workspace: string[] = []
  const org: string[] = []
  for (const s of sops) {
    if (!sopAppliesToRole(s.roles, role)) continue
    for (const p of s.scopePaths) (s.scope === 'org' ? org : workspace).push(p)
  }
  let out: string[]
  if (org.length === 0) out = workspace
  else if (workspace.length === 0) out = org
  else {
    out = workspace.filter((w) => isWithinScope(w, org))
    if (out.length === 0) out = [NARROWED_TO_NOTHING]
  }
  return out.slice().sort().filter((p, i, all) => i === 0 || all[i - 1] !== p)
}

/** A SOP as {@link collectPlanSteps} reads it. */
export interface PlanSop {
  scope: 'workspace' | 'org'
  roles: readonly string[]
  planSteps: readonly string[]
}

/**
 * The plan in force for `role` (`collect_plan_steps`, sops.rs): the
 * workspace SOPs' steps in order, not deduplicated (a plan is a sequence),
 * narrowed by the org SOPs' steps by membership ignoring ASCII case (none
 * surviving is {@link NARROWED_TO_NOTHING}; no workspace plan takes the
 * org's). Empty means no plan.
 */
export function collectPlanSteps(sops: readonly PlanSop[], role: string): string[] {
  const workspace: string[] = []
  const org: string[] = []
  for (const s of sops) {
    if (!sopAppliesToRole(s.roles, role)) continue
    for (const p of s.planSteps) (s.scope === 'org' ? org : workspace).push(p)
  }
  if (org.length === 0) return workspace
  if (workspace.length === 0) return org
  const allowed = org.map(scopeAsciiLower)
  const out = workspace.filter((w) => allowed.indexOf(scopeAsciiLower(w)) !== -1)
  return out.length > 0 ? out : [NARROWED_TO_NOTHING]
}

/**
 * The off-plan steps of `sequence` against `planSteps` (`PlanAdherenceDetector`):
 * empty when there is no plan or no sequence, or when the off-plan share is
 * at most `tolerance`; otherwise the off-plan names, sorted and deduplicated,
 * with the share. Names compare ignoring ASCII case.
 */
export function planOffSteps(sequence: readonly string[], planSteps: readonly string[], tolerance: number): { offPlan: string[]; ratio: number } {
  if (planSteps.length === 0 || sequence.length === 0) return { offPlan: [], ratio: 0 }
  const plan = planSteps.map(scopeAsciiLower)
  const off = sequence.filter((t) => plan.indexOf(scopeAsciiLower(t)) === -1)
  if (off.length === 0) return { offPlan: [], ratio: 0 }
  const ratio = off.length / sequence.length
  if (ratio <= tolerance) return { offPlan: [], ratio }
  return { offPlan: off.slice().sort().filter((p, i, all) => i === 0 || all[i - 1] !== p), ratio: Math.min(1, ratio) }
}

/**
 * The mutations one tool call makes, as the proxy's change manifest records
 * them: a move's source and destination; a text-editor call unless it is a
 * `view`; a write, edit or delete tool's path. Only path targets that are not
 * empty, each clipped as the manifest clips it. A shell command is never a
 * path, so a shell call has none.
 */
export function changeTargets(tool: string, input: unknown): ChangeTarget[] {
  if (scopeToolIs(tool, ['move_file', 'movefile', 'rename_file', 'rename'])) {
    const from = scopeKeyed(input, ['source', 'source_path', 'from', 'old_path'])
    const to = scopeKeyed(input, ['destination', 'destination_path', 'to', 'new_path'])
    if (from !== null || to !== null) {
      const out: ChangeTarget[] = []
      if (from !== null) out.push({ op: 'move', target: scopeClip(from) })
      if (to !== null) out.push({ op: 'move', target: scopeClip(to) })
      return out
    }
  }
  const keys = ['file_path', 'filepath', 'path', 'filename', 'target_file', 'notebook_path']
  let op: ChangeTarget['op'] | null = null
  if (scopeToolIs(tool, ['str_replace_editor', 'text_editor', 'texteditor', 'str_replace_based_edit_tool'])) {
    const o = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
    const command = typeof o.command === 'string' ? scopeAsciiLower(o.command) : ''
    op = command === 'view' ? null : command === 'create' ? 'write' : 'edit'
    if (op === null) return []
  } else if (scopeToolIs(tool, ['write', 'write_file', 'writefile', 'create_file', 'createfile'])) op = 'write'
  else if (scopeToolIs(tool, ['edit', 'edit_file', 'editfile', 'multiedit', 'apply_patch', 'str_replace', 'notebookedit'])) op = 'edit'
  else if (scopeToolIs(tool, ['delete_file', 'deletefile', 'remove_file', 'rm_file'])) op = 'delete'
  if (op === null) return []
  const target = scopeKeyed(input, keys)
  return target === null ? [] : [{ op, target: scopeClip(target) }]
}

/** One path from a diff header, or null: quotes dropped, a `a/` or `b/` prefix dropped, `/dev/null` and empty refused, anything after a tab cut. */
function scopeDiffPath(raw: string, prefix: string): string | null {
  let p = raw
  const tab = p.indexOf('\t')
  if (tab !== -1) p = p.slice(0, tab)
  // Spaces only (not tabs), trimmed by index: a `/[ ]+$/` backtracks
  // quadratically on a long run of spaces that is not at the end.
  let start = 0
  let end = p.length
  while (start < end && p.charCodeAt(start) === 32) start++
  while (end > start && p.charCodeAt(end - 1) === 32) end--
  p = p.slice(start, end)
  if (p.length >= 2 && p.charAt(0) === '"' && p.charAt(p.length - 1) === '"') p = p.slice(1, -1)
  if (p === '/dev/null' || p === '') return null
  if (prefix !== '' && p.slice(0, prefix.length) === prefix) p = p.slice(prefix.length)
  return p === '' ? null : p
}

/**
 * The paths a diff changes, in the order first seen, each once: from
 * `diff --git a/X b/Y` (both, when it splits unambiguously), `--- a/X`,
 * `+++ b/Y`, `rename from X` and `rename to Y`. `/dev/null` is not a path.
 */
export function diffChangedPaths(diff: string): string[] {
  const out: string[] = []
  const add = (p: string | null) => {
    if (p !== null && out.indexOf(p) === -1) out.push(p)
  }
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.slice(0, 11) === 'diff --git ') {
      const rest = line.slice(11)
      if (rest.slice(0, 2) !== 'a/') continue
      const first = rest.indexOf(' b/')
      if (first === -1) continue
      if (rest.indexOf(' b/', first + 1) === -1) {
        add(scopeDiffPath(rest.slice(0, first), 'a/'))
        add(scopeDiffPath(rest.slice(first + 1), 'b/'))
      } else if ((rest.length - 5) % 2 === 0) {
        // `a/P b/P` with ` b/` inside P: the split that names one path twice.
        const n = (rest.length - 5) / 2
        const a = rest.slice(2, 2 + n)
        if (rest.slice(2 + n, 5 + n) === ' b/' && rest.slice(5 + n) === a) add(scopeDiffPath(a, ''))
      }
    } else if (line.slice(0, 4) === '--- ') add(scopeDiffPath(line.slice(4), 'a/'))
    else if (line.slice(0, 4) === '+++ ') add(scopeDiffPath(line.slice(4), 'b/'))
    else if (line.slice(0, 12) === 'rename from ') add(scopeDiffPath(line.slice(12), ''))
    else if (line.slice(0, 10) === 'rename to ') add(scopeDiffPath(line.slice(10), ''))
  }
  return out
}

/** A POSIX path with `.` and `..` resolved and slashes collapsed; `..` never climbs above `/`. */
function scopeNormalisePath(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

/**
 * `target` relative to the workspace `root` (both resolved against `cwd`
 * when relative), or null when it is outside the root, names a home
 * directory (`~`), or either path is not absolute after resolving. A gate
 * checks the result with {@link isWithinScope}; null is out of scope.
 */
export function scopeRelativePath(target: string, cwd: string, root: string): string | null {
  if (target === '' || target.charAt(0) === '~' || cwd.charAt(0) !== '/' || root.charAt(0) !== '/') return null
  const abs = scopeNormalisePath(target.charAt(0) === '/' ? target : cwd + '/' + target)
  const base = scopeNormalisePath(root)
  if (abs === base) return ''
  const head = base === '/' ? '/' : base + '/'
  return abs.slice(0, head.length) === head ? abs.slice(head.length) : null
}

/** Whether `plan_approval:` lets `tool` run before the plan is approved: one of {@link PLAN_EXEMPT_TOOLS}, ignoring case, bare or as an MCP tool (`mcp__<server>__grep`). */
export function isPlanExemptTool(tool: string): boolean {
  const lower = tool.toLowerCase()
  for (const t of ['read', 'readfile', 'view', 'cat', 'open_file', 'glob', 'grep', 'ls', 'list_dir', 'search', 'todowrite']) {
    if (lower === t || lower.slice(-(t.length + 2)) === '__' + t) return true
  }
  return false
}

/**
 * Whether the call changed files: a mutation ({@link changeTargets}) or a
 * shell command with one of {@link FILE_WRITE_SHELL_PHRASES} (`sed -i`,
 * `git checkout`, …). An earlier passing test run is stale after one.
 */
export function isFileWriteCall(tool: string, input: unknown): boolean {
  if (changeTargets(tool, input).length > 0) return true
  if (!scopeToolIs(tool, ['bash', 'shell', 'run_command', 'runcommand', 'execute_command', 'run_shell_command', 'terminal', 'execute', 'exec'])) return false
  const command = scopeKeyed(input, ['command', 'cmd', 'script'])
  if (command === null) return false
  const words = phraseText(command)
  for (const p of ['sed -i', 'perl -i', 'perl -pi', 'git apply', 'git am', 'git checkout', 'git switch', 'git restore', 'git reset', 'git merge', 'git pull', 'git rebase', 'git cherry-pick', 'git revert', 'git stash pop', 'git stash apply', 'patch -p']) {
    if (hasPhrase(words, p)) return true
  }
  return false
}

/**
 * The functions above as JavaScript source, for the hook gates to embed
 * after the phrase matcher's source (`PHRASES_JS_SOURCE`), which
 * {@link isFileWriteCall} calls. The lists the functions read are written
 * into them, so the source needs nothing else; `scopeMatch.test.ts` holds
 * those copies to the exported lists.
 */
export const SCOPE_MATCH_JS_SOURCE = [
  scopeAsciiLower,
  scopeToolIs,
  scopeKeyed,
  scopeClip,
  isWithinScope,
  sopAppliesToRole,
  collectScopePaths,
  collectPlanSteps,
  planOffSteps,
  changeTargets,
  scopeDiffPath,
  diffChangedPaths,
  scopeNormalisePath,
  scopeRelativePath,
  isPlanExemptTool,
  isFileWriteCall,
]
  .map((fn) =>
    fn
      .toString()
      .replace(/\(0,\s*(?:[\w$]+_js_\d+|__vite_ssr_import_\d+__)\.([\w$]+)\)/g, '$1')
      .replace(/\b(?:[\w$]+_js_\d+|__vite_ssr_import_\d+__)\.([\w$]+)/g, '$1')
      .replace(/\bexports\./g, ''),
  )
  .join('\n')
  .replace(/\bNARROWED_TO_NOTHING\b/g, JSON.stringify(NARROWED_TO_NOTHING))
