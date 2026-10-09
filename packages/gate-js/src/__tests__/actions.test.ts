import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, isDeploy, isTest, touchesInfra, SQL_GAP } from '../actions.js'

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
  // A plain "drop table" substring missed every one of these.
  it.each([
    "psql -c 'DROP\nTABLE users'",
    "psql -c 'DROP\tTABLE users'",
    "psql -c 'DROP/**/TABLE users'",
    "psql -c 'DROP /* why */ TABLE users'",
    "psql -c 'DROP -- why\nTABLE users'",
    "psql -c 'dRoP tAbLe users'",
    String.raw`printf 'DROP\nTABLE users' | psql`,
    String.raw`printf 'DROP -- why\nTABLE users' | psql`,
  ])('%j is a db_write', (command) => {
    expect(classify('bash', { command })).toEqual(['action:db_write'])
  })

  it('reads JSON-escaped arguments decoded', () => {
    const decoded = JSON.parse(String.raw`{"command": "psql -c \"DROP\nTABLE users\""}`)
    expect(classify('bash', decoded)).toEqual(['action:db_write'])
  })

  it.each(['git stash drop', 'psql --table-only', 'drop_table_helper.sh', 'dropdb --help'])(
    '%j alone is not a db_write',
    (command) => {
      expect(classify('bash', { command })).not.toContain('action:db_write')
    },
  )

  // The vectors every classifier shares (actions.rs, actions.py, the hook
  // gates' hold classifier): `git\tpush`, a line continuation or a long option
  // between the words used to classify as nothing here.
  const vectors = JSON.parse(
    readFileSync(join(__dirname, '../../../proxy/src/plugins/anomaly/action_vectors.json'), 'utf-8'),
  ) as { held: Array<[string, string[]]>; notHeld: string[] }

  it.each(vectors.held)('classifies %j as %j', (command, tokens) => {
    expect(classify('bash', { command })).toEqual(tokens)
  })

  it.each(vectors.notHeld)('classifies %j as nothing', (command) => {
    expect(classify('bash', { command })).toEqual([])
  })

  it('uses the same SQL_GAP as the proxy', () => {
    const rust = readFileSync(join(__dirname, '../../../proxy/src/plugins/anomaly/actions.rs'), 'utf-8')
    const m = rust.match(/const SQL_GAP: &str =\s*r"(.*?)";/s)
    expect(m, 'SQL_GAP not found in actions.rs').not.toBeNull()
    expect(SQL_GAP).toBe(m![1])
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
