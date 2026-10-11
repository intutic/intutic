import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import { loadExperiment, parseExperiment } from './experiment.js'
import { examplesDir } from '../../commands/chaos.js'

const valid = `
name: demo
agent: claude -p "do it"
verify: npm test
faults:
  - id: tool.error
probes:
  - { id: task_success, weight: 2 }
  - { id: recovered_within, weight: 1, value: 3 }
abort:
  - cost_usd_above: 1
`

function errorsOf(text: string): string[] {
  const r = parseExperiment(text)
  if (r.ok) throw new Error('expected the experiment to be invalid')
  return r.errors
}

describe('parseExperiment', () => {
  it('accepts a valid experiment and applies the defaults', () => {
    const r = parseExperiment(valid)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.experiment.repeat).toBe(3)
    expect(r.experiment.faults[0]).toMatchObject({ id: 'tool.error', message: 'tool failed', after_calls: 0 })
  })

  it('reports YAML syntax errors', () => {
    expect(errorsOf('name: [unclosed')[0]).toMatch(/^not valid YAML/)
  })

  it('requires a cost ceiling, with the path of the field', () => {
    const errors = errorsOf(valid.replace('  - cost_usd_above: 1', '  - destructive_attempt'))
    expect(errors).toEqual(['abort: abort must include a cost_usd_above ceiling'])
  })

  it('names the probe that needs a value', () => {
    const errors = errorsOf(valid.replace('{ id: recovered_within, weight: 1, value: 3 }', '{ id: recovered_within, weight: 1 }'))
    expect(errors).toEqual(['probes.1: cost_multiplier_below and recovered_within need a value; other probes take none'])
  })

  it('rejects an unknown fault and an egress fault without a host', () => {
    expect(errorsOf(valid.replace('id: tool.error', 'id: tool.explode'))[0]).toMatch(/^faults\.0\.id: /)
    expect(errorsOf(valid.replace('id: tool.error', 'id: egress.dns_fail'))[0]).toMatch(/^faults\.0\.match: /)
  })

  it('rejects unknown keys', () => {
    expect(errorsOf(`${valid}\nretries: 3\n`)[0]).toMatch(/^\(top level\): Unrecognized key/)
  })
})

describe('the shipped example experiments', () => {
  const files = readdirSync(examplesDir()).filter((f) => f.endsWith('.yaml'))

  it('ships the three examples', () => {
    expect(files.sort()).toEqual(['credential-revoked.yaml', 'poisoned-readme.yaml', 'registry-down.yaml'])
  })

  it.each(files)('%s is valid and sets a cost ceiling', async (file) => {
    const r = await loadExperiment(path.join(examplesDir(), file))
    expect(r.ok ? [] : r.errors).toEqual([])
    if (r.ok) expect(r.experiment.name).toBe(file.replace(/\.yaml$/, ''))
  })

  it('reports a missing file', async () => {
    const r = await loadExperiment(path.join(examplesDir(), 'nope.yaml'))
    expect(r.ok ? [] : r.errors[0]).toMatch(/^cannot read /)
  })
})
