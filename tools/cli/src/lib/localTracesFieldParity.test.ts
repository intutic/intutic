// localTraces.ts reads the proxy's own local trace JSONL — a cross-language
// contract with no shared schema, the same class of gap
// changeManifestParity.test.ts exists to close for a different wire shape.
// `ExecutionTrace` is defined once, in Rust (`packages/proxy/src/telemetry.rs`);
// `toLocalTraceRow` in this directory re-declares the fields it reads by
// hand. This test is what makes "by hand" safe: every field the reader
// consumes must still exist in the Rust struct, and the local verdict
// vocabulary and the 64MB write cap this reader discloses to users must
// still match what the proxy actually does.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCAL_VERDICTS } from './localTraces.js'

const TELEMETRY_RS = readFileSync(
  resolve(__dirname, '../../../../packages/proxy/src/telemetry.rs'),
  'utf-8',
)

const PROXY_RS = readFileSync(resolve(__dirname, '../../../../packages/proxy/src/proxy.rs'), 'utf-8')

const LOCAL_SPEND_RS = readFileSync(
  resolve(__dirname, '../../../../packages/proxy/src/local_spend.rs'),
  'utf-8',
)

describe('localTraces.ts field parity with ExecutionTrace', () => {
  it('every field toLocalTraceRow reads still exists on ExecutionTrace', () => {
    const fields = [
      'pub trace_id:',
      'pub created_at:',
      'pub requested_model:',
      'pub actual_model_routed:',
      'pub verdict:',
      'pub raw_cost_usd:',
      'pub actual_cost_usd:',
      'pub harness_type:',
      'pub latency_ms:',
      'pub cache_hit:',
      'pub break_glass:',
    ]
    for (const field of fields) {
      expect(TELEMETRY_RS, `ExecutionTrace lost ${field} — update localTraces.ts's toLocalTraceRow`).toContain(field)
    }
  })

  it('the local verdict vocabulary matches every literal ExecutionTrace.verdict value the proxy writes', () => {
    // Every `verdict: "..."` / `=> "..."` string literal feeding the
    // ExecutionTrace.verdict field, across every construction site in
    // proxy.rs. If this list ever grows (or shrinks), LOCAL_VERDICTS and the
    // CLI's --verdict validation/help text must move with it.
    for (const verdict of LOCAL_VERDICTS) {
      expect(PROXY_RS, `"${verdict}" no longer appears as a verdict literal in proxy.rs`).toContain(`"${verdict}"`)
    }
  })

  it('the disclosed 64MB write cap matches local_spend.rs\'s MAX_TRACE_LOG_BYTES', () => {
    const match = LOCAL_SPEND_RS.match(/const MAX_TRACE_LOG_BYTES:\s*u64\s*=\s*([^;]+);/)
    expect(match, 'MAX_TRACE_LOG_BYTES not found in local_spend.rs').not.toBeNull()
    // Parsed, not eval'd: the expression is always a plain `N * N * N`
    // product of integer literals (e.g. "64 * 1024 * 1024").
    const rustValue = match![1]
      .trim()
      .split('*')
      .map((n) => Number(n.trim().replace(/_/g, '')))
      .reduce((a, b) => a * b, 1)
    expect(rustValue).toBe(64 * 1024 * 1024)
  })

  it('log_offline_trace still writes to logs/traces-{date}.jsonl', () => {
    expect(LOCAL_SPEND_RS).toContain("dir.join(\"logs\")")
    expect(LOCAL_SPEND_RS).toContain('traces-{}.jsonl')
  })
})
