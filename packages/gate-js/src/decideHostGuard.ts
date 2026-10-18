/**
 * The self-hosted guard on a decide engine's URL.
 *
 * A decide engine sees every tool call a rule asks about, so it must run on
 * hardware the user controls. The guard judges the literal URL, with no DNS
 * lookup: loopback and private addresses pass, a name passes only when it is
 * `localhost`, ends in `.local`, or is listed in
 * `INTUTIC_SELF_HOSTED_DECISION_HOSTS`, and the hosted decision APIs are
 * refused even when listed.
 *
 * The parser is deliberately narrower than WHATWG's: a URL with anything but
 * printable ASCII, a backslash, a percent sign, a query or a fragment is
 * refused rather than normalised, so every HTTP client reaches the host the
 * guard judged.
 *
 * Byte-identical copy in `packages/gate-js/src/`; the Python
 * (`intutic_clawde/gate/decide_engine.py`) and Rust (`proxy/src/decide/guard.rs`)
 * guards run the same `fixtures/decide-engine-vectors.json` host cases.
 *
 * @module
 */

/** Hosted decision APIs, matched on the host or any subdomain of it. */
export const DECIDE_HOSTED_DENYLIST = [
  'typesafe.ai',
  'fastino.ai',
  'api.openai.com',
  'openai.azure.com',
  'services.ai.azure.com',
  'gateway.ai.cloudflare.com',
  'ai-gateway.vercel.sh',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'cloud.databricks.com',
  'azuredatabricks.net',
] as const

/** Decision routes that are refused on any host that is not loopback or private. */
const DECISION_ROUTES = ['/v1/decisions', '/v1/systemone']

export type DecideHostVerdict =
  | { ok: true; host: string; reason: 'loopback' | 'private' | 'listed' }
  | {
      ok: false
      host: string
      reason: 'scheme' | 'bad_url' | 'credentials' | 'denylist' | 'decision_path' | 'not_listed'
    }

export class DecideHostRefusedError extends Error {
  readonly code = 'host_refused' as const
  constructor(readonly verdict: Extract<DecideHostVerdict, { ok: false }>) {
    super(`decide engine host refused (${verdict.reason}): ${verdict.host || '<none>'}`)
    this.name = 'DecideHostRefusedError'
  }
}

function hostMatches(host: string, name: string): boolean {
  return host === name || host.endsWith('.' + name)
}

function normaliseName(name: string): string {
  const lower = name.trim().toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** The eight 16-bit groups of an IPv6 literal, or null. */
function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(text)) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    const items = part.split(':')
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (i === items.length - 1 && item.includes('.')) {
        const v4 = parseIpv4(item)
        if (!v4) return null
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else if (/^[0-9a-f]{1,4}$/.test(item)) {
        out.push(parseInt(item, 16))
      } else {
        return null
      }
    }
    return out
  }
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** Parses INTUTIC_SELF_HOSTED_DECISION_HOSTS: exact names, or `.suffix` for a name and its subdomains. */
function listedNames(listed: string | undefined): string[] {
  return (listed ?? '')
    .split(',')
    .map((e) => normaliseName(e))
    .map((e) => (e.startsWith('.') ? e.slice(1) : e))
    .filter((e) => e !== '')
}

/**
 * Judges a decide engine's base URL. `listed` is the value of
 * `INTUTIC_SELF_HOSTED_DECISION_HOSTS` (a comma list).
 */
export function checkSelfHostedDecisionHost(url: string, listed?: string): DecideHostVerdict {
  const scheme = /^(https?):\/\//i.exec(url)
  if (!scheme) return { ok: false, host: '', reason: 'scheme' }
  const rest = url.slice(scheme[0].length)
  if (/[^\x21-\x7e]|[\\%?#]/.test(rest)) return { ok: false, host: '', reason: 'bad_url' }
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '' : rest.slice(slash)
  if (authority.includes('@')) return { ok: false, host: '', reason: 'credentials' }

  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+))(?::([0-9]{1,5}))?$/.exec(authority)
  if (!m || (m[3] !== undefined && Number(m[3]) > 65535)) return { ok: false, host: '', reason: 'bad_url' }
  const v6 = m[1] !== undefined ? parseIpv6(m[1].toLowerCase()) : null
  if (m[1] !== undefined && !v6) return { ok: false, host: '', reason: 'bad_url' }
  const host = m[1] !== undefined ? m[1].toLowerCase() : normaliseName(m[2])
  if (host === '') return { ok: false, host: '', reason: 'bad_url' }

  if (DECIDE_HOSTED_DENYLIST.some((d) => hostMatches(host, d))) return { ok: false, host, reason: 'denylist' }

  let local: 'loopback' | 'private' | null = null
  if (v6) {
    if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) local = 'loopback'
    else if ((v6[0] & 0xfe00) === 0xfc00) local = 'private'
  } else {
    const v4 = parseIpv4(host)
    if (v4) {
      if (v4[0] === 127) local = 'loopback'
      else if (
        v4[0] === 10 ||
        (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
        (v4[0] === 192 && v4[1] === 168) ||
        (v4[0] === 169 && v4[1] === 254)
      )
        local = 'private'
    } else if (host === 'localhost') local = 'loopback'
    else if (host.endsWith('.local')) local = 'private'
  }
  if (local) return { ok: true, host, reason: local }

  const lowerPath = path.toLowerCase()
  if (DECISION_ROUTES.some((r) => lowerPath.includes(r))) return { ok: false, host, reason: 'decision_path' }
  if (listedNames(listed).some((name) => hostMatches(host, name))) return { ok: true, host, reason: 'listed' }
  return { ok: false, host, reason: 'not_listed' }
}

/** As {@link checkSelfHostedDecisionHost}, throwing {@link DecideHostRefusedError}; returns the host. */
export function assertSelfHostedDecisionHost(url: string, listed?: string): string {
  const verdict = checkSelfHostedDecisionHost(url, listed)
  if (!verdict.ok) throw new DecideHostRefusedError(verdict)
  return verdict.host
}
