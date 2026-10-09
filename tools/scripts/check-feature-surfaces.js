#!/usr/bin/env node
/**
 * Every feature names the surfaces it ships on, and each named surface exists.
 *
 * On 2026-10-09 an audit of the features shipped the day before found the
 * same drift again and again: a refusal the proxy raises that no SDK table
 * knows, a setting the dashboard edits that the CLI cannot, a refusal code the
 * Tool Gate SDK throws that its reference page leaves out, a docs badge naming
 * a different plan than the API enforces. Each surface had its own checks;
 * nothing said which surfaces a feature was supposed to reach.
 *
 * `tools/scripts/feature-surfaces.json` is that list. Each feature gives, for
 * every interface in INTERFACES, one of:
 *
 *   - an array of evidence (the surface exists and must keep existing);
 *   - `{ "none": "<why this interface does not carry the feature>" }`;
 *   - `{ "gap": "<want>", "want": [evidence…], "have": [evidence…] }`:
 *     expected and not built yet. `have` is the part that exists and is
 *     checked like evidence. The gate fails once every `want` resolves, so a
 *     closed gap moves into the evidence list instead of rotting here. A gap
 *     whose `want` is empty names something no file can show yet; it stays
 *     open until someone writes the evidence down.
 *
 * Leaving an interface out of a feature fails: the point is that someone
 * decided. Evidence kinds (strings are shorthand for the interface's kind):
 *
 *   api        "METHOD /path"          a row of the route catalog in
 *                                      apps/docs/reference/api.md
 *   cli        "cmd sub [--flag …]"    a `## \`intutic cmd sub\`` section of
 *                                      reference/cli.md that names each flag,
 *                                      and each flag in tools/cli/src (the
 *                                      CLI's cliReference.test.ts holds the
 *                                      sections to the registered commands)
 *   docs       "guide/x.md#anchor"     the page and the heading exist
 *   clawdeSdk  "CODE"                  a PROXY_REFUSALS entry in both clawde
 *                                      SDKs and a row of reference/clawde-sdk.md
 *   gateSdk    "CODE"                  thrown by both gate SDKs and listed in
 *                                      reference/gate-sdk.md
 *   kitkat     "text"                  said in the canonical Kitkat SKILL.md
 *   mcpTools   "tool_name"             a tool the `intutic` MCP server registers
 *   terraform  "intutic_x"             a resource or data source the provider
 *                                      registers, with a reference page
 *              "workspace_settings.k"  a settings key `intutic_workspace_settings`
 *                                      manages
 *   events     "a.b.c"                 a notification event type: in the
 *                                      NotificationEventType union and in
 *                                      guide/settings.md
 *              "siem:source"           a SIEM source: in guide/siem-export.md and
 *                                      the control plane's source registry
 *   enforcement "surface:CODE"         a refusal code in
 *                                      packages/shared-types/fixtures/refusal-codes.json
 *                                      (proxy, gate, hook or mcp), which the
 *                                      implementations' own tests hold to it
 *   any        { "file", "contains" }  the file exists and contains the text
 *   any        { "ref", "badge": false } the shorthand `ref`, with no plan
 *                                      comparison (a route many features share)
 *   api        { "ref", "auth": "OWNER/ADMIN" } the route's Auth column must
 *                                      say exactly this (role parity)
 *
 * A `plan` on the feature (a docs badge: Open-Core, Cloud, Self-serve+,
 * Biz Org+, Enterprise, Self-host) must match the badge each cited docs
 * heading, cli.md section and route-catalog row shows: the heading's own, else
 * the nearest enclosing heading's, else the page H1's (docs); the section
 * heading's (cli); the row's, else its file section's (api). `badgeGaps` maps
 * an evidence label to the reason for a known mismatch, and fails once the
 * badge matches.
 *
 * Features nobody listed. The manifest checks only the features someone
 * wrote down, so the gate also takes an inventory of the surfaces a new
 * feature cannot ship without one of: route-catalog rows, cli.md commands,
 * docs pages, refusal codes (refusal-codes.json) and event types
 * (notification events and SIEM sources). Each item must be claimed by a
 * feature's evidence, be in `tools/scripts/feature-surfaces-baseline.json`
 * (what existed before this manifest, taken at the commit before the
 * 2026-10-08 features; it only shrinks), or be in the manifest's `unclaimed`
 * map with a reason (infrastructure routes, pages about the docs themselves).
 * So the pull request that adds a feature's first surface also decides its
 * other ten.
 *
 * Files under enterprise-only trees (the dashboard, the control plane) are
 * absent in the open-core checkout. Evidence there is counted as skipped and
 * reported, as is the SIEM source inventory, so a run that checked nothing
 * says so. Surfaces in other repositories (the website) are checked only when
 * INTUTIC_WEBSITE_DIR points at a checkout.
 *
 * Usage: node tools/scripts/check-feature-surfaces.js [repo-root] [--matrix]
 *   --matrix prints the features × interfaces table as Markdown instead.
 * Exit 1 on any failure.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headingAnchors } from './check-dashboard-docs-links.js'

const args = process.argv.slice(2)
const MATRIX = args.includes('--matrix')
const ROOT = resolve(args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))

export const INTERFACES = [
  'api',
  'dashboard',
  'cli',
  'gateSdk',
  'clawdeSdk',
  'mcpTools',
  'kitkat',
  'terraform',
  'docs',
  'website',
  'events',
  'enforcement',
]
/** Trees only the enterprise checkout has. Everything else cited here is mirrored, the Terraform provider included. */
const ENTERPRISE_ONLY = ['apps/dashboard/', 'services/control-plane/', 'packages/db/', 'docs/']
const EXTERNAL = { website: 'INTUTIC_WEBSITE_DIR' }
const PLAN_BADGE = /<Badge[^>]*text="([^"]+)"/
const SIEM_REGISTRY = 'services/control-plane/src/services/siem/eventSourceRegistry.ts'
const TF_PROVIDER = 'packages/terraform-provider-intutic/internal/provider'

const cache = new Map()
const text = (rel, base = ROOT) => {
  const full = join(base, rel)
  if (!cache.has(full)) cache.set(full, existsSync(full) ? readFileSync(full, 'utf8') : null)
  return cache.get(full)
}
const enterpriseOnly = (rel) => ENTERPRISE_ONLY.some((p) => rel.startsWith(p))

function files(dir, keep) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...files(full, keep))
    else if (keep(entry)) out.push(full)
  }
  return out
}
const sourceOf = (dir, ext) =>
  files(join(ROOT, dir), (f) => ext.test(f) && !/\.test\.|_test\.|^test_/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

/** Route-catalog rows: "METHOD /path" -> { badge, auth }, the badge being the row's, else its section's. */
function routeCatalog() {
  const md = text('apps/docs/reference/api.md') ?? ''
  const rows = new Map()
  let section = null
  for (const line of md.split('\n')) {
    if (/^#{2,3} /.test(line)) section = PLAN_BADGE.exec(line)?.[1] ?? null
    const m = /^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|([^|]*)\|(.*)\|$/.exec(line)
    if (m) rows.set(`${m[1]} ${m[2]}`, { badge: PLAN_BADGE.exec(m[4])?.[1] ?? section, auth: m[3].trim() })
  }
  return rows
}

/** cli.md sections: "cmd sub" -> { body, badge }. Placeholders (<id>, [x]) are dropped from the key. */
function cliSections() {
  const md = text('apps/docs/reference/cli.md') ?? ''
  const out = new Map()
  let cur = null
  for (const line of md.split('\n')) {
    const m = /^#{2,3} `intutic ([^`]+)`(.*)$/.exec(line)
    if (m) {
      cur = m[1].replace(/\s*<[^>]+>|\s*\[[^\]]+\]/g, '').trim()
      out.set(cur, { body: '', badge: PLAN_BADGE.exec(m[2])?.[1] ?? null })
      continue
    }
    if (/^## /.test(line)) cur = null
    else if (cur) out.get(cur).body += line + '\n'
  }
  return out
}

/**
 * The plan badge that applies at a docs heading: its own, else the nearest
 * enclosing heading's, else the page H1's. A section inherits its parent's
 * plan, as `cli.md`'s "Config content upload" inherits `intutic connect`'s.
 */
function docsBadge(md, anchor) {
  const stack = [] // badge per heading level, 1-based
  let fenced = false
  let found = null
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = !fenced && /^(#{1,6})\s/.exec(line)
    if (!m) continue
    const level = m[1].length
    stack.length = level
    stack[level - 1] = PLAN_BADGE.exec(line)?.[1] ?? null
    if (level === 1 && !anchor) found = stack[0]
    if (anchor && level > 1 && found === null && headingAnchors(line).has(anchor)) {
      found = [...stack].reverse().find((b) => b) ?? null
    }
  }
  return found
}

/** Every docs page, as a path under apps/docs ("guide/x.md"). */
function docsPages() {
  const docs = join(ROOT, 'apps/docs')
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (['.vitepress', 'node_modules', 'public', 'dist', 'data'].includes(e.name)) return []
      const full = join(dir, e.name)
      if (e.isDirectory()) return walk(full)
      return e.name.endsWith('.md') ? [relative(docs, full).split(sep).join('/')] : []
    })
  return existsSync(docs) ? walk(docs) : []
}

/** refusal-codes.json as "surface:CODE" for every refusal of every surface. */
function refusalCodes() {
  const raw = text('packages/shared-types/fixtures/refusal-codes.json')
  if (raw === null) return []
  return Object.entries(JSON.parse(raw)).flatMap(([surface, v]) =>
    Array.isArray(v?.refusals) ? v.refusals.map((r) => `${surface}:${r.code}`) : [],
  )
}

/** The NotificationEventType union's members. */
function notificationEventTypes() {
  const src = text('packages/shared-types/src/notifications.ts') ?? ''
  const body = /export type NotificationEventType =([\s\S]*?)\n\n/.exec(src)?.[1] ?? ''
  return [...body.matchAll(/^\s*\|\s*'([^']+)'/gm)].map((m) => m[1])
}

/**
 * The control plane's SIEM sources (the `dispatchTable` a destination filters
 * on), or null in a checkout without the control plane.
 */
function siemSources() {
  const src = text(SIEM_REGISTRY)
  if (src === null) return null
  return [...new Set([...src.matchAll(/dispatchTable: '([a-z_]+)'/g)].map((m) => m[1]))]
}

let routes, cli, cliSrc, gateJs, gatePy, clawdeTs, clawdePy, mcpSrc, tfSrc, events, siem, codes
const lazy = {
  routes: () => (routes ??= routeCatalog()),
  cli: () => (cli ??= cliSections()),
  cliSrc: () => (cliSrc ??= sourceOf('tools/cli/src', /\.ts$/)),
  gateJs: () => (gateJs ??= sourceOf('packages/gate-js/src', /\.ts$/)),
  gatePy: () => (gatePy ??= sourceOf('packages/intutic-clawde/intutic_clawde/gate', /\.py$/)),
  clawdeTs: () => (clawdeTs ??= text('packages/clawde-sdk/src/refusals.ts') ?? ''),
  clawdePy: () => (clawdePy ??= text('packages/intutic-clawde/intutic_clawde/refusals.py') ?? ''),
  mcpSrc: () => (mcpSrc ??= sourceOf('packages/mcp-proxy/src', /\.ts$/)),
  tfSrc: () => (tfSrc ??= sourceOf(TF_PROVIDER, /\.go$/)),
  events: () => (events ??= new Set(notificationEventTypes())),
  siem: () => (siem ??= siemSources()),
  codes: () => (codes ??= new Set(refusalCodes())),
}

/**
 * Check one piece of evidence. Returns { ok, why, skipped, badge } where
 * `badge` is the plan badge the surface shows, when it shows one.
 */
export function resolveEvidence(iface, ev) {
  if (typeof ev === 'object' && ev.ref) {
    const r = resolveEvidence(iface, ev.ref)
    if (r.ok && ev.auth !== undefined && r.auth !== ev.auth)
      return { ok: false, why: `the route catalog gives ${ev.ref} the role "${r.auth}", not "${ev.auth}"` }
    return r
  }
  if (typeof ev === 'object') {
    const base = EXTERNAL[iface] ? process.env[EXTERNAL[iface]] : ROOT
    const t = text(ev.file, base)
    if (t === null) {
      if (base === ROOT && enterpriseOnly(ev.file)) return { skipped: true }
      return { ok: false, why: `${ev.file} does not exist` }
    }
    if (ev.contains && !t.includes(ev.contains))
      return { ok: false, why: `${ev.file} does not contain "${ev.contains}"` }
    return { ok: true }
  }
  switch (iface) {
    case 'api': {
      if (!text('apps/docs/reference/api.md')) return { ok: false, why: 'apps/docs/reference/api.md is missing' }
      const row = lazy.routes().get(ev)
      return row ? { ok: true, ...row } : { ok: false, why: `route catalog has no ${ev}` }
    }
    case 'cli': {
      const [path, ...flags] = ev.split(/\s+(?=--)/).flatMap((p, i) => (i === 0 ? [p] : p.split(/\s+/)))
      // A section is a registered command: tools/cli/src/cliReference.test.ts
      // holds cli.md's sections to the command tree cli.ts builds, both ways.
      const sec = lazy.cli().get(path)
      if (!sec) return { ok: false, why: `reference/cli.md has no section for \`intutic ${path}\`` }
      for (const f of flags) {
        if (!sec.body.includes(f))
          return { ok: false, why: `cli.md's \`intutic ${path}\` section does not document ${f}` }
        if (!lazy.cliSrc().includes(`'${f}`) && !lazy.cliSrc().includes(`"${f}`))
          return { ok: false, why: `tools/cli/src defines no ${f} option` }
      }
      return { ok: true, badge: sec.badge }
    }
    case 'docs': {
      const [page, anchor] = ev.split('#')
      const md = text(`apps/docs/${page}`)
      if (md === null) return { ok: false, why: `apps/docs/${page} does not exist` }
      if (anchor && !headingAnchors(md).has(anchor))
        return { ok: false, why: `apps/docs/${page} has no heading #${anchor}` }
      return { ok: true, badge: docsBadge(md, anchor) }
    }
    case 'clawdeSdk': {
      const key = new RegExp(`['"]?${ev}['"]?\\s*:`)
      if (!key.test(lazy.clawdeTs())) return { ok: false, why: `PROXY_REFUSALS in packages/clawde-sdk has no ${ev}` }
      if (!key.test(lazy.clawdePy()))
        return { ok: false, why: `PROXY_REFUSALS in packages/intutic-clawde has no ${ev}` }
      if (!(text('apps/docs/reference/clawde-sdk.md') ?? '').includes(`\`${ev}\``))
        return { ok: false, why: `reference/clawde-sdk.md does not list ${ev}` }
      return { ok: true }
    }
    case 'gateSdk': {
      const q = new RegExp(`['"]${ev}['"]`)
      if (!q.test(lazy.gateJs())) return { ok: false, why: `packages/gate-js never uses refusal code ${ev}` }
      if (!q.test(lazy.gatePy())) return { ok: false, why: `intutic_clawde.gate never uses refusal code ${ev}` }
      if (!(text('apps/docs/reference/gate-sdk.md') ?? '').includes(`\`${ev}\``))
        return { ok: false, why: `reference/gate-sdk.md does not list ${ev}` }
      return { ok: true }
    }
    case 'kitkat': {
      const skill = text('.agents/skills/intutic-governance-kitkat/SKILL.md')
      if (skill === null) return { ok: false, why: 'the Kitkat SKILL.md is missing' }
      return skill.includes(ev) ? { ok: true } : { ok: false, why: `the Kitkat skill never mentions "${ev}"` }
    }
    case 'mcpTools':
      return new RegExp(`\\.tool\\(\\s*['"]${ev}['"]`).test(lazy.mcpSrc())
        ? { ok: true }
        : { ok: false, why: `packages/mcp-proxy registers no tool named ${ev}` }
    case 'terraform': {
      const setting = /^workspace_settings\.(.+)$/.exec(ev)
      if (setting) {
        const keys = text(`${TF_PROVIDER}/workspace_settings_keys.json`)
        if (keys === null) return { ok: false, why: `${TF_PROVIDER}/workspace_settings_keys.json is missing` }
        return JSON.parse(keys).keys?.includes(setting[1])
          ? { ok: true }
          : { ok: false, why: `intutic_workspace_settings does not manage ${setting[1]}` }
      }
      const name = /^intutic_([a-z_]+)$/.exec(ev)?.[1]
      if (!name) return { ok: false, why: `terraform evidence "${ev}" is neither intutic_<type> nor workspace_settings.<key>` }
      if (!lazy.tfSrc().includes(`req.ProviderTypeName + "_${name}"`))
        return { ok: false, why: `the Terraform provider registers no ${ev}` }
      const page = ['resources', 'data-sources'].some((d) => text(`apps/docs/reference/terraform/${d}/${name}.md`) !== null)
      return page ? { ok: true } : { ok: false, why: `apps/docs/reference/terraform has no page for ${ev}` }
    }
    case 'events': {
      const source = /^siem:(.+)$/.exec(ev)?.[1]
      if (source) {
        if (!(text('apps/docs/guide/siem-export.md') ?? '').includes(`\`${source}\``))
          return { ok: false, why: `guide/siem-export.md does not list the SIEM source ${source}` }
        const registry = lazy.siem()
        if (registry === null) return { skipped: true }
        return registry.includes(source)
          ? { ok: true }
          : { ok: false, why: `the SIEM source registry has no ${source}` }
      }
      if (!lazy.events().has(ev)) return { ok: false, why: `NotificationEventType has no ${ev}` }
      return (text('apps/docs/guide/settings.md') ?? '').includes(`\`${ev}\``)
        ? { ok: true }
        : { ok: false, why: `guide/settings.md does not list the event ${ev}` }
    }
    case 'enforcement':
      return lazy.codes().has(ev)
        ? { ok: true }
        : { ok: false, why: `refusal-codes.json has no ${ev} (write it as surface:CODE)` }
    default:
      return { ok: false, why: `${iface} evidence must be a { file, contains } object` }
  }
}

/** Evidence as a label for messages and badgeGaps keys. */
const labelOf = (ev) =>
  typeof ev === 'string' ? ev : (ev.ref ?? `${ev.file}${ev.contains ? ` ∋ "${ev.contains}"` : ''}`)

/**
 * The surfaces a new feature cannot ship without, as they exist now, and
 * `unseen(kind, item)`: whether this checkout cannot see an item of that kind
 * at all (the SIEM sources, without the control plane), so a baseline or
 * `unclaimed` entry for it is skipped rather than reported as gone.
 */
export function inventory() {
  const siemSrc = lazy.siem()
  return {
    items: {
      routes: [...lazy.routes().keys()],
      cli: [...lazy.cli().keys()],
      docsPages: docsPages(),
      refusalCodes: [...lazy.codes()],
      eventTypes: [...lazy.events(), ...(siemSrc ?? []).map((s) => `siem:${s}`)],
    },
    unseen: (kind, item) => siemSrc === null && kind === 'eventTypes' && item.startsWith('siem:'),
  }
}

/** What an evidence entry claims in the inventory, as [kind, item] pairs. */
function claimsOf(iface, ev) {
  const ref = typeof ev === 'string' ? ev : ev.ref
  if (typeof ref !== 'string') return []
  switch (iface) {
    case 'api':
      return [['routes', ref]]
    case 'cli':
      return [['cli', ref.split(/\s+--/)[0].trim()]]
    case 'docs':
      return [['docsPages', ref.split('#')[0]]]
    case 'clawdeSdk':
      return [['refusalCodes', `proxy:${ref}`]]
    case 'gateSdk':
      return [['refusalCodes', `gate:${ref}`]]
    case 'enforcement':
      return [['refusalCodes', ref]]
    case 'events':
      return [['eventTypes', ref]]
    case 'terraform': {
      // A resource or data source claims its generated reference page.
      const name = /^intutic_([a-z_]+)$/.exec(ref)?.[1]
      return name ? ['resources', 'data-sources'].map((d) => ['docsPages', `reference/terraform/${d}/${name}.md`]) : []
    }
    default:
      return []
  }
}

/** Inventory items no feature claims, no baseline lists and no `unclaimed` entry excuses; and stale entries. */
export function checkClaims(manifest, baseline, { items: found, unseen }) {
  const problems = []
  let skipped = 0
  let checked = 0
  const claimed = Object.fromEntries(Object.keys(found).map((k) => [k, new Map()]))
  for (const f of manifest.features) {
    for (const iface of INTERFACES) {
      const entry = f.surfaces?.[iface]
      if (entry === undefined || (!Array.isArray(entry) && 'none' in entry)) continue
      for (const ev of Array.isArray(entry) ? entry : (entry.have ?? []))
        for (const [kind, item] of claimsOf(iface, ev)) claimed[kind]?.set(item, f.id)
    }
  }
  const unclaimed = manifest.unclaimed ?? {}
  for (const [kind, items] of Object.entries(found)) {
    const present = new Set(items)
    const base = new Set(baseline[kind] ?? [])
    const excused = unclaimed[kind] ?? {}
    for (const item of items) {
      checked += 1
      if (claimed[kind].has(item) || base.has(item) || item in excused) continue
      problems.push(
        `${kind}: ${item} is new and no feature claims it — cite it as a feature's evidence, or add it to "unclaimed" with a reason`,
      )
    }
    for (const item of base) {
      if (unseen(kind, item)) skipped += 1
      else if (!present.has(item)) problems.push(`baseline ${kind}: ${item} no longer exists — remove it from the baseline`)
      else if (claimed[kind].has(item))
        problems.push(`baseline ${kind}: ${item} is claimed by "${claimed[kind].get(item)}" — remove it from the baseline`)
    }
    for (const [item, why] of Object.entries(excused)) {
      if (typeof why !== 'string' || !why.trim()) problems.push(`unclaimed ${kind}: ${item} has no reason`)
      if (unseen(kind, item)) skipped += 1
      else if (!present.has(item)) problems.push(`unclaimed ${kind}: ${item} no longer exists — remove it`)
      else if (claimed[kind].has(item) || base.has(item))
        problems.push(`unclaimed ${kind}: ${item} is claimed or in the baseline — remove it from "unclaimed"`)
    }
  }
  for (const kind of Object.keys(unclaimed))
    if (!(kind in found)) problems.push(`unclaimed: unknown kind "${kind}" (one of ${Object.keys(found).join(', ')})`)
  return { problems, checked, skipped }
}

export function check(manifest) {
  const problems = []
  let checked = 0
  let skipped = 0
  const ids = new Set()
  for (const f of manifest.features) {
    const where = `feature "${f.id}"`
    if (ids.has(f.id)) problems.push(`${where}: duplicate id`)
    ids.add(f.id)
    const badgeGaps = f.badgeGaps ?? {}
    for (const iface of INTERFACES) {
      const entry = f.surfaces?.[iface]
      if (entry === undefined) {
        problems.push(`${where}: says nothing about ${iface} — list evidence, { none: why } or { gap, want }`)
        continue
      }
      if (!Array.isArray(entry) && 'none' in entry) {
        if (typeof entry.none !== 'string' || !entry.none.trim())
          problems.push(`${where}: ${iface} is { none } without a reason`)
        continue
      }
      const isGap = !Array.isArray(entry)
      if (isGap && (typeof entry.gap !== 'string' || !Array.isArray(entry.want))) {
        problems.push(`${where}: ${iface} must be an array, { none }, or { gap, want, have? }`)
        continue
      }
      // What must exist now: the evidence list, or a gap's partial `have`.
      const have = isGap ? (entry.have ?? []) : entry
      const want = isGap ? entry.want : []
      if (iface in EXTERNAL && !process.env[EXTERNAL[iface]]) {
        skipped += have.length + want.length
        continue
      }
      for (const ev of have) {
        const r = resolveEvidence(iface, ev)
        if (r.skipped) {
          skipped += 1
          continue
        }
        checked += 1
        const label = labelOf(ev)
        if (!r.ok) {
          problems.push(`${where}: ${iface} ${label} — ${r.why}`)
          continue
        }
        const comparable = f.plan && r.badge && ev.badge !== false
        const mismatch = comparable && r.badge !== f.plan
        if (mismatch && !badgeGaps[label])
          problems.push(`${where}: ${iface} ${label} carries the "${r.badge}" badge; the feature's plan is "${f.plan}"`)
        if (comparable && !mismatch && badgeGaps[label])
          problems.push(`${where}: badge gap on ${label} is closed — remove it from badgeGaps`)
      }
      const results = want.map((ev) => resolveEvidence(iface, ev))
      for (const r of results) if (r.skipped) skipped += 1
      if (results.length && results.every((r) => r.ok || r.skipped) && results.some((r) => r.ok))
        problems.push(`${where}: the ${iface} gap is closed — move "want" into the evidence list`)
    }
  }
  return { problems, checked, skipped, features: manifest.features.length }
}

const MARK = (entry) =>
  entry === undefined ? '?' : Array.isArray(entry) ? '✓' : 'none' in entry ? '—' : '✗'

export function matrix(manifest) {
  const head = `| Feature | ${INTERFACES.join(' | ')} |\n|---|${INTERFACES.map(() => ':-:').join('|')}|`
  const rows = manifest.features.map(
    (f) => `| ${f.title} | ${INTERFACES.map((i) => MARK(f.surfaces?.[i])).join(' | ')} |`,
  )
  const gaps = manifest.features.flatMap((f) =>
    INTERFACES.filter((i) => f.surfaces?.[i]?.gap).map((i) => `- ${f.title} — ${i}: ${f.surfaces[i].gap}`),
  )
  return [head, ...rows, '', `Gaps (${gaps.length}):`, ...gaps].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (name) => {
    const path = join(ROOT, 'tools/scripts', name)
    if (!existsSync(path)) {
      console.error(`[FAIL] ${path} is missing.`)
      process.exit(1)
    }
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  const manifest = read('feature-surfaces.json')
  if (MATRIX) {
    console.log(matrix(manifest))
    process.exit(0)
  }
  const surfaces = check(manifest)
  const claims = checkClaims(manifest, read('feature-surfaces-baseline.json'), inventory())
  const problems = [...surfaces.problems, ...claims.problems]
  if (problems.length) {
    console.error(`[FAIL] ${problems.length} feature-surface problem(s):`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  if (surfaces.checked === 0 || claims.checked === 0) {
    console.error('[FAIL] no feature surface or inventory item was checked — this run asserted nothing.')
    process.exit(1)
  }
  const skipped = surfaces.skipped + claims.skipped
  console.log(
    `[PASS] ${surfaces.features} feature(s): ${surfaces.checked} surface(s) exist as listed; ` +
      `${claims.checked} route(s), command(s), page(s), refusal code(s) and event type(s) each claimed, baselined or excused` +
      (skipped ? `; ${skipped} skipped (enterprise-only files, or the website with no checkout given)` : ''),
  )
}
