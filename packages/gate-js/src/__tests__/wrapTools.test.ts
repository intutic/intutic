import { afterEach, describe, expect, it } from 'vitest'
import { IntuticGateRefusal } from '../errors.js'
import { active, Gate, install } from '../gate.js'
import { wrapTool, wrapTools } from '../wrapTools.js'

// A stand-in Gate whose `guard` is fully controllable, so these tests exercise
// wrapTool/wrapTools' plumbing without touching the filesystem or network.
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
})

describe('wrapTool: plain function', () => {
  it('calls the gate before the real implementation, then runs it', async () => {
    const gate = new FakeGate()
    const fn = async (input: { command: string }) => `ran:${input.command}`
    const wrapped = wrapTool(fn, { name: 'shell', gate })
    const result = await wrapped({ command: 'ls' })
    expect(result).toBe('ran:ls')
    expect(gate.calls).toEqual([{ toolName: 'shell', toolInput: { command: 'ls' } }])
  })

  it('propagates IntuticGateRefusal and never calls the real implementation', async () => {
    const gate = new FakeGate(true)
    let ran = false
    const fn = async () => {
      ran = true
      return 'should not happen'
    }
    const wrapped = wrapTool(fn, { name: 'shell', gate })
    await expect(wrapped({ command: 'rm -rf /' })).rejects.toThrow(IntuticGateRefusal)
    expect(ran).toBe(false)
  })

  it('falls back to the process-wide installed gate', async () => {
    const gate = new FakeGate()
    install(gate)
    const fn = async (input: { x: number }) => input.x + 1
    const wrapped = wrapTool(fn, { name: 'add' })
    expect(await wrapped({ x: 1 })).toBe(2)
    expect(active()).toBe(gate)
  })

  it('throws a clear error when no gate is configured', async () => {
    const fn = async () => 'x'
    const wrapped = wrapTool(fn, { name: 'noop' })
    await expect(wrapped()).rejects.toThrow(/No gate configured/)
  })

  it('does not double-wrap an already-guarded function', () => {
    const gate = new FakeGate()
    const fn = async () => 'x'
    const once = wrapTool(fn, { name: 'a', gate })
    const twice = wrapTool(once, { name: 'a', gate })
    expect(twice).toBe(once)
  })
})

describe('wrapTool: {execute} tool object', () => {
  it('wraps execute in place and preserves other fields', async () => {
    const gate = new FakeGate()
    const tool = {
      name: 'kubectl_apply',
      description: 'applies a manifest',
      execute: async (input: { command: string }) => `applied:${input.command}`,
    }
    const wrapped = wrapTool(tool, { gate })
    expect(wrapped.description).toBe('applies a manifest')
    expect(await wrapped.execute({ command: 'kubectl apply -f x.yaml' })).toBe(
      'applied:kubectl apply -f x.yaml',
    )
    expect(gate.calls[0]!.toolName).toBe('kubectl_apply')
  })

  it('rejects an object with no callable execute', () => {
    expect(() => wrapTool({ name: 'bad' } as never)).toThrow(TypeError)
  })
})

describe('wrapTools: collections', () => {
  it('wraps an array using each tool own name', async () => {
    const gate = new FakeGate()
    const tools = [
      { name: 'a', execute: async () => 'a-ran' },
      { name: 'b', execute: async () => 'b-ran' },
    ]
    const [a, b] = wrapTools(tools, gate)
    await a!.execute({})
    await b!.execute({})
    expect(gate.calls.map((c) => c.toolName)).toEqual(['a', 'b'])
  })

  it('wraps a record keyed by tool name, using the key as the gate name', async () => {
    const gate = new FakeGate()
    const tools = {
      myTool: { description: 'd', execute: async (input: { x: number }) => input.x },
    }
    const wrapped = wrapTools(tools, gate)
    await wrapped.myTool!.execute({ x: 5 })
    expect(gate.calls[0]!.toolName).toBe('myTool')
  })
})
