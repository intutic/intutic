import { describe, expect, it } from 'vitest'
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
