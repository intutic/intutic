/**
 * Tests for `@intutic/gate/vercel`.
 *
 * `ai` and `@ai-sdk/openai` ARE installed as devDependencies (see
 * package.json) and their real exported types are imported below to
 * structurally confirm `intuticToolApproval()` is assignable to the real
 * `toolApproval` option `generateText`/`streamText` accept, and that
 * `withIntuticProxy(createOpenAI)` is assignable where a provider factory is
 * expected — compile-time checks (TypeScript rejects the file if the real
 * shapes drift), not live API calls. Most of this file's runtime behaviour
 * is this adapter's own functions against a `FakeGate`, matching
 * `wrapTools.test.ts`'s style.
 *
 * TD-381 closer: the "real ai generateText() integration" block below drives
 * the REAL `generateText()` — the `ai` package's actual dispatch loop, not a
 * mocked-out one — with a stub `LanguageModelV4` (`MockLanguageModelV4` from
 * `ai/test`, also a real devDependency) that emits a tool call. No API key,
 * no network. Confirmed by reading `ai@7.0.68`'s compiled
 * `dist/index.js`: `generateText`'s step loop calls `resolveToolApproval()`
 * for every tool call the model emits, and on a `'denied'` status adds the
 * call's id to `blockedToolCallIds`, which `executeTools()` is filtered
 * against — the tool's real body genuinely never runs on a denial, the same
 * mechanism `resolveToolApproval` also drives for `streamText`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { generateText, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
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

// ------------------------------------------------------------------------
// REAL `ai` generateText() integration — no API key, no network: a stub
// LanguageModelV4 (MockLanguageModelV4 from `ai/test`) replays a canned tool
// call and the real `generateText()` dispatch loop does everything else
// (tool resolution, toolApproval resolution, tool execution). Closes
// TD-381's "what would close this" gap for the Vercel AI SDK half.
// ------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [
      { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: USAGE,
  }
}

function deleteTool(onExecute: () => void) {
  return tool({
    description: 'Deletes everything',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }: { path: string }) => {
      onExecute()
      return { deleted: true, path }
    },
  })
}

describe('real ai generateText() integration', () => {
  it('a denied tool call never executes; the real dispatch loop records the denial reason', async () => {
    const gate = new FakeGate(true)
    let executed = false
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult('call_1', 'delete_everything', { path: 'prod.db' })],
    })

    const result = await generateText({
      model,
      tools: { delete_everything: deleteTool(() => (executed = true)) },
      toolApproval: intuticToolApproval({ gate }),
      prompt: 'wipe it',
    })

    expect(executed).toBe(false)
    expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'prod.db' } }])
    // No tool result was produced for the blocked call — the real dispatch
    // loop skipped execution entirely, it did not run it and discard it.
    expect(result.toolResults).toHaveLength(0)
    // The denial reason from this adapter genuinely reached the real
    // generateText() step content (a tool-approval-response part).
    expect(JSON.stringify(result.content)).toContain('[Intutic Governance] BLOCKED: nope')
  })

  it('an allowed tool call executes untouched through the same real dispatch loop', async () => {
    const gate = new FakeGate(false)
    let executed = false
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult('call_1', 'delete_everything', { path: 'scratch.txt' })],
    })

    const result = await generateText({
      model,
      tools: { delete_everything: deleteTool(() => (executed = true)) },
      toolApproval: intuticToolApproval({ gate }),
      prompt: 'clean it up',
    })

    expect(executed).toBe(true)
    expect(gate.calls).toEqual([{ toolName: 'delete_everything', toolInput: { path: 'scratch.txt' } }])
    expect(result.toolResults).toHaveLength(1)
  })
})

// keep the type-check function reachable so it is not tree-shaken/flagged unused
void _typeCheckOnly
