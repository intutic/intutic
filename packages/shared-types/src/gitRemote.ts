/**
 * Git remote normalisation, shared by the sync daemon (before it reports a
 * repository) and the control plane (on receipt, so a client that skipped it
 * still cannot store credentials).
 */

/** Schemes git can fetch over the network. `file:` and local paths are not repositories anyone else can name. */
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'])

/**
 * A remote URL reduced to `host/path`: lower-cased host, no scheme, no user or
 * password, no port, no query or fragment, no `.git` suffix. The ssh and https
 * spellings of one repository therefore compare equal, and a remote that
 * embeds a token (`https://x-access-token:…@github.com/…`, as CI checkouts
 * write it) never leaves the machine with the token in it.
 *
 * Null for anything that is not a network remote: an empty string, a local
 * path (POSIX or Windows), a `file:` URL, or a host with no repository path.
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

// String scans rather than regexes: a remote URL is input the developer
// controls, and `[?#].*$` / `\/+$` backtrack quadratically on long runs.
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
