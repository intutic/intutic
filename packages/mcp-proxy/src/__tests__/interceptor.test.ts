/**
 * interceptor.test.ts — Unit tests for the MCP governance proxy interceptor.
 *
 * Zero vi.mock — tests the actual decision engine with in-process policy stubs.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ToolCallInterceptor } from '../interceptor.js'
import { PolicyClient } from '../policy.js'
import type { SopRule } from '../policy.js'
import { GovernanceEmitter } from '../emitter.js'
import * as node_path from 'node:path'
import * as node_os from 'node:os'

// ─── Minimal in-process stub clients ─────────────────────────────────────────

class StubPolicyClient extends PolicyClient {
  private _rules: SopRule[] = []
  private _allowedServers: string[] = []

  constructor(rules: SopRule[] = [], allowedServers: string[] = []) {
    // Pass dummy values — we override getRules() and matchRule()
    super('http://localhost:0', '', 'test-ws', 60_000)
    this._rules = rules
    this._allowedServers = allowedServers
  }

  override getRules(): readonly SopRule[] {
    return this._rules
  }

  override getAllowedServers(): readonly string[] {
    return this._allowedServers
  }

  override matchRule(toolName: string, toolInputJson: string): SopRule | null {
    for (const rule of this._rules) {
      try {
        if (!new RegExp(rule.toolPattern).test(toolName)) continue
        if (rule.argPattern && !new RegExp(rule.argPattern).test(toolInputJson)) continue
        return rule
      } catch {
        continue
      }
    }
    return null
  }

  override start(): void { /* no-op */ }
  override stop(): void { /* no-op */ }
  override async refresh(): Promise<void> { /* no-op */ }
}

class StubEmitter extends GovernanceEmitter {
  readonly emitted: Array<{ kind: string; toolName: string; toolInput: unknown; reason?: string }> = []

  constructor() {
    super('http://localhost:0', '', node_path.join(node_os.homedir(), '.intutic-test', 'events.jsonl'), 'test-ws')
  }

  override emit(kind: 'tool_allowed' | 'tool_blocked' | 'tool_redacted', toolName: string, toolInput: unknown, reason?: string): void {
    this.emitted.push({ kind, toolName, toolInput, reason })
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolCallInterceptor', () => {
  let emitter: StubEmitter

  beforeEach(() => {
    emitter = new StubEmitter()
  })

  describe('DLP scanning', () => {
    it('blocks tool calls containing OpenAI API keys', async () => {
      const policy = new StubPolicyClient()
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Bash', { command: 'echo sk-abc123def456ghi789jkl012mno345pqr' })
      expect(decision.action).toBe('block')
      expect(emitter.emitted).toHaveLength(1)
      expect(emitter.emitted[0]?.kind).toBe('tool_blocked')
    })

    it('blocks tool calls containing Anthropic API keys', async () => {
      const policy = new StubPolicyClient()
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Write', { content: 'key=sk-ant-api03-verylongantkeyhere12345678901234' })
      expect(decision.action).toBe('block')
    })

    it('blocks rm -rf / commands', async () => {
      const policy = new StubPolicyClient()
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Bash', { command: 'rm -rf /' })
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('Destructive')
    })

    it('blocks SQL DROP TABLE', async () => {
      const policy = new StubPolicyClient()
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('mcp__database__execute', { query: 'DROP TABLE users' })
      expect(decision.action).toBe('block')
    })

    it('allows benign tool calls with no DLP match', async () => {
      const policy = new StubPolicyClient()
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Read', { path: '/tmp/hello.txt' })
      expect(decision.action).toBe('allow')
      expect(emitter.emitted[0]?.kind).toBe('tool_allowed')
    })
  })

  describe('SOP policy rules', () => {
    it('blocks tool when matching block rule exists', async () => {
      const rules: SopRule[] = [{
        id: 'rule-1',
        toolPattern: 'Bash',
        action: 'block',
        reason: 'Bash execution not permitted in this workspace',
      }]
      const policy = new StubPolicyClient(rules)
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Bash', { command: 'ls -la' })
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('Bash execution')
    })

    it('allows tool when pattern does not match', async () => {
      const rules: SopRule[] = [{
        id: 'rule-1',
        toolPattern: 'Bash',
        action: 'block',
        reason: 'Bash blocked',
      }]
      const policy = new StubPolicyClient(rules)
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Read', { path: '/tmp/safe.txt' })
      expect(decision.action).toBe('allow')
    })

    it('blocks when arg pattern also matches', async () => {
      const rules: SopRule[] = [{
        id: 'rule-2',
        toolPattern: 'mcp__.*',
        argPattern: 'prod.*database',
        action: 'block',
        reason: 'Production database access blocked',
      }]
      const policy = new StubPolicyClient(rules)
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('mcp__postgres__query', { dsn: 'prod-us-east-1-database' })
      expect(decision.action).toBe('block')
    })

    it('allows when arg pattern does NOT match', async () => {
      const rules: SopRule[] = [{
        id: 'rule-2',
        toolPattern: 'mcp__.*',
        argPattern: 'prod.*database',
        action: 'block',
        reason: 'Production database access blocked',
      }]
      const policy = new StubPolicyClient(rules)
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('mcp__postgres__query', { dsn: 'dev-local-db' })
      expect(decision.action).toBe('allow')
    })

    it('treats require_approval as block (headless proxy)', async () => {
      const rules: SopRule[] = [{
        id: 'rule-3',
        toolPattern: 'Write',
        action: 'require_approval',
        reason: 'File writes require review',
      }]
      const policy = new StubPolicyClient(rules)
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Write', { path: '/etc/passwd', content: 'test' })
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('human approval')
    })
  })

  describe('server-level allowlist (mcpAllowedServers)', () => {
    it('empty/absent list is unrestricted — a call through any server is allowed', async () => {
      const policy = new StubPolicyClient([], [])
      const interceptor = new ToolCallInterceptor(policy, emitter, true, 'any-server-name')

      const decision = await interceptor.decide('Read', { path: '/tmp/hello.txt' })
      expect(decision.action).toBe('allow')
    })

    it('a non-empty list refuses a server not on it', async () => {
      const policy = new StubPolicyClient([], ['github', 'filesystem'])
      const interceptor = new ToolCallInterceptor(policy, emitter, true, 'some-other-server')

      const decision = await interceptor.decide('Read', { path: '/tmp/hello.txt' })
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('some-other-server')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('mcpAllowedServers')
      expect(emitter.emitted[0]?.kind).toBe('tool_blocked')
    })

    it('a non-empty list allows a server that IS on it', async () => {
      const policy = new StubPolicyClient([], ['github', 'filesystem'])
      const interceptor = new ToolCallInterceptor(policy, emitter, true, 'filesystem')

      const decision = await interceptor.decide('Read', { path: '/tmp/hello.txt' })
      expect(decision.action).toBe('allow')
    })

    it('the server-allowlist refusal is unconditional — NOT relaxed by failOpen=true', async () => {
      // Same shape as the tool-level allowlist immediately below in this
      // file: an explicit, non-empty allowlist that excludes this server is
      // a definite policy decision the proxy already has the data to make,
      // not a "control plane unreachable" failure mode — so it refuses
      // regardless of mcpProxyFailBehavior. A control-plane OUTAGE still
      // fails open naturally, because an unreachable fetch leaves
      // getAllowedServers() empty, which reads as unrestricted.
      const policy = new StubPolicyClient([], ['only-this-one'])
      const interceptor = new ToolCallInterceptor(policy, emitter, true, 'not-this-one')

      const decision = await interceptor.decide('Read', { path: '/tmp/hello.txt' })
      expect(decision.action).toBe('block')
    })

    it('defaults to serverName "unknown" when the interceptor is constructed without one', async () => {
      const policy = new StubPolicyClient([], ['approved-server'])
      const interceptor = new ToolCallInterceptor(policy, emitter, true)

      const decision = await interceptor.decide('Read', { path: '/tmp/hello.txt' })
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('unknown')
    })
  })

  describe('fail-open behavior', () => {
    it('allows when policy client throws (failOpen=true)', async () => {
      const policy = new StubPolicyClient()
      // Override matchRule to throw — simulates policy engine failure
      policy.matchRule = () => { throw new Error('Policy engine down') }

      const interceptor = new ToolCallInterceptor(policy, emitter, true)
      const decision = await interceptor.decide('Read', { path: '/tmp/ok.txt' })
      expect(decision.action).toBe('allow')
    })
  })

  describe('fail-closed behavior', () => {
    it('blocks when policy client throws (failOpen=false)', async () => {
      const policy = new StubPolicyClient()
      policy.matchRule = () => { throw new Error('Policy engine down') }

      const interceptor = new ToolCallInterceptor(policy, emitter, false)
      const decision = await interceptor.decide('Read', { path: '/tmp/ok.txt' })
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('control plane unreachable')
    })

    it('blocks when DLP scan throws (failOpen=false)', async () => {
      const policy = new StubPolicyClient()
      const interceptor = new ToolCallInterceptor(policy, emitter, false)

      // Circular references cause JSON.stringify / scanning to throw or error
      // A self-referencing object needs a type that can hold itself. `any` was
      // hiding that this is expressible.
      type Circular = { self?: Circular }
      const circular: Circular = {}
      circular.self = circular

      const decision = await interceptor.decide('Read', circular)
      expect(decision.action).toBe('block')
      expect((decision as { action: 'block'; reason: string }).reason).toContain('control plane unreachable')
    })
  })
})
