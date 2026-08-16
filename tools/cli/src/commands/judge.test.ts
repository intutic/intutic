import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLiteLLMConfigYaml, runJudgeConfigure } from './judge.js'
import { CANCELLED, type SetupIO } from './setup.js'

class FakeIO implements SetupIO {
  calls: Array<{ method: string; arg: unknown }> = []
  private queue: unknown[]
  constructor(answers: unknown[]) { this.queue = [...answers] }
  private next(method: string, arg: unknown) {
    this.calls.push({ method, arg })
    if (this.queue.length === 0) throw new Error(`FakeIO: no scripted answer left for ${method}`)
    return this.queue.shift()
  }
  intro(msg: string) { this.calls.push({ method: 'intro', arg: msg }) }
  outro(msg: string) { this.calls.push({ method: 'outro', arg: msg }) }
  note(msg: string, title?: string) { this.calls.push({ method: 'note', arg: { msg, title } }) }
  log = {
    info: (msg: string) => this.calls.push({ method: 'log.info', arg: msg }),
    success: (msg: string) => this.calls.push({ method: 'log.success', arg: msg }),
    warn: (msg: string) => this.calls.push({ method: 'log.warn', arg: msg }),
    error: (msg: string) => this.calls.push({ method: 'log.error', arg: msg }),
  }
  async select<T extends string>(opts: { message: string }) { return this.next('select', opts.message) as T | typeof CANCELLED }
  async text(opts: { message: string }) { return this.next('text', opts.message) as string | typeof CANCELLED }
  async password(opts: { message: string }) { return this.next('password', opts.message) as string | typeof CANCELLED }
  async confirm(opts: { message: string }) { return this.next('confirm', opts.message) as boolean | typeof CANCELLED }
}

describe('buildLiteLLMConfigYaml', () => {
  it('matches the shape of infra/compose/litellm_config.yaml\'s hand-written example', () => {
    const yaml = buildLiteLLMConfigYaml('anthropic/claude-haiku-4-5')
    expect(yaml).toContain('model_list:')
    expect(yaml).toContain('  - model_name: claude-haiku-4-5')
    expect(yaml).toContain('    litellm_params:')
    expect(yaml).toContain('      model: anthropic/claude-haiku-4-5')
    expect(yaml).toContain('      api_key: os.environ/ANTHROPIC_API_KEY')
    expect(yaml).toContain('general_settings:')
    expect(yaml).toContain('  master_key: os.environ/LITELLM_MASTER_KEY')
  })

  it('a bare model name with no provider prefix omits the api_key line rather than guessing an env var', () => {
    const yaml = buildLiteLLMConfigYaml('my-local-alias')
    expect(yaml).toContain('model_name: my-local-alias')
    expect(yaml).toContain('model: my-local-alias')
    expect(yaml).not.toContain('api_key:')
  })

  it('an openrouter ref keeps its vendor/model tail intact', () => {
    const yaml = buildLiteLLMConfigYaml('openrouter/anthropic/claude-3-haiku')
    expect(yaml).toContain('model: openrouter/anthropic/claude-3-haiku')
    expect(yaml).toContain('api_key: os.environ/OPENROUTER_API_KEY')
  })
})

describe('runJudgeConfigure', () => {
  let tmpDir: string
  let outPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intutic-judge-test-'))
    outPath = join(tmpDir, 'litellm_config.yaml')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('picking a catalog model writes the config, prints env + Helm notes, and never calls a remote API', async () => {
    const io = new FakeIO(['anthropic/claude-haiku-4-5'])
    await runJudgeConfigure({ out: outPath }, io)

    const written = readFileSync(outPath, 'utf-8')
    expect(written).toContain('model: anthropic/claude-haiku-4-5')

    const envNote = io.calls.find((c) => c.method === 'note' && (c.arg as { title?: string }).title === 'Environment')
    expect(String((envNote?.arg as { msg?: string })?.msg)).toContain('LITELLM_LOCAL_JUDGE_MODEL=claude-haiku-4-5')

    const helmNote = io.calls.find((c) => c.method === 'note' && (c.arg as { title?: string }).title === 'Helm values')
    expect(String((helmNote?.arg as { msg?: string })?.msg)).toContain('localJudge: true')
  })

  it('a custom (non-catalog) model reference is accepted with a warning, not refused', async () => {
    const CUSTOM = '__custom__'
    const io = new FakeIO([CUSTOM, 'my-org/local-qwen-judge'])
    await runJudgeConfigure({ out: outPath }, io)

    expect(io.calls.some((c) => c.method === 'log.warn' && String(c.arg).includes('not in the known model catalog'))).toBe(true)
    const written = readFileSync(outPath, 'utf-8')
    expect(written).toContain('model: my-org/local-qwen-judge')
  })

  it('cancelling the model selection writes nothing', async () => {
    const io = new FakeIO([CANCELLED])
    await runJudgeConfigure({ out: outPath }, io)
    expect(() => readFileSync(outPath, 'utf-8')).toThrow()
  })
})
