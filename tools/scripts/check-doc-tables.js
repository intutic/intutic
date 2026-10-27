#!/usr/bin/env node
/**
 * Docs tables and diagrams that restate a code enum must say what the code
 * says. Each was written by hand from the source and drifted from it at least
 * once; this holds the highest-value ones to their source:
 *
 * 1. **Enforcement actions.** Every `| Action | … |` table whose rows are
 *    bold action names (how-it-works, concepts, policies, enforcement-actions)
 *    lists exactly the ladder — `EnforcementAction` in
 *    packages/shared-types/src/enums.ts, less `OBSERVED`, which the docs
 *    explain separately as outside it — in the enum's order; "one of five
 *    verdicts"-style counts match the ladder; and a type union written as
 *    `enforcementAction: 'BYPASS' | …` lists the whole enum.
 * 2. **SOP lifecycle.** Every `| State | … |` table of lifecycle states lists
 *    `SopLifecycleState` in order, "N-state lifecycle" says its size, a
 *    `lifecycleState:` union lists it, and every lifecycle diagram (a plain
 *    code block naming five or more states) draws exactly the transitions in
 *    `VALID_SOP_TRANSITIONS` (packages/shared-types/src/sop.ts): arrows
 *    between states on a line (`A → B`, `A ↔ B`, `A, B ──> C`) and the
 *    box-drawn lines below them, traced from each state to the arrowhead
 *    they end in.
 * 3. **Graph-guardrails detectors.** The detector table in
 *    guide/graph-guardrails.md has one row per detector
 *    `DetectorRegistry::with_defaults()` registers
 *    (packages/proxy/src/plugins/anomaly/mod.rs), each with the categories
 *    the detector's impl reports, and "N of the M runtime anomaly
 *    categories" counts the registered detectors' categories against
 *    `ALL_KINDS`.
 * 4. **clawde SDK "What's covered".** Every method named there with its
 *    Python twin (`listProviderModels` (`list_provider_models`)) is a method
 *    in packages/shared-types/fixtures/control-plane-operations.json with
 *    that twin; every CLI command its "Not covered" paragraph names is not
 *    the command of a covered method; and every command the fixture
 *    excludes is named there.
 * 5. **Tier matrix.** The paid-plan table in guide/tier-matrix.md has one
 *    column per paid plan, named by its `displayName`, in planSkuMap.ts order,
 *    and each row's ticks match the plan flag the row describes. planSkuMap.ts
 *    is not in the open-core checkout: there the columns are checked against
 *    apps/docs/data/plans.json and the ticks are skipped (and said so).
 *
 * Every finding names the file, the line and what differs. Exit 1 on any
 * finding, or when a check finds nothing to check.
 *
 * Usage: node tools/scripts/check-doc-tables.js [repo-root]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const DOCS = join(ROOT, 'apps/docs')
const ENUMS_TS = 'packages/shared-types/src/enums.ts'
const SOP_TS = 'packages/shared-types/src/sop.ts'
const ANOMALY_MOD = 'packages/proxy/src/plugins/anomaly/mod.rs'
const ANOMALY_DETECTORS = 'packages/proxy/src/plugins/anomaly/detectors.rs'
const GRAPH_DETECTORS = 'packages/proxy/src/plugins/anomaly/graph_detectors.rs'
const OPERATIONS = 'packages/shared-types/fixtures/control-plane-operations.json'
const PLAN_SKU_MAP = 'services/control-plane/src/lib/planSkuMap.ts'
const PLANS_JSON = 'apps/docs/data/plans.json'

const findings = []
const passes = []

function read(rel) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) throw new Error(`${rel} is missing`)
  return readFileSync(full, 'utf8')
}

/** The values of `export const NAME = { KEY: 'value', … } as const`. */
function constValues(src, name, file) {
  const body = src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\} as const`))?.[1]
  if (!body) throw new Error(`could not find "export const ${name} = { … } as const" in ${file}`)
  return [...body.matchAll(/^\s*[A-Z][A-Z0-9_]*:\s*'([^']+)'/gm)].map((m) => m[1])
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'public', '.vitepress'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const asNumber = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS.indexOf(s.toLowerCase()))

/** Each markdown page under apps/docs, its text, lines, tables and code blocks. */
function loadPages() {
  return walk(DOCS).map((file) => {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    const tables = []
    const blocks = []
    let fence = null
    let table = null
    lines.forEach((line, i) => {
      const f = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line)
      if (fence) {
        if (f && f[1][0] === fence.char && f[1].length >= fence.length && line.trim() === f[1]) {
          blocks.push(fence.block)
          fence = null
        } else fence.block.lines.push(line)
        return
      }
      if (f) {
        fence = { char: f[1][0], length: f[1].length, block: { line: i + 2, lang: f[2], lines: [] } }
        table = null
        return
      }
      if (/^\s*\|/.test(line)) {
        const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
        if (!table) {
          table = { line: i + 1, header: cells, rows: [] }
          tables.push(table)
        } else if (!cells.every((c) => /^:?-+:?$/.test(c))) table.rows.push({ line: i + 1, cells })
      } else table = null
    })
    return { rel: relative(ROOT, file), text, tables, blocks }
  })
}

const plain = (cell) => cell.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim()
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Checks `names` against `expected`: unknown, missing, then order. */
function compareList(where, what, names, expected, known, source) {
  const problems = []
  for (const n of names) if (!known.includes(n)) problems.push(`lists ${n}, which ${source} does not have`)
  for (const e of expected) if (!names.includes(e)) problems.push(`is missing ${e}`)
  if (problems.length === 0) {
    const inOrder = names.filter((n) => expected.includes(n))
    if (inOrder.join() !== expected.join()) problems.push(`lists them as ${inOrder.join(', ')}; ${source} orders them ${expected.join(', ')}`)
  }
  for (const p of problems) findings.push(`${where}: the ${what} ${p}.`)
  return problems.length === 0
}

function run(name, fn) {
  try {
    fn()
  } catch (err) {
    findings.push(`${name}: ${err.message}`)
  }
}

const pages = existsSync(DOCS) ? loadPages() : []
if (pages.length === 0) {
  console.error(`[FAIL] no docs pages under ${DOCS}.`)
  process.exit(1)
}
const page = (rel) => {
  const p = pages.find((x) => x.rel === `apps/docs/${rel}`)
  if (!p) throw new Error(`apps/docs/${rel} is missing`)
  return p
}

// ── 1. Enforcement actions ───────────────────────────────────────────────
run('enforcement actions', () => {
  const actions = constValues(read(ENUMS_TS), 'EnforcementAction', ENUMS_TS)
  // concepts/enforcement-actions.md: "A sixth value, OBSERVED, sits outside this ladder".
  const OUTSIDE_LADDER = ['OBSERVED']
  for (const o of OUTSIDE_LADDER) {
    if (!actions.includes(o)) throw new Error(`EnforcementAction no longer has ${o}; update OUTSIDE_LADDER and the pages that explain it`)
  }
  const ladder = actions.filter((a) => !OUTSIDE_LADDER.includes(a))
  const REQUIRED = ['concepts/enforcement-actions.md', 'guide/concepts.md', 'guide/how-it-works.md', 'guide/policies.md']
  const checkedPages = new Set()
  let tables = 0
  let counts = 0
  let unions = 0
  for (const p of pages) {
    for (const t of p.tables) {
      if (plain(t.header[0] ?? '').toLowerCase() !== 'action') continue
      const names = t.rows.map((r) => /^\*\*([A-Za-z_]+)\*\*$/.exec(r.cells[0] ?? '')?.[1]?.toUpperCase()).filter(Boolean)
      if (names.length < 3 || !names.some((n) => actions.includes(n))) continue
      tables += 1
      checkedPages.add(p.rel)
      compareList(`${p.rel}:${t.line}`, 'enforcement-action table', names, ladder, actions, `EnforcementAction (${ENUMS_TS}, less ${OUTSIDE_LADDER.join(', ')})`)
    }
    const COUNT_PATTERNS = [
      /\bone of (\w+) (?:enforcement )?(?:verdicts|actions)\b/gi,
      /\b(\w+) enforcement actions\b/gi,
      /\bThe (\w+) verdicts\b/g,
    ]
    for (const pattern of COUNT_PATTERNS) {
      for (const m of p.text.matchAll(pattern)) {
        const n = asNumber(m[1])
        if (n < 0) continue
        counts += 1
        if (n !== ladder.length) {
          findings.push(`${p.rel}:${lineOf(p.text, m.index)}: "${m[0]}" — the ladder has ${ladder.length} actions (${ladder.join(', ')}).`)
        }
      }
    }
    for (const m of p.text.matchAll(/\benforcementAction\??:\s*((?:\|?\s*'[A-Z_]+'\s*)+)/g)) {
      unions += 1
      const names = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])
      compareList(`${p.rel}:${lineOf(p.text, m.index)}`, '`enforcementAction` union', names, actions, actions, `EnforcementAction (${ENUMS_TS})`)
    }
  }
  for (const r of REQUIRED) {
    if (!checkedPages.has(`apps/docs/${r}`)) findings.push(`enforcement actions: found no enforcement-action table on apps/docs/${r}; the check no longer recognises it.`)
  }
  passes.push(`enforcement actions: ${tables} table(s), ${counts} count(s) and ${unions} union(s) checked against the ${ladder.length}-action ladder`)
})

// ── 2. SOP lifecycle ─────────────────────────────────────────────────────
/** Edges drawn in a lifecycle diagram, as "FROM>TO" strings. */
function diagramEdges(lines, states) {
  const edges = new Set()
  const tokenRe = new RegExp(`\\b(${states.join('|')})\\b`, 'g')
  const grid = lines.map((l) => [...l])
  const owner = new Map() // "r,c" -> state
  const tokens = []
  grid.forEach((_, r) => {
    for (const m of lines[r].matchAll(tokenRe)) {
      // Columns count characters, not UTF-16 units.
      const col = [...lines[r].slice(0, m.index)].length
      tokens.push({ r, c: col, len: m[1].length, state: m[1] })
      for (let k = 0; k < m[1].length; k += 1) owner.set(`${r},${col + k}`, m[1])
    }
  })
  // On one line: `A → B`, `A ↔ B`, `A ◀──▶ B`, `A, B, C ──> D`.
  grid.forEach((row, r) => {
    const onRow = tokens.filter((t) => t.r === r).sort((a, b) => a.c - b.c)
    let group = onRow.length ? [onRow[0].state] : []
    for (let i = 1; i < onRow.length; i += 1) {
      const between = row.slice(onRow[i - 1].c + onRow[i - 1].len, onRow[i].c).join('').replace(/[[\]\s]/g, '')
      if (between === ',') {
        group.push(onRow[i].state)
        continue
      }
      const both = between.includes('↔') || (between.includes('◀') && between.includes('▶')) || (between.includes('<') && between.includes('>'))
      const forward = both || /[→▶>]/.test(between)
      const backward = both || /[←◀<]/.test(between)
      const next = [onRow[i].state]
      if (forward || backward) {
        for (const a of group) for (const b of next) {
          if (forward) edges.add(`${a}>${b}`)
          if (backward) edges.add(`${b}>${a}`)
        }
      }
      group = next
    }
  })
  // Boxes: ┌──┐ … └──┘ around a state make its border part of that state.
  grid.forEach((row, r) => {
    row.forEach((ch, c) => {
      if (ch !== '┌') return
      let c2 = c + 1
      while (row[c2] === '─' || row[c2] === '┬' || row[c2] === '┴') c2 += 1
      if (row[c2] !== '┐') return
      let r2 = r + 1
      while (r2 < grid.length && ['│', '├', '┤'].includes(grid[r2][c])) r2 += 1
      if (grid[r2]?.[c] !== '└' || grid[r2]?.[c2] !== '┘') return
      const inside = tokens.find((t) => t.r > r && t.r < r2 && t.c > c && t.c + t.len <= c2)
      if (!inside) return
      for (let x = c; x <= c2; x += 1) owner.set(`${r},${x}`, inside.state).set(`${r2},${x}`, inside.state)
      for (let y = r; y <= r2; y += 1) owner.set(`${y},${c}`, inside.state).set(`${y},${c2}`, inside.state)
    })
  })
  // Lines below and above the states: follow each to the arrowhead it ends in.
  const CONN = { '│': 'UD', '─': 'LR', '┌': 'RD', '┐': 'LD', '└': 'UR', '┘': 'UL', '├': 'UDR', '┤': 'UDL', '┬': 'LRD', '┴': 'LRU', '┼': 'UDLR', '▼': 'U', '↓': 'U', '▲': 'D', '↑': 'D', '◀': 'R', '▶': 'L' }
  const POINTS = { '▼': 'D', '↓': 'D', '▲': 'U', '↑': 'U', '◀': 'L', '▶': 'R' }
  const STEP = { U: [-1, 0], D: [1, 0], L: [0, -1], R: [0, 1] }
  const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' }
  const at = (r, c) => grid[r]?.[c]
  const connects = (r, c, side) => (CONN[at(r, c)] ?? '').includes(side) && !owner.has(`${r},${c}`)
  for (const t of tokens) {
    if (owner.get(`${t.r},${t.c}`) !== t.state) continue
    for (let k = 0; k < t.len; k += 1) {
      for (const [dir, side] of [['D', 'U'], ['U', 'D']]) {
        const [dr] = STEP[dir]
        const start = [t.r + dr, t.c + k]
        if (!connects(start[0], start[1], side)) continue
        if (POINTS[at(...start)]) continue // an arrowhead into this state: an edge's end, not its start
        const seen = new Set()
        const queue = [start]
        while (queue.length) {
          const [r, c] = queue.shift()
          const key = `${r},${c}`
          if (seen.has(key)) continue
          seen.add(key)
          const ch = at(r, c)
          if (POINTS[ch]) {
            const [pr, pc] = STEP[POINTS[ch]]
            const target = owner.get(`${r + pr},${c + pc}`)
            if (target && target !== t.state) edges.add(`${t.state}>${target}`)
            continue
          }
          for (const d of CONN[ch] ?? '') {
            const [sr, sc] = STEP[d]
            let [nr, nc] = [r + sr, c + sc]
            // A label on a horizontal line ("── cascade re-review ──") does not break it.
            if ((d === 'L' || d === 'R') && !CONN[at(nr, nc)] && !owner.has(`${nr},${nc}`)) {
              let label = ''
              while (at(nr, nc) !== undefined && !CONN[at(nr, nc)] && !owner.has(`${nr},${nc}`) && label.length < 60) {
                label += at(nr, nc)
                nr += sr
                nc += sc
              }
              if (!/[a-z]/i.test(label)) continue
            }
            if (connects(nr, nc, OPPOSITE[d])) queue.push([nr, nc])
          }
        }
      }
    }
  }
  return edges
}

run('SOP lifecycle', () => {
  const states = constValues(read(ENUMS_TS), 'SopLifecycleState', ENUMS_TS)
  const sopSrc = read(SOP_TS)
  const listSrc = sopSrc.match(/export const VALID_SOP_TRANSITIONS[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1]
  if (!listSrc) throw new Error(`could not find VALID_SOP_TRANSITIONS in ${SOP_TS}`)
  const transitions = [...listSrc.matchAll(/from:\s*'([A-Z_]+)',\s*to:\s*'([A-Z_]+)'/g)].map((m) => `${m[1]}>${m[2]}`)
  if (transitions.length < 5) throw new Error(`read ${transitions.length} transitions from ${SOP_TS}; the parsing broke`)
  const REQUIRED_DIAGRAMS = ['concepts/sops.md', 'guide/how-it-works.md', 'guide/sops.md', 'reference/sop-format.md']
  const diagramPages = new Set()
  let tables = 0
  let diagrams = 0
  let counts = 0
  let unions = 0
  for (const p of pages) {
    for (const t of p.tables) {
      if (plain(t.header[0] ?? '').toLowerCase() !== 'state') continue
      const names = t.rows.map((r) => /^(?:`|\*\*)([A-Z_]+)(?:`|\*\*)$/.exec(r.cells[0] ?? '')?.[1]).filter(Boolean)
      if (names.filter((n) => states.includes(n)).length < 3) continue
      tables += 1
      compareList(`${p.rel}:${t.line}`, 'SOP lifecycle table', names, states, states, `SopLifecycleState (${ENUMS_TS})`)
    }
    for (const m of p.text.matchAll(/\b(\w+)-state lifecycle\b/g)) {
      const n = asNumber(m[1])
      if (n < 0) continue
      counts += 1
      if (n !== states.length) findings.push(`${p.rel}:${lineOf(p.text, m.index)}: "${m[0]}" — SopLifecycleState has ${states.length} states.`)
    }
    for (const m of p.text.matchAll(/\blifecycleState\??:\s*((?:\|?\s*'[A-Z_]+'\s*)+)/g)) {
      unions += 1
      const names = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])
      compareList(`${p.rel}:${lineOf(p.text, m.index)}`, '`lifecycleState` union', names, states, states, `SopLifecycleState (${ENUMS_TS})`)
    }
    for (const b of p.blocks) {
      if (b.lang && b.lang !== 'text') continue
      const named = new Set(b.lines.flatMap((l) => [...l.matchAll(new RegExp(`\\b(${states.join('|')})\\b`, 'g'))].map((m) => m[1])))
      if (named.size < 5) continue
      diagrams += 1
      diagramPages.add(p.rel)
      const drawn = diagramEdges(b.lines, states)
      const arrow = (e) => e.replaceAll('>', ' → ')
      const missing = transitions.filter((e) => !drawn.has(e))
      const extra = [...drawn].filter((e) => !transitions.includes(e))
      if (missing.length) findings.push(`${p.rel}:${b.line}: the lifecycle diagram does not draw ${missing.map(arrow).join(', ')} (VALID_SOP_TRANSITIONS, ${SOP_TS}).`)
      if (extra.length) findings.push(`${p.rel}:${b.line}: the lifecycle diagram draws ${extra.map(arrow).join(', ')}, which VALID_SOP_TRANSITIONS (${SOP_TS}) does not allow.`)
    }
  }
  for (const r of REQUIRED_DIAGRAMS) {
    if (!diagramPages.has(`apps/docs/${r}`)) findings.push(`SOP lifecycle: found no lifecycle diagram on apps/docs/${r}; the check no longer recognises it.`)
  }
  passes.push(`SOP lifecycle: ${diagrams} diagram(s) checked against the ${transitions.length} transitions; ${tables} table(s), ${counts} count(s) and ${unions} union(s) against the ${states.length} states`)
})

// ── 3. Graph-guardrails detector table ───────────────────────────────────
/** guide/graph-guardrails.md's row name for each detector id. */
const DETECTOR_ROWS = {
  'Consecutive repeat': 'consecutive_repeat',
  'Ping-pong cycle': 'ping_pong_cycle',
  'Landmark cycle': 'landmark_cycle',
  'Runaway recursion': 'recursion_depth',
  'Runaway fan-out': 'fan_out_explosion',
  'Tool contract drift': 'schema_drift',
  'Transition plausibility': 'transition_probability',
  'Missing predecessor': 'missing_predecessor',
  'Forbidden succession': 'forbidden_succession',
  'Call ceiling': 'call_ceiling',
  'Plan adherence': 'plan_adherence',
  'Scope path': 'scope_path',
  'Review hold': 'review_gate',
  'Declared taint': 'taint_cooccurrence',
  'Code as action': 'code_as_action',
  'DLP escalation': 'dlp_escalation',
  'Diversity collapse': 'tool_diversity_collapse',
  'Context growth': 'context_growth',
  'Budget exhaustion': 'budget_exhaustion',
  'Spend trajectory': 'spend_trajectory',
  'Fan-out overspend': 'spawn_budget_breach',
  'Workflow overspend': 'workflow_budget_breach',
  'Orphaned execution': 'orphan_execution',
  'Forbidden tool': 'unauthorized_tool',
  'Cross-harness': 'cross_harness_violation',
  'Prompt injection': 'prompt_injection',
  'Tool poisoning': 'tool_poisoning',
  'Sibling context overlap': 'context_overlap',
}

run('detector table', () => {
  const mod = read(ANOMALY_MOD)
  // The graph detectors live in a file of their own and are
  // registered by path (`graph_detectors::ContextOverlapDetector`).
  const detectorsSrc = read(ANOMALY_DETECTORS) + '\n' + read(GRAPH_DETECTORS)
  const defaults = mod.match(/pub fn with_defaults\(\)[\s\S]*?detectors: vec!\[([\s\S]*?)\]/)?.[1]
  if (!defaults) throw new Error(`could not find DetectorRegistry::with_defaults() in ${ANOMALY_MOD}`)
  const registered = [...defaults.matchAll(/Box::new\((?:[a-z_]\w*::)*([A-Z]\w*)/g)].map((m) => m[1])
  // An id written as a `const` (`CONTEXT_OVERLAP_ID`) resolves to its value.
  const consts = Object.fromEntries([...detectorsSrc.matchAll(/pub const (\w+): &str = "([a-z_]+)";/g)].map((m) => [m[1], m[2]]))
  const wire = Object.fromEntries([...mod.matchAll(/Self::(\w+) => "([A-Z_]+)"/g)].map((m) => [m[1], m[2]]))
  const allKinds = mod.match(/pub const ALL_KINDS: \[AnomalyKind; (\d+)\]/)?.[1]
  const impls = new Map()
  for (const part of detectorsSrc.split(/\nimpl AnomalyDetector for /).slice(1)) {
    const struct = part.match(/^(\w+)/)[1]
    const body = part.split(/\n\}\n/)[0]
    const id = body.match(/fn id\(&self\)[^{]*\{\s*"([a-z_]+)"/)?.[1] ?? consts[body.match(/fn id\(&self\)[^{]*\{\s*([A-Z_]+)\s*\}/)?.[1]]
    const kinds = [...new Set([...body.matchAll(/AnomalyKind::(\w+)/g)].map((m) => wire[m[1]] ?? m[1]))].sort()
    impls.set(struct, { id, kinds })
  }
  const byId = new Map()
  for (const struct of registered) {
    const impl = impls.get(struct)
    if (!impl?.id) throw new Error(`${struct} is registered in ${ANOMALY_MOD} but ${ANOMALY_DETECTORS} has no \`impl AnomalyDetector for ${struct}\` with an id`)
    byId.set(impl.id, impl)
  }
  if (byId.size === 0) throw new Error(`read no registered detectors from ${ANOMALY_MOD}; the parsing broke`)

  const p = page('guide/graph-guardrails.md')
  const table = p.tables.find((t) => plain(t.header[0] ?? '') === 'Detector' && /categor/i.test(t.header.at(-1) ?? ''))
  if (!table) throw new Error(`${p.rel} has no | Detector | … | Category | table`)
  const seen = new Set()
  for (const row of table.rows) {
    const name = plain(row.cells[0])
    const id = DETECTOR_ROWS[name]
    if (!id) {
      findings.push(`${p.rel}:${row.line}: the detector row "${name}" maps to no detector id; add it to DETECTOR_ROWS in this script.`)
      continue
    }
    seen.add(id)
    const impl = byId.get(id)
    if (!impl) {
      findings.push(`${p.rel}:${row.line}: the "${name}" row is detector ${id}, which DetectorRegistry::with_defaults() (${ANOMALY_MOD}) does not register.`)
      continue
    }
    const documented = [...row.cells.at(-1).matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]).sort()
    if (documented.join() !== impl.kinds.join()) {
      findings.push(`${p.rel}:${row.line}: the "${name}" row says ${documented.join(' / ') || '(no category)'}; ${id} reports ${impl.kinds.join(' / ')} (${ANOMALY_DETECTORS}).`)
    }
  }
  for (const id of byId.keys()) {
    if (!seen.has(id)) findings.push(`${p.rel}:${table.line}: detector ${id} is registered (${ANOMALY_MOD}) but has no row; add one and name it in DETECTOR_ROWS.`)
  }
  const covered = new Set([...byId.values()].flatMap((i) => i.kinds)).size
  const claim = /\*\*(\d+) of the (\d+)\*\* runtime anomaly categories/.exec(p.text)
  if (!claim) findings.push(`${p.rel}: the "**N of the M** runtime anomaly categories" sentence is gone; the check no longer recognises it.`)
  else if (Number(claim[1]) !== covered || Number(claim[2]) !== Number(allKinds)) {
    findings.push(`${p.rel}:${lineOf(p.text, claim.index)}: "${claim[0]}" — the registered detectors report ${covered} of the ${allKinds} kinds in ALL_KINDS.`)
  }
  passes.push(`detectors: ${table.rows.length} row(s) for ${byId.size} registered detector(s), ${covered} of ${allKinds} categories`)
})

// ── 4. clawde SDK "What's covered" ───────────────────────────────────────
run("clawde SDK what's covered", () => {
  const fixture = JSON.parse(read(OPERATIONS))
  const methods = new Map([...fixture.operations, ...fixture.offline].map((o) => [o.ts, o]))
  const coveredCli = new Set(fixture.operations.map((o) => o.cli).filter(Boolean))
  const p = page('reference/clawde-sdk.md')
  const start = p.text.indexOf("### What's covered")
  if (start === -1) throw new Error(`${p.rel} has no "### What's covered" section`)
  const end = p.text.indexOf('\n## ', start)
  const section = p.text.slice(start, end === -1 ? undefined : end)
  const offset = lineOf(p.text, start) - 1
  let pairs = 0
  for (const m of section.matchAll(/`([a-z][A-Za-z]+)` \(`([a-z_]+)(?:\([^`]*\))?`\)/g)) {
    pairs += 1
    const where = `${p.rel}:${offset + lineOf(section, m.index)}`
    const op = methods.get(m[1])
    if (!op) findings.push(`${where}: names \`${m[1]}\`, which is not a ControlPlaneClient method in ${OPERATIONS}.`)
    else if (op.py !== m[2]) findings.push(`${where}: gives \`${m[1]}\`'s Python name as \`${m[2]}\`; ${OPERATIONS} says \`${op.py}\`.`)
  }
  if (pairs === 0) findings.push(`${p.rel}: "What's covered" names no \`method\` (\`python_name\`) pair; the check no longer recognises it.`)
  const notCovered = /^Not covered, on purpose:.*$/m.exec(section)
  if (!notCovered) throw new Error(`${p.rel} has no "Not covered, on purpose:" paragraph`)
  const named = [...notCovered[0].matchAll(/`(?:intutic )?([a-z][a-z -]*)`/g)].map((m) => m[1].trim())
  const where = `${p.rel}:${offset + lineOf(section, notCovered.index)}`
  for (const cmd of named) {
    if (coveredCli.has(cmd)) findings.push(`${where}: says \`${cmd}\` is not covered, but ${OPERATIONS} covers it.`)
  }
  // Each excluded command must be named: "policy compile|install" is policy
  // compile and install, "judge configure" may be named as `judge`,
  // "traces (no credentials)" as `traces`.
  for (const key of Object.keys(fixture.excluded)) {
    const [head, ...alternatives] = key.replace(/\s*\(.*\)$/, '').split('|')
    const parent = head.split(' ').slice(0, -1).join(' ')
    for (const cmd of [head, ...alternatives.map((a) => `${parent} ${a}`.trim())]) {
      const words = cmd.split(' ')
      const ok = named.includes(cmd) || named.includes(words[0]) || named.includes(words.at(-1))
      if (!ok) findings.push(`${where}: does not name \`${cmd}\`, which ${OPERATIONS} excludes ("${fixture.excluded[key]}").`)
    }
  }
  passes.push(`clawde SDK: ${pairs} method name(s) and ${named.length} not-covered command(s) checked against ${OPERATIONS}`)
})

// ── 5. Tier matrix ───────────────────────────────────────────────────────
/** guide/tier-matrix.md's paid-plan rows, by how each starts, and the planSkuMap flag each describes. */
const TIER_ROWS = {
  'Policy Guardrails': 'policyGuardrailsEnabled',
  'LLM-as-judge': 'llmJudgeEnabled',
  'Single sign-on': 'ssoEnabled',
  'SSO group policy': 'ssoEnabled', // planAllowsGroupPolicy
  'Custom Filters': 'wasmRulesEnabled',
  'SOP Optimizer': 'sopOptimizerEnabled',
  'Evaluator Sandbox': 'evaluatorSandboxEnabled',
  'Fleet analytics': 'finopsEnabled', // planAllowsFleetAnalytics
  'Member spend budgets': 'finopsEnabled', // planAllowsMemberBudgets
  'SIEM export': 'siemExportEnabled',
  'SCIM provisioning': 'scimEnabled',
  'Data residency': 'multiRegionEnabled',
  'Self-hosted gateway': 'selfHostedGatewayEnabled',
  'Runs in your VPC or an air-gapped network': 'billing:license',
}

run('tier matrix', () => {
  const p = page('guide/tier-matrix.md')
  let plans
  let flagsChecked = true
  if (existsSync(join(ROOT, PLAN_SKU_MAP))) {
    const src = read(PLAN_SKU_MAP)
    const body = src.match(/export const planSkuMap: Record<string, PlanSku> = \{([\s\S]*?)\n\} as const/)?.[1]
    if (!body) throw new Error(`could not find planSkuMap in ${PLAN_SKU_MAP}`)
    plans = [...body.matchAll(/^ {2}(\w+): \{([\s\S]*?)^ {2}\},/gm)].map((m) => ({
      id: m[1],
      name: m[2].match(/displayName:\s*'([^']+)'/)?.[1],
      billing: m[2].match(/billing:\s*'([^']+)'/)?.[1],
      flags: Object.fromEntries([...m[2].matchAll(/(\w+):\s*(true|false),/g)].map((f) => [f[1], f[2] === 'true'])),
    }))
    plans = plans.filter((x) => x.billing && x.billing !== 'none')
    if (plans.length < 2) throw new Error(`read ${plans.length} paid plans from ${PLAN_SKU_MAP}; the parsing broke`)
  } else if (!existsSync(join(ROOT, PLANS_JSON))) {
    // Open-core checkout without the plan catalog: nothing names the columns, so there is nothing to compare.
    console.log(`[SKIP] neither ${PLAN_SKU_MAP} nor ${PLANS_JSON} is in this checkout: the tier-matrix columns are not checked.`)
    return
  } else {
    // Open-core checkout: no control plane. The docs' own plan data names the columns.
    plans = JSON.parse(read(PLANS_JSON)).map((x) => ({ id: x.id, name: x.name, billing: x.billing }))
    flagsChecked = false
    console.log(`[SKIP] ${PLAN_SKU_MAP} is not in this checkout: tier-matrix columns are checked against ${PLANS_JSON}, ticks are not.`)
  }
  const names = plans.map((x) => x.name)
  const table = p.tables.find((t) => (t.header[0] ?? '') === '' && t.header.slice(1).some((h) => names.includes(plain(h))))
  if (!table) throw new Error(`${p.rel} has no table whose columns are plan names`)
  const columns = table.header.slice(1).map(plain)
  if (columns.join() !== names.join()) {
    findings.push(`${p.rel}:${table.line}: the plan columns are ${columns.join(', ')}; the paid plans are ${names.join(', ')} (${flagsChecked ? PLAN_SKU_MAP : PLANS_JSON}).`)
    return
  }
  let ticks = 0
  for (const row of table.rows) {
    const label = plain(row.cells[0])
    const key = Object.keys(TIER_ROWS).find((k) => label.startsWith(k))
    if (!key) {
      findings.push(`${p.rel}:${row.line}: the row "${label.slice(0, 60)}" names no plan flag; add it to TIER_ROWS in this script.`)
      continue
    }
    if (!flagsChecked) continue
    const flag = TIER_ROWS[key]
    plans.forEach((plan, i) => {
      const has = flag.startsWith('billing:') ? plan.billing === flag.slice('billing:'.length) : plan.flags[flag]
      if (has === undefined) {
        findings.push(`${p.rel}:${row.line}: TIER_ROWS maps "${key}" to ${flag}, which ${PLAN_SKU_MAP} does not define for ${plan.id}.`)
        return
      }
      const ticked = (row.cells[i + 1] ?? '').includes('✓')
      ticks += 1
      if (ticked !== has) {
        const fact = flag.startsWith('billing:') ? `${plan.id}'s billing is ${plan.billing}` : `${plan.id}.${flag} is ${has}`
        findings.push(`${p.rel}:${row.line}: "${key}" is ${ticked ? 'ticked' : 'not ticked'} for ${plan.name}, but ${fact} (${PLAN_SKU_MAP}).`)
      }
    })
  }
  passes.push(`tier matrix: columns checked against ${names.length} paid plans${flagsChecked ? `, ${ticks} tick(s) against their flags` : ''}`)
})

for (const p of passes) console.log(`[CHECKED] ${p}.`)
if (findings.length > 0) {
  for (const f of findings) console.error(`[FAIL] ${f}`)
  process.exit(1)
}
console.log('[PASS] docs tables and diagrams match the code they restate.')
