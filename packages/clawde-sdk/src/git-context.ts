/**
 * The repository, branch and HEAD commit a process runs in: what cost per
 * branch, per commit and per pull request is attributed by.
 *
 * The control plane copies a session's git context onto every trace it
 * records under that session (`POST /api/v1/sessions` takes `repoUrl`,
 * `branchName` and `commitHash`, the same fields the sync daemon reports), so
 * this is what `ClawdeClient` registers its session with. Without it, SDK
 * traffic is filed under "No git context".
 *
 * @module
 */
import { execFile } from 'child_process'

export interface GitContext {
  /** The `origin` remote as `host/path`, never with credentials. */
  repoUrl?: string
  branchName?: string
  commitHash?: string
}

/** Schemes git can fetch over the network. `file:` and local paths are not repositories anyone else can name. */
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'])

/**
 * A remote reduced to `host/path`: lower-cased host, no scheme, user, password,
 * port, query, fragment or `.git` suffix; null for anything that is not a
 * network remote. A copy of `normalizeGitRemote` in `@intutic/shared-types`
 * (this package has no dependencies), held to the same vectors in
 * `packages/shared-types/fixtures/git-remote-vectors.json`. Normalised here,
 * before it leaves the machine: a CI checkout's remote embeds a token.
 */
export function normalizeGitRemote(remote: string): string | null {
  const raw = remote.trim()
  if (!raw || raw.includes('\\') || /^[a-zA-Z]:\//.test(raw)) return null

  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    if (!NETWORK_SCHEMES.has(url.protocol)) return null
    host = url.hostname
    path = url.pathname
  } else {
    // scp-like: [user[:password]@]host:path. A colon after the first slash
    // makes it a local path, which is how git itself tells them apart.
    const scp = /^(?:[^@/]+@)?([^:/\s]+):([^\s]+)$/.exec(raw)
    if (!scp) return null
    host = scp[1]
    path = cutAtQueryOrFragment(scp[2])
  }

  path = trimSlashes(trimSlashes(path).replace(/\.git$/, ''))
  if (!host || !path) return null
  return `${host.toLowerCase()}/${path}`
}

// String scans rather than regexes: a remote is input the developer controls,
// and `[?#].*$` / `\/+$` backtrack quadratically on long runs.
function cutAtQueryOrFragment(s: string): string {
  for (let i = 0; i < s.length; i++) if (s[i] === '?' || s[i] === '#') return s.slice(0, i)
  return s
}

function trimSlashes(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && s[start] === '/') start++
  while (end > start && s[end - 1] === '/') end--
  return s.slice(start, end)
}

function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3_000 }, (err, stdout) => {
      const out = err ? '' : String(stdout).trim()
      resolve(out.length > 0 ? out : undefined)
    })
  })
}

/**
 * The git context of `cwd`, best effort: a directory that is not a
 * repository, or a machine without git, gives an empty object.
 *
 * A detached HEAD names no branch. That is how CI checks out a pull request,
 * so the branch then comes from `GITHUB_HEAD_REF` (GitHub Actions' pull
 * request head branch), else `fallbackBranch` (`resolveContext().gitBranch`).
 * Values the control plane's session route would refuse are left out rather
 * than failing the registration.
 */
export async function resolveGitContext(cwd: string, fallbackBranch?: string): Promise<GitContext> {
  const [remote, head, commit] = await Promise.all([
    git(cwd, 'remote', 'get-url', 'origin'),
    git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(cwd, 'rev-parse', 'HEAD'),
  ])
  const repoUrl = remote ? normalizeGitRemote(remote) : null
  const branchName = (head !== 'HEAD' ? head : undefined) || process.env.GITHUB_HEAD_REF || fallbackBranch
  const context: GitContext = {}
  if (repoUrl && repoUrl.length <= 512) context.repoUrl = repoUrl
  if (branchName && branchName.length <= 256) context.branchName = branchName
  // A SHA-1 object id; a SHA-256 repository's 64-character id does not fit the column.
  if (commit && /^[0-9a-f]{40}$/.test(commit)) context.commitHash = commit
  return context
}
