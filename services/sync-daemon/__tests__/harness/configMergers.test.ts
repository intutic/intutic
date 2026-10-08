/**
 * configMergers.test.ts — the writers that add Intutic routing to a file the
 * user owns keep everything else in it.
 *
 * Each of these used to destroy user content: Codex's config.toml was
 * replaced whole with two provider tables (one of them a reserved id Codex
 * ignores), Continue's config.yaml got a line-based injection at the wrong
 * indent, and Aider's config was flattened through a hand-rolled parser that
 * dropped lists and nested values and wrote two keys Aider rejects at startup.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { setCodexOpenaiBaseUrl, mergeCodexConfig } from '../../src/harness/codexConfigMerger.js'
import { setContinueApiBase } from '../../src/harness/continueConfigMerger.js'
import { mergeAiderYaml, mergeAiderConfig, AIDER_SOPS_FILE } from '../../src/harness/aiderConfigMerger.js'
import { writeAntigravityHooks } from '../../src/harness/antigravityHooks.js'
import { writeCodexHooks } from '../../src/harness/codexHooks.js'

const URL_V1 = 'http://127.0.0.1:4000/v1'

describe('Codex config.toml — openai_base_url', () => {
  const userConfig = [
    '# my settings',
    'model = "gpt-5"',
    '',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "server-github"]',
    '',
    '[profiles.fast]',
    'model = "gpt-5-mini"',
    '',
  ].join('\n')

  it('adds the key at top level and keeps MCP servers, profiles and comments byte for byte', () => {
    const next = setCodexOpenaiBaseUrl(userConfig, URL_V1)!
    expect(next.endsWith(userConfig)).toBe(true)
    const parsed = parseToml(next) as Record<string, any>
    expect(parsed.openai_base_url).toBe(URL_V1)
    expect(parsed.mcp_servers.github.command).toBe('npx')
    expect(parsed.profiles.fast.model).toBe('gpt-5-mini')
  })

  it('replaces an existing top-level value, ignores a same-named key inside a table, and is idempotent', () => {
    const withKey = 'openai_base_url = "https://old"\n\n[profiles.x]\nopenai_base_url = "keep-me"\n'
    const next = setCodexOpenaiBaseUrl(withKey, URL_V1)!
    const parsed = parseToml(next) as Record<string, any>
    expect(parsed.openai_base_url).toBe(URL_V1)
    expect(parsed.profiles.x.openai_base_url).toBe('keep-me')
    expect(setCodexOpenaiBaseUrl(next, URL_V1)).toBe(next)
  })

  it('regenerates the file the old adapter wrote over the user config, dropping the reserved openai table', () => {
    const legacy = '# Intutic proxy config (auto-generated)\n# DO NOT EDIT\n\n[model_providers.litellm]\nbase_url = "x"\n\n[model_providers.openai]\nbase_url = "x"\n'
    const parsed = parseToml(setCodexOpenaiBaseUrl(legacy, URL_V1)!) as Record<string, unknown>
    expect(parsed).toEqual({ openai_base_url: URL_V1 })
  })

  it('leaves a config that is not valid TOML untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-codex-cfg-'))
    try {
      const file = path.join(dir, 'config.toml')
      await fs.writeFile(file, 'model = "gpt-5\n')
      expect(await mergeCodexConfig(file, URL_V1)).toBe(false)
      expect(await fs.readFile(file, 'utf-8')).toBe('model = "gpt-5\n')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Codex hooks.json — never replaced when it does not parse', () => {
  it('leaves a malformed user-level hooks.json alone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-codex-hooks-'))
    const prevHome = process.env.HOME
    const prevCodexHome = process.env.CODEX_HOME
    try {
      process.env.HOME = root
      delete process.env.CODEX_HOME
      await fs.mkdir(path.join(root, '.codex'), { recursive: true })
      const broken = '{ "hooks": { "PreToolUse": [ ], }\n'
      await fs.writeFile(path.join(root, '.codex', 'hooks.json'), broken)
      await writeCodexHooks(root, 'http://127.0.0.1:4000', 'ws_test')
      // The project file and the user file are the same path here
      // (HOME == root), so one malformed file stands for both.
      expect(await fs.readFile(path.join(root, '.codex', 'hooks.json'), 'utf-8')).toBe(broken)
    } finally {
      process.env.HOME = prevHome
      if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('Continue config.yaml — apiBase', () => {
  const config = [
    'name: my assistant',
    'version: 1.0.0',
    'models:',
    '  # cloud model',
    '  - name: GPT',
    '    provider: openai',
    '    model: gpt-4o',
    '  - name: Claude',
    '    provider: anthropic',
    '    model: claude-sonnet',
    '  - name: Local',
    '    provider: ollama',
    '    model: llama3',
    'context:',
    '  - provider: code',
    '',
  ].join('\n')

  it('routes only OpenAI and Anthropic models, with a trailing slash, keeping comments and other keys', () => {
    const result = setContinueApiBase(config, URL_V1)
    expect(result.routed).toBe(2)
    expect(result.content).toContain('# cloud model')
    const parsed = parseYaml(result.content!) as { models: Array<Record<string, string>>; context: unknown[] }
    expect(parsed.models[0].apiBase).toBe(`${URL_V1}/`)
    expect(parsed.models[1].apiBase).toBe(`${URL_V1}/`)
    expect(parsed.models[2].apiBase).toBeUndefined()
    expect(parsed.context).toEqual([{ provider: 'code' }])
  })

  it('leaves a file with no models, or one that does not parse, untouched', () => {
    expect(setContinueApiBase('name: x\n', URL_V1).content).toBeNull()
    expect(setContinueApiBase('models: [\n', URL_V1)).toMatchObject({ content: null, skipped: 'unparseable' })
  })
})

describe('Aider .aider.conf.yml', () => {
  const userConfig = [
    '# team settings',
    'model: sonnet',
    'read:',
    '  - CONVENTIONS.md',
    'set-env:',
    '  - FOO=bar',
    'lint-cmd:',
    '  - "python: flake8"',
    'test-cmd: pytest',
    'extra-instructions: legacy',
    'anthropic-api-base: http://old',
    '',
  ].join('\n')

  it('keeps lists and comments, strips auto-exec and invalid legacy keys, and writes only real Aider options', () => {
    const { content, stripped } = mergeAiderYaml(userConfig, 'http://127.0.0.1:4000', true)
    expect(stripped.sort()).toEqual(['lint-cmd', 'test-cmd'])
    expect(content).toContain('# team settings')
    const parsed = parseYaml(content!) as Record<string, unknown>
    expect(parsed).toEqual({
      model: 'sonnet',
      read: ['CONVENTIONS.md', AIDER_SOPS_FILE],
      'set-env': ['FOO=bar', 'ANTHROPIC_BASE_URL=http://127.0.0.1:4000'],
      'openai-api-base': URL_V1,
    })
  })

  it('is idempotent and drops the SOP read entry when there are no SOPs', () => {
    const once = mergeAiderYaml(userConfig, 'http://127.0.0.1:4000', true).content!
    expect(mergeAiderYaml(once, 'http://127.0.0.1:4000', true).content).toBe(once)
    const parsed = parseYaml(mergeAiderYaml(once, 'http://127.0.0.1:4000', false).content!) as Record<string, unknown>
    expect(parsed.read).toEqual(['CONVENTIONS.md'])
  })

  it('writes the SOP file next to the config and leaves an unparseable config untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-aider-'))
    try {
      const file = path.join(dir, '.aider.conf.yml')
      expect(await mergeAiderConfig(file, 'http://127.0.0.1:4000', '## No secrets')).toBe(true)
      expect(await fs.readFile(path.join(dir, AIDER_SOPS_FILE), 'utf-8')).toContain('No secrets')

      await fs.writeFile(file, 'model: [unclosed\n')
      expect(await mergeAiderConfig(file, 'http://127.0.0.1:4000')).toBe(false)
      expect(await fs.readFile(file, 'utf-8')).toBe('model: [unclosed\n')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Antigravity (Gemini CLI) ~/.gemini/settings.json', () => {
  let root: string
  const prevHome = process.env.HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-gemini-'))
    process.env.HOME = root
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    await fs.rm(root, { recursive: true, force: true })
  })

  it('registers the gate under hooks.BeforeTool, keeps user settings and hooks, drops the old preTool key, and does not stack', async () => {
    const settingsPath = path.join(root, '.gemini', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({
      theme: 'dark',
      hooks: { preTool: '/old/path.sh', BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    }))

    await writeAntigravityHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    await writeAntigravityHooks(root, 'http://127.0.0.1:4000', 'ws_test')

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(settings.theme).toBe('dark')
    expect(settings.hooks.preTool).toBeUndefined()
    expect(settings.hooks.BeforeTool).toHaveLength(2)
    expect(settings.hooks.BeforeTool[0].hooks[0].command).toBe('mine.sh')
    expect(settings.hooks.BeforeTool[1]).toMatchObject({ matcher: '.*' })
    expect(settings.hooks.BeforeTool[1].hooks[0].command).toContain('antigravity-check.sh')
  })

  it('leaves a settings.json that is not plain JSON untouched', async () => {
    const settingsPath = path.join(root, '.gemini', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const jsonc = '{\n  // comment\n  "theme": "dark"\n}\n'
    await fs.writeFile(settingsPath, jsonc)
    await writeAntigravityHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    expect(await fs.readFile(settingsPath, 'utf-8')).toBe(jsonc)
  })
})
