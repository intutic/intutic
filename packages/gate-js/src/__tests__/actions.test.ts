import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, isDeploy, isTest, touchesInfra } from '../actions.js'

describe('classify', () => {
  it('only classifies shell-shaped tools', () => {
    expect(classify('read_file', { path: 'git push' })).toEqual([])
  })

  it('detects deploy commands', () => {
    expect(classify('bash', { command: 'kubectl apply -f x.yaml' })).toContain('action:deploy')
  })

  it('detects run_tests before deploy for a chained command', () => {
    const actions = classify('bash', { command: 'make test && git push' })
    expect(actions.indexOf('action:run_tests')).toBeLessThan(actions.indexOf('action:deploy'))
  })

  it('detects secret_read from a path fragment', () => {
    expect(classify('shell', { command: 'cat ~/.ssh/id_rsa' })).toContain('action:secret_read')
  })

  it('matches namespaced tool names via endsWith', () => {
    expect(classify('mcp__sh__bash', { command: 'git push' })).toContain('action:deploy')
  })

  it('reads every string value regardless of key name', () => {
    expect(classify('bash', { script: 'terraform apply' })).toContain('action:deploy')
  })

  it('ignores numbers/booleans/null in nested input', () => {
    expect(classify('bash', { command: 'ls', n: 1, flag: true, x: null })).toEqual([])
  })
})

describe('db_write, whatever separates the keywords', () => {
  // The commands and answers are the shared destructive-SQL vectors, run by
  // every classifier and text rule (destructiveSqlVectors.test.ts); this pins
  // the gap they all depend on.
  // The vectors every classifier shares (actions.rs, actions.py, the hook
  // gates' hold classifier): `git\tpush`, a line continuation or a long option
  // between the words used to classify as nothing here.
  const vectors = JSON.parse(
    readFileSync(join(__dirname, '../../../proxy/src/plugins/anomaly/action_vectors.json'), 'utf-8'),
  ) as { held: Array<[string, string[]]>; notHeld: string[]; adversarial: Array<[string, number]> }

  it.each(vectors.held)('classifies %j as %j', (command, tokens) => {
    expect(classify('bash', { command })).toEqual(tokens)
  })

  it.each(vectors.notHeld)('classifies %j as nothing', (command) => {
    expect(classify('bash', { command })).toEqual([])
  })

  // The proxy's regex (SQL_GAP in actions.rs) is safe in Rust's linear
  // engine; here a backtracking one took seconds on text an agent can be talked
  // into writing. The phrase matcher must stay linear on every one of these.
  it.each(vectors.adversarial)(
    'classifies %j repeated %i times in under 200 ms',
    (unit, times) => {
      const command = unit.repeat(times)
      let best = Infinity
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now()
        classify('bash', { command })
        best = Math.min(best, performance.now() - t0)
      }
      // The best of three runs: the bound is on the matcher, not on a busy machine.
      expect(best).toBeLessThan(200)
    },
  )

  it('carries a byte-identical copy of the shared phrase matcher', () => {
    const shared = readFileSync(join(__dirname, '../../../shared-types/src/phrases.ts'), 'utf-8')
    expect(readFileSync(join(__dirname, '../phrases.ts'), 'utf-8')).toBe(shared)
  })
})

describe('isDeploy / isTest', () => {
  it('isDeploy is true for a deploy command', () => {
    expect(isDeploy('bash', { command: 'helm upgrade x' })).toBe(true)
  })

  it('isDeploy is false for an unrelated command', () => {
    expect(isDeploy('bash', { command: 'ls -la' })).toBe(false)
  })

  it('isTest is true for a test command', () => {
    expect(isTest('bash', { command: 'pytest -q' })).toBe(true)
  })
})

describe('touchesInfra', () => {
  it('matches terraform paths', () => {
    expect(touchesInfra('infra/main.tf')).toBe(true)
  })

  it('matches k8s manifests', () => {
    expect(touchesInfra('k8s/deployment.yaml')).toBe(true)
  })

  it('does not match an ordinary source path', () => {
    expect(touchesInfra('src/index.ts')).toBe(false)
  })

  it('handles null/undefined without throwing', () => {
    expect(touchesInfra(undefined)).toBe(false)
    expect(touchesInfra(null)).toBe(false)
  })
})
