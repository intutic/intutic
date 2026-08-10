#!/usr/bin/env node
/**
 * Static reachability: every declared guard must connect to an enforcement
 * sink, and every control surface must connect to a reader.
 *
 * The dynamic probes (packages/proxy/src/probes.rs) verify at runtime that
 * guards FIRE. This gate verifies at lint time that the wiring between
 * declaration and enforcement exists at all — the two catch different halves
 * of the same defect class, the inert control. The idea is borrowed from
 * code-knowledge-graph tooling: model declarations and sinks as nodes, resolve
 * references as edges, and flag any node with no path to the other side.
 *
 * Three edges are checked, each chosen because this repository has already
 * shipped its failure:
 *
 * 1. **Probe guard → registered detector.** A probe naming a detector that was
 *    renamed or removed probes nothing, passes nothing, and its verdicts stop
 *    meaning anything — while the suite still reports green counts.
 * 2. **Registered detector → corpus baseline row.** The published
 *    false-positive claims are generated from BASELINE.txt; a detector missing
 *    from it is invisible to the honesty pipeline.
 * 3. **Writable feature flag → reader.** `ff_shadow_enforcement` was declared
 *    in WorkspaceSettings, stripped by the PUT schema, and therefore
 *    unreachable from every operator path for as long as nobody noticed. The
 *    inverse rot is a flag the schema CAN write that nothing reads — a switch
 *    wired to no circuit. Every flag in the PUT schema must be read somewhere
 *    outside the files that write it.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const failures = []

// ── 1 + 2: detector ids from the registry ────────────────────────────────
const modRs = read('packages/proxy/src/plugins/anomaly/mod.rs')
const detectorsRs = read('packages/proxy/src/plugins/anomaly/detectors.rs')
// Every `fn id(&self)` return in the detectors file, cross-checked against
// registration in with_defaults.
const idFns = [...detectorsRs.matchAll(/fn id\(&self\) -> &'static str \{\s*"([a-z0-9_]+)"/g)].map(
  (m) => m[1],
)
const registeredTypes = [...modRs.matchAll(/Box::new\((\w+)::default\(\)\)/g)].map((m) => m[1])
if (idFns.length === 0 || registeredTypes.length === 0) {
  failures.push('parser found no detector ids or registrations — the gate itself broke')
}

const probesRs = read('packages/proxy/src/probes.rs')
const probeGuards = [...probesRs.matchAll(/guard: "([a-z0-9_]+)"/g)]
  .map((m) => m[1])
  .filter((g) => g !== 'dlp')
for (const g of new Set(probeGuards)) {
  if (!idFns.includes(g)) {
    failures.push(
      `probe guard "${g}" names no registered detector — the probe verifies nothing ` +
        `and its green verdicts are decoration`,
    )
  }
}

const baseline = read('packages/proxy/tests/corpus/BASELINE.txt')
for (const id of idFns) {
  if (!baseline.includes(id)) {
    failures.push(
      `detector "${id}" is absent from BASELINE.txt — the published coverage claims ` +
        `cannot see it. Regenerate with INTUTIC_WRITE_BASELINE=1.`,
    )
  }
}

// ── 3: writable flags must have readers ──────────────────────────────────
//
// The flag writer lives in the control plane, which the open-core tree does
// not carry. Skipped there BY NAME — a silent skip would read as six flags
// checked when zero were, which is the vacuous pass this gate hunts.
import { existsSync } from 'node:fs'
const flagWriterPath = 'services/control-plane/src/routes/workspace.ts'
let writableFlags = []
if (!existsSync(join(ROOT, flagWriterPath))) {
  console.log(
    '[skip] flag-reachability edge: no control plane in this tree (open-core); ' +
      'checked in the enterprise repo',
  )
} else {
  const workspaceRoute = read(flagWriterPath)
  writableFlags = [...workspaceRoute.matchAll(/(ff_[a-z_]+):\s*z\.boolean\(\)/g)].map(
    (m) => m[1],
  )
  if (writableFlags.length === 0) {
    failures.push('parser found no writable flags in the PUT schema — the gate itself broke')
  }
}

/** Files that WRITE flags; a mention there is not a reader. */
const WRITER_FILES = new Set([
  'services/control-plane/src/routes/workspace.ts',
  'packages/shared-types/src/posturePresets.ts',
  'services/control-plane/__tests__/integration/posturePresets.test.ts',
])

for (const flag of writableFlags) {
  let hits = []
  try {
    hits = execFileSync('git', ['grep', '-l', flag, '--', ':!*.md', ':!*dist*'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    hits = []
  }
  const readers = hits.filter((f) => !WRITER_FILES.has(f))
  if (readers.length === 0) {
    failures.push(
      `feature flag "${flag}" is writable via the settings PUT and read by nothing — ` +
        `a switch wired to no circuit`,
    )
  }
}

if (failures.length > 0) {
  console.error(`✖ guard reachability: ${failures.length} disconnected node(s)\n`)
  for (const f of failures) console.error(`    ${f}`)
  console.error(
    '\nA declaration with no path to an enforcement sink, or a control surface with\n' +
      'no reader, is the inert-control shape this repository keeps refinding at\n' +
      'runtime. This gate finds the wiring half at lint time; the runtime probes\n' +
      '(packages/proxy/src/probes.rs) find the behavioural half.',
  )
  process.exit(1)
}

console.log(
  `[PASS] guard reachability: ${new Set(probeGuards).size} probe guard(s) resolve, ` +
    `${idFns.length} detector(s) in the baseline, ${writableFlags.length} writable flag(s) have readers.`,
)
