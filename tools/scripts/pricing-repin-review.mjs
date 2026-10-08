#!/usr/bin/env node
/**
 * pricing-repin-review.mjs — what a regenerated pricing bundle changed, and
 * whether the nightly re-pin may merge it without a person.
 *
 * Compares packages/proxy/src/pricing/offline_bundle.json at HEAD with the
 * working tree (after build-offline-pricing-bundle.ts ran) and prints a
 * Markdown summary: models added and dropped, and every rate that moved, old
 * → new, per 1k tokens.
 *
 * Exit codes:
 *   0  rates or models changed, and nothing below calls for a person:
 *      tools/scripts/pricing-repin.sh merges it once CI passes.
 *   2  nothing but the pin changed (no rate, no model): no pull request.
 *   3  a person reviews first: a model we priced was dropped, a non-zero
 *      rate went to zero or disappeared, or more rates moved at once than
 *      ordinary upstream edits do (MAX_CHANGED_RATES), which is what a broken
 *      upstream file or a unit change looks like.
 *   1  the comparison itself failed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = 'packages/proxy/src/pricing/offline_bundle.json'
const RATES = ['input_cost_per_1k', 'output_cost_per_1k', 'cache_read_cost_per_1k', 'cache_write_cost_per_1k']
export const MAX_CHANGED_RATES = 20

/** Every rate in a bundle, keyed "section/model/field": the models, the family fallbacks, the unknown-model estimate. */
function ratesOf(bundle) {
  const out = new Map()
  for (const section of ['models', 'family_fallbacks']) {
    for (const [model, entry] of Object.entries(bundle[section] ?? {})) {
      for (const field of RATES) if (field in entry) out.set(`${section}/${model}/${field}`, entry[field])
    }
  }
  for (const field of RATES) {
    const value = bundle.unknown_model_conservative_estimate?.[field]
    if (value !== undefined) out.set(`unknown_model_conservative_estimate/-/${field}`, value)
  }
  return out
}

/** The review of `before` → `after`: Markdown and the exit code (see the header). */
export function review(before, after) {
  const was = ratesOf(before)
  const now = ratesOf(after)
  const modelsBefore = new Set(Object.keys(before.models ?? {}))
  const modelsAfter = new Set(Object.keys(after.models ?? {}))
  const added = [...modelsAfter].filter((m) => !modelsBefore.has(m)).sort()
  const dropped = [...modelsBefore].filter((m) => !modelsAfter.has(m)).sort()

  const moved = []
  const lost = []
  for (const [key, old] of was) {
    const [section, model] = key.split('/')
    if (section === 'models' && !modelsAfter.has(model)) continue // reported as dropped
    const next = now.get(key)
    // A rate already zero (a free tier, our own self-hosted judge) is not lost.
    if (old !== 0 && (next === undefined || next === 0)) lost.push({ key, old, next: next ?? 'removed' })
    else if (next !== undefined && next !== old) moved.push({ key, old, next })
  }

  const reasons = []
  if (dropped.length) reasons.push(`${dropped.length} model(s) we priced were dropped`)
  if (lost.length) reasons.push(`${lost.length} rate(s) went to zero or disappeared`)
  if (moved.length > MAX_CHANGED_RATES) reasons.push(`${moved.length} rates moved at once (more than ${MAX_CHANGED_RATES})`)

  const lines = []
  if (!added.length && !dropped.length && !moved.length && !lost.length) return { code: 2, markdown: 'No rate or model changed.' }
  lines.push(reasons.length ? `**Needs a person:** ${reasons.join('; ')}.` : '**Safe to merge on green CI:** no model dropped, no rate zeroed, and fewer than the changed-rate limit.')
  lines.push('')
  if (moved.length || lost.length) {
    lines.push('| Rate (per 1k tokens) | Was | Now |', '|---|---|---|')
    for (const { key, old, next } of [...lost, ...moved]) lines.push(`| \`${key}\` | ${old} | ${next} |`)
    lines.push('')
  }
  if (added.length) lines.push(`Added (${added.length}): ${added.map((m) => `\`${m}\``).join(', ')}`, '')
  if (dropped.length) lines.push(`Dropped (${dropped.length}): ${dropped.map((m) => `\`${m}\``).join(', ')}`, '')
  return { code: reasons.length ? 3 : 0, markdown: lines.join('\n').trim() }
}

function main() {
  try {
    const before = JSON.parse(execFileSync('git', ['show', `HEAD:${BUNDLE}`], { cwd: ROOT, encoding: 'utf8' }))
    const after = JSON.parse(readFileSync(resolve(ROOT, BUNDLE), 'utf8'))
    const { code, markdown } = review(before, after)
    console.log(markdown)
    return code
  } catch (err) {
    console.error(`pricing-repin-review: ${err instanceof Error ? err.message : err}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
