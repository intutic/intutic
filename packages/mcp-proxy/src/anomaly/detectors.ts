/**
 * anomaly/detectors.ts — The 7 anomaly detectors ported from
 * `packages/proxy/src/plugins/anomaly/detectors.rs`, confirmed applicable to
 * MCP tool-call traffic.
 *
 * Every threshold, window, marker list, and disposition below was read
 * directly from `detectors.rs` (and, for `tool_poisoning`, from
 * `tool_poison.rs`) — none invented. See this package's Phase 2 report for
 * the verbatim citations.
 *
 * # Which 26 were excluded, and why
 *
 * `detectors.rs` registers ~26 detectors; this file ports exactly 7. The
 * rest are excluded for reasons specific to what an MCP stdio proxy can
 * honestly observe — see the Phase 2 report for the itemized list — not
 * because they were skipped for time.
 *
 * @module
 */

import { scanToolDescription } from '../toolPoison.js'
import type { ToolsListEntry } from '../session.js'

export type Disposition = 'steer' | 'reask' | 'kill'

/** Severity order for sorting/clamping — mirrors `Disposition`'s derived
 *  `Ord` in mod.rs (`Steer < Reask < Ask < Kill`); this package never uses
 *  `Ask`, so the four-way order collapses to three. */
export const DISPOSITION_SEVERITY: Readonly<Record<Disposition, number>> = {
  steer: 1,
  reask: 2,
  kill: 3,
}

export interface AnomalyFinding {
  /** Stable detector identity — same convention as `AnomalyDetector::id()`. */
  detectorId: string
  /** A taxonomy label, matching (a subset of) `AnomalyKind::as_str()`'s wire values. */
  kind: string
  reason: string
  /** 0.0–1.0. */
  confidence: number
  /** The disposition this DETECTOR declares — the Rust-source-verified
   *  ceiling `mcpAnomalyMode`/per-detector overrides may only ever demote
   *  from (see `anomaly/index.ts`'s `resolveEffectiveDisposition`). */
  disposition: Disposition
}

/**
 * Confidence for a threshold detector, from how far past its threshold it
 * is. Ported verbatim from `detectors.rs`'s `threshold_confidence`: never
 * reaches 1.0 (an unmeasured structural threshold has not earned certainty),
 * starts at 0.55 at the threshold, +0.1 per unit past it, capped at 0.95.
 */
function thresholdConfidence(observed: number, threshold: number): number {
  const excess = Math.max(0, observed - threshold)
  return Math.min(0.55 + 0.1 * excess, 0.95)
}

// ── consecutive_repeat ──────────────────────────────────────────────────────

/** Ported from `detectors.rs`'s `REPETITION_THRESHOLD`. */
const REPETITION_THRESHOLD = 5

/**
 * A node calling the same tool over and over — the most common shape of a
 * graph that has stopped making progress. `Reask` disposition (verified:
 * `AnomalyFinding::reask` in `ConsecutiveRepeatDetector::detect`).
 */
export function consecutiveRepeat(seq: readonly string[]): AnomalyFinding | null {
  let run = 1
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) {
      run += 1
      if (run >= REPETITION_THRESHOLD) {
        return {
          detectorId: 'consecutive_repeat',
          kind: 'loop_detected',
          reason: `Loop detected: '${seq[i]}' called ${run} times consecutively without progress`,
          confidence: thresholdConfidence(run, REPETITION_THRESHOLD),
          disposition: 'reask',
        }
      }
    } else {
      run = 1
    }
  }
  return null
}

// ── ping_pong_cycle ──────────────────────────────────────────────────────

/** Ported from `detectors.rs`'s `PING_PONG_CYCLES`. */
const PING_PONG_CYCLES = 3

/**
 * Two tools handing work back and forth — invisible to `consecutiveRepeat`
 * because no tool ever repeats twice in a row. `Reask` disposition
 * (verified).
 */
export function pingPongCycle(seq: readonly string[]): AnomalyFinding | null {
  const needed = PING_PONG_CYCLES * 2
  if (seq.length < needed) return null
  const tail = seq.slice(seq.length - needed)
  const a = tail[0]
  const b = tail[1]
  if (a === b) return null // that is a spin, not an alternation
  const alternating = tail.every((t, i) => (i % 2 === 0 ? t === a : t === b))
  if (!alternating) return null
  return {
    detectorId: 'ping_pong_cycle',
    kind: 'loop_detected',
    reason: `Loop detected: '${a}' and '${b}' alternating for ${PING_PONG_CYCLES} cycles with no other activity`,
    confidence: thresholdConfidence(PING_PONG_CYCLES, PING_PONG_CYCLES),
    disposition: 'reask',
  }
}

// ── landmark_cycle ──────────────────────────────────────────────────────

// All six constants below are ported verbatim from `detectors.rs` — see that
// file's own extensive doc comments (LANDMARK_WINDOW/MAX_CYCLE_PERIOD are
// deliberately coupled: 6 * MIN_CYCLE_REPEATS(4) == 24 == LANDMARK_WINDOW).
const LANDMARK_WINDOW = 24
const MIN_LANDMARK_ANCHORS = 8
const MAX_CYCLE_PERIOD = 6
const MIN_CYCLE_REPEATS = 4
const CYCLE_COVERAGE_FLOOR = 0.75
const CYCLE_MATCH_RATIO = 0.75
const ANCHOR_FREQ_SLOTS = 256

/**
 * Case-folded interning of the tool-name sequence into small integer ids.
 *
 * The Rust `anchor_projection` also strips synthesised `action:` tokens
 * before interning — this proxy has no equivalent token-synthesis machinery
 * (MCP's `tool_sequence` is recorded tool names only, see `session.ts`), so
 * every entry here is already a concrete anchor; this function's only job is
 * the interning itself.
 */
function anchorProjection(seq: readonly string[]): { anchors: number[]; symbols: string[] } {
  const symbols: string[] = []
  const anchors: number[] = []
  for (const tok of seq) {
    const lower = tok.toLowerCase()
    let id = symbols.findIndex((s) => s.toLowerCase() === lower)
    if (id === -1) {
      symbols.push(tok)
      id = symbols.length - 1
    }
    anchors.push(Math.min(id, 0xffff))
  }
  return { anchors, symbols }
}

interface CycleCoverageSample {
  coverage: number
  windowLen: number
  survivors: number[]
  symbols: string[]
}

/** Ported from `detectors.rs`'s `landmark_cycle_coverage`. */
function landmarkCycleCoverage(seq: readonly string[]): CycleCoverageSample | null {
  const { anchors, symbols } = anchorProjection(seq)
  if (anchors.length < MIN_LANDMARK_ANCHORS) return null
  const window = anchors.slice(Math.max(0, anchors.length - LANDMARK_WINDOW))

  const freq = new Array<number>(ANCHOR_FREQ_SLOTS).fill(0)
  for (const id of window) {
    const slot = id % ANCHOR_FREQ_SLOTS
    freq[slot] = (freq[slot] ?? 0) + 1
  }
  const survivors = window.filter((id) => (freq[id % ANCHOR_FREQ_SLOTS] ?? 0) > 1)
  if (survivors.length < MIN_LANDMARK_ANCHORS) return null

  return { coverage: survivors.length / window.length, windowLen: window.length, survivors, symbols }
}

/** Ported from `detectors.rs`'s `describe_cycle`. */
function describeCycle(symbols: readonly string[], survivors: readonly number[], period: number): string {
  if (survivors.length < period) return ''
  return survivors
    .slice(survivors.length - period)
    .map((id) => symbols[id] ?? '?')
    .join(' → ')
}

/**
 * Repetition that survives one stray call — the gap-tolerant counterpart to
 * `consecutiveRepeat`/`pingPongCycle`. `Steer` disposition (verified: this
 * detector "ships steer and may never earn kill under the promotion rule,"
 * per `detectors.rs`'s own doc comment — `Read → View → Write` repeated
 * eight times is both a perfect period-3 cycle AND a productive agent
 * editing eight files, a category error in the signal no threshold fixes).
 */
export function landmarkCycle(seq: readonly string[]): AnomalyFinding | null {
  const sample = landmarkCycleCoverage(seq)
  if (!sample || sample.coverage < CYCLE_COVERAGE_FLOOR) return null
  const { windowLen, survivors, symbols } = sample
  const n = survivors.length

  for (let p = 1; p <= MAX_CYCLE_PERIOD; p++) {
    if (n < Math.max(MIN_LANDMARK_ANCHORS, p * MIN_CYCLE_REPEATS)) continue
    const comparable = n - p
    if (comparable === 0) continue
    let matches = 0
    for (let i = p; i < n; i++) {
      if (survivors[i] === survivors[i - p]) matches += 1
    }
    const score = matches / comparable
    if (score < CYCLE_MATCH_RATIO) continue

    const cycle = describeCycle(symbols, survivors, p)
    return {
      detectorId: 'landmark_cycle',
      kind: 'loop_detected',
      reason:
        `Loop detected: ${survivors.length} of the last ${windowLen} concrete tool calls are ` +
        `repeating on a period of ${p} (${cycle}), matching ${(score * 100).toFixed(0)}% of the time`,
      confidence: score,
      disposition: 'steer',
    }
  }
  return null
}

// ── tool_diversity_collapse ──────────────────────────────────────────────

/** Ported from `detectors.rs`'s `DIVERSITY_WINDOW` / `DIVERSITY_MIN_DISTINCT`. */
const DIVERSITY_WINDOW = 10
const DIVERSITY_MIN_DISTINCT = 2

/**
 * A long run drawing on a single tool, possibly interleaved with nothing
 * else, that still makes no progress. `Steer` disposition, confidence 0.8
 * (both verified from `ToolDiversityCollapseDetector::detect`).
 */
export function toolDiversityCollapse(seq: readonly string[]): AnomalyFinding | null {
  if (seq.length < DIVERSITY_WINDOW) return null
  const tail = seq.slice(seq.length - DIVERSITY_WINDOW)
  const distinct = new Set(tail)
  if (distinct.size >= DIVERSITY_MIN_DISTINCT) return null
  return {
    detectorId: 'tool_diversity_collapse',
    kind: 'token_waste',
    reason: `No progress: the last ${DIVERSITY_WINDOW} tool calls used only '${tail[0]}'`,
    confidence: 0.8,
    disposition: 'steer',
  }
}

// ── code_as_action ──────────────────────────────────────────────────────

// Ported verbatim from `detectors.rs`'s four marker arrays.
const CODE_EXECUTION_TOOL_MARKERS = [
  'bash', 'shell', 'exec', 'python', 'repl', 'run_code', 'code_interpreter', 'jupyter', 'terminal', 'eval',
] as const
const CODE_SECRET_ACCESS_MARKERS = [
  '.aws/credentials', 'id_rsa', '.ssh/', '.env', 'aws_secret_access_key',
  'getenv("anthropic', 'getenv("openai', 'getenv("aws',
  'process.env.anthropic', 'process.env.openai', 'process.env.aws',
  'keychain', 'secretsmanager',
] as const
const CODE_EGRESS_MARKERS = [
  'curl ', 'wget ', 'http.post', 'requests.post', 'requests.put', 'fetch(', 'urlopen',
  'httpx.', 'nc ', 'netcat', 'scp ', 'rsync ',
] as const
const CODE_DESTRUCTIVE_MARKERS = [
  'rm -rf /', 'rm -fr /', 'mkfs', 'dd if=', ' of=/dev/', ':(){', '> /dev/sda',
] as const

/**
 * One code-execution call bundling what per-call gates would have caught
 * apart — the in-blob analogue of `secret_read` followed by `http_post`.
 * Substring markers, deliberately (see `detectors.rs`'s doc comment): an AST
 * per language is neither cheap nor honestly complete, and a marker's
 * failure mode (an obfuscated payload slips through) is strictly better than
 * claiming AST-grade coverage and delivering it for two languages of ten.
 * `Kill` disposition on both shapes (verified: both branches return
 * `AnomalyFinding::kill` in `CodeAsActionDetector::detect`).
 */
export function codeAsAction(toolName: string, toolArguments: unknown): AnomalyFinding | null {
  const name = toolName.toLowerCase()
  if (!CODE_EXECUTION_TOOL_MARKERS.some((m) => name.includes(m))) return null

  let code: string
  try {
    code = JSON.stringify(toolArguments ?? {}).toLowerCase()
  } catch {
    return null // circular/unserializable arguments — nothing to scan
  }

  const destructive = CODE_DESTRUCTIVE_MARKERS.find((m) => code.includes(m))
  if (destructive) {
    return {
      detectorId: 'code_as_action',
      kind: 'tool_abuse',
      reason:
        `Code-execution call '${toolName}' contains a destructive operation ('${destructive.trim()}'). ` +
        `Per-call gates cannot see inside a code blob; this one was read.`,
      confidence: 1.0,
      disposition: 'kill',
    }
  }

  const secretAccess = CODE_SECRET_ACCESS_MARKERS.find((m) => code.includes(m))
  const egress = CODE_EGRESS_MARKERS.find((m) => code.includes(m))
  if (secretAccess && egress) {
    return {
      detectorId: 'code_as_action',
      kind: 'data_exfiltration',
      reason:
        `Code-execution call '${toolName}' bundles credential access ('${secretAccess}') with network ` +
        `egress ('${egress.trim()}') in one blob — the in-code shape of secret_read -> http_post, which ` +
        `the succession detector cannot see because both halves are inside a single call.`,
      confidence: 1.0,
      disposition: 'kill',
    }
  }
  return null
}

/**
 * Runs the five sequence/call-based detectors above against one prospective
 * request and returns every finding, sorted most-severe-first — mirroring
 * `DetectorRegistry::evaluate_all`'s own sort (disposition severity;
 * `AnomalyKind` severity is not ported, since this proxy does not carry that
 * taxonomy-wide ranking table).
 */
export function evaluateSequenceDetectors(
  toolSequence: readonly string[],
  toolName: string,
  toolArguments: unknown,
): AnomalyFinding[] {
  const findings = [
    consecutiveRepeat(toolSequence),
    pingPongCycle(toolSequence),
    landmarkCycle(toolSequence),
    toolDiversityCollapse(toolSequence),
    codeAsAction(toolName, toolArguments),
  ].filter((f): f is AnomalyFinding => f !== null)
  findings.sort((a, b) => DISPOSITION_SEVERITY[b.disposition] - DISPOSITION_SEVERITY[a.disposition])
  return findings
}

// ── tool_poisoning ──────────────────────────────────────────────────────

/**
 * Instructions hidden in a tool's DESCRIPTION rather than in conversation
 * text — a different attack surface from `injection.ts`'s response-direction
 * scan (which reuses the same 5 conversational patterns Phase 1 ported).
 * Reads `toolPoison.ts`'s 7-pattern scanner. `Steer` disposition (verified:
 * `AnomalyFinding::steer` in `ToolPoisoningDetector::detect`) — the Rust
 * doc's own reasoning for why this steers rather than reasks applies
 * identically here: the poisoned text belongs to a third-party server's
 * static tool array, identical on every retry, so a reask would be a
 * guaranteed three-strike block rather than a correction loop.
 */
export function toolPoisoning(tools: readonly ToolsListEntry[]): AnomalyFinding | null {
  const hits: string[] = []
  for (const tool of tools) {
    if (!tool.description) continue
    for (const technique of scanToolDescription(tool.description)) {
      hits.push(`${tool.name}: ${technique}`)
    }
  }
  if (hits.length === 0) return null
  const deduped = Array.from(new Set(hits)).sort()
  return {
    detectorId: 'tool_poisoning',
    kind: 'prompt_injection',
    reason:
      `Tool description carries model-directed instructions (${deduped.join('; ')}). The description ` +
      `reaches the model unchanged — this is a report, not a block.`,
    confidence: 0.6,
    disposition: 'steer',
  }
}

// ── dlp_escalation ──────────────────────────────────────────────────────

/** Ported from `detectors.rs`'s `DLP_ESCALATION_THRESHOLD`. */
const DLP_ESCALATION_THRESHOLD = 3

/**
 * ≥3 distinct DLP-redacted pattern types in one response is a credential
 * sweep, not a single mistake. `Kill` in the Rust source (verified:
 * `AnomalyFinding::kill` in `DlpEscalationDetector::detect`) — but this
 * proxy deliberately never converts that into a NEW block decision: unlike
 * the Rust proxy's request-direction detector, this MCP proxy's own DLP scan
 * ALREADY blocks a request carrying any single finding (interceptor.ts step
 * 1, unconditionally), so a request-direction escalation gate here would be
 * unreachable dead code. The place this actually adds value is the RESPONSE
 * direction, where DLP redacts rather than blocks (the call already ran) —
 * there, blocking after redaction protects nothing further (the same
 * reasoning `dlp.ts`'s own module doc gives for why redaction, not
 * blocking, is correct on results), so this function is consulted for EVENT
 * SEVERITY escalation only. Declaring its disposition as `'kill'` here is
 * about honestly recording what the Rust source declares for the
 * promotion-invariant bookkeeping, not about this proxy ever enforcing it as
 * a block.
 */
export function dlpEscalation(distinctPatternDescriptions: readonly string[]): AnomalyFinding | null {
  const distinct = Array.from(new Set(distinctPatternDescriptions)).sort()
  if (distinct.length < DLP_ESCALATION_THRESHOLD) return null
  return {
    detectorId: 'dlp_escalation',
    kind: 'data_exfiltration',
    reason: `Credential sweep: ${distinct.length} distinct sensitive patterns in one response (${distinct.join(', ')})`,
    confidence: 1.0,
    disposition: 'kill',
  }
}
