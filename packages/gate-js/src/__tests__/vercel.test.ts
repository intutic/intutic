/**
 * Tests for `@intutic/gate/vercel`.
 *
 * `ai` and `@ai-sdk/openai` ARE installed as devDependencies (see
 * package.json) and their real exported types are imported below to
 * structurally confirm `intuticToolApproval()` is assignable to the real
 * `toolApproval` option `generateText`/`streamText` accept, and that
 * `withIntuticProxy(createOpenAI)` is assignable where a provider factory is
 * expected — compile-time checks (TypeScript rejects the file if the real
 * shapes drift), not live API calls. No network call or live SDK loop is
 * exercised; the runtime behaviour under test is this adapter's own
 * functions against a `FakeGate`, matching `wrapTools.test.ts`'s style.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { IntuticGateRefusal } from '../errors.js'
import { Gate, install } from '../gate.js'
import { intuticProxyUrl, intuticToolApproval, withIntuticProxy } from '../vercel.js'

class FakeGate extends Gate {
  calls: Array<{ toolName: string; toolInput: Record<string, unknown> }> = []
  private readonly refuse: boolean
  constructor(refuse = false) {
    super({ enforce: true })
    this.refuse = refuse
  }
  override async guard(toolName: string, toolInput: Record<string, unknown>): Promise<void> {
    this.calls.push({ toolName, toolInput })
    if (this.refuse) throw new IntuticGateRefusal('nope', 'TEST')
  }
}

afterEach(() => {
  install(null)
  delete process.env.INTUTIC_PROXY_URL
})

// ------------------------------------------------------------------------
// Structural type checks. Never invoked — a drift in `ai`'s real
// `toolApproval`/provider-factory shapes fails `tsc`/vitest's type-checking
// pass here, not at a caller's compile time.
// ------------------------------------------------------------------------
function _typeCheckOnly(): void {
  type GenerateTextOptions = Parameters<typeof generateText>[0]
  const approval = intuticToolApproval()
  const _opts: Pick<GenerateTextOptions, 'toolApproval'> = { toolApproval: approval }
  void _opts

  const proxiedOpenAI = withIntuticProxy(createOpenAI)({ apiKey: 'x' })
  void proxiedOpenAI
}

describe('intuticToolApproval: allow path', () => {
  it("calls the gate, then resolves 'not-applicable'", async () => {
    const gate = new FakeGate()
    const approval = intuticToolApproval({ gate })
    const status = await approval({ toolCall: { toolName: 'read_file', input: { path: 'a.txt' } } })
    expect(status).toBe('not-applicable')
    expect(gate.calls).toEqual([{ toolName: 'read_file', toolInput: { path: 'a.txt' } }])
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate()
    install(gate)
    const approval = intuticToolApproval()
    await approval({ toolCall: { toolName: 'noop', input: {} } })
    expect(gate.calls).toHaveLength(1)
  })
})

describe('intuticToolApproval: refusal path', () => {
  it("resolves {type:'denied', reason} on refusal", async () => {
    const gate = new FakeGate(true)
    const approval = intuticToolApproval({ gate })
    const status = await approval({ toolCall: { toolName: 'shell', input: { command: 'rm -rf /' } } })
    expect(status).toEqual({
      type: 'denied',
      reason: expect.stringContaining('[Intutic Governance] BLOCKED:'),
    })
  })

  it('re-throws a non-refusal error rather than treating it as a denial', async () => {
    class ExplodingGate extends Gate {
      override async guard(): Promise<void> {
        throw new Error('boom')
      }
    }
    const approval = intuticToolApproval({ gate: new ExplodingGate({ enforce: true }) })
    await expect(approval({ toolCall: { toolName: 'x', input: {} } })).rejects.toThrow('boom')
  })
})

describe('intuticToolApproval: no gate configured', () => {
  it('throws a clear error rather than running unguarded', async () => {
    const approval = intuticToolApproval()
    await expect(approval({ toolCall: { toolName: 'x', input: {} } })).rejects.toThrow(/No gate configured/)
  })
})

describe('intuticProxyUrl', () => {
  it('defaults to http://localhost:4000', () => {
    delete process.env.INTUTIC_PROXY_URL
    expect(intuticProxyUrl()).toBe('http://localhost:4000')
  })

  it('honours INTUTIC_PROXY_URL', () => {
    process.env.INTUTIC_PROXY_URL = 'http://127.0.0.1:4000'
    expect(intuticProxyUrl()).toBe('http://127.0.0.1:4000')
  })
})

describe('withIntuticProxy', () => {
  it('injects the resolved proxy URL as baseURL, preserving other options', () => {
    let seen: { apiKey?: string; baseURL?: string } | undefined
    const factory = (options: { apiKey?: string; baseURL?: string }) => {
      seen = options
      return { model: 'stub' }
    }
    withIntuticProxy(factory, 'http://127.0.0.1:4000')({ apiKey: 'sk-test' })
    expect(seen).toEqual({ apiKey: 'sk-test', baseURL: 'http://127.0.0.1:4000' })
  })

  it('resolves the proxy URL from the environment when no override is given', () => {
    process.env.INTUTIC_PROXY_URL = 'http://127.0.0.1:9999'
    let seen: { baseURL?: string } | undefined
    withIntuticProxy((options: { baseURL?: string }) => {
      seen = options
      return {}
    })({})
    expect(seen?.baseURL).toBe('http://127.0.0.1:9999')
  })

  it('a real @ai-sdk/openai provider factory accepts the wrapped call (structural, not a network call)', () => {
    const openai = withIntuticProxy(createOpenAI, 'http://127.0.0.1:4000')({ apiKey: 'sk-test' })
    expect(typeof openai).toBe('function')
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
