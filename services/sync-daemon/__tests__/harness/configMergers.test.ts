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
import { mergePiModels, writePiHooks } from '../../src/harness/piHooks.js'
import { mergeOpenclawConfig, writeOpenclawHooks } from '../../src/harness/openclawHooks.js'
import { mergeHermesYaml } from '../../src/harness/hermesHooks.js'
import { mergeOpenHandsToml, mergeOpenHandsBaseUrl } from '../../src/harness/openhandsHooks.js'
import { mergeGooseConfigYaml } from '../../src/harness/gooseHooks.js'

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
  const WS = path.join(path.sep, 'work', 'project')
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
    const { content, stripped } = mergeAiderYaml(userConfig, 'http://127.0.0.1:4000', WS, true)
    expect(stripped.sort()).toEqual(['lint-cmd', 'test-cmd'])
    expect(content).toContain('# team settings')
    const parsed = parseYaml(content!) as Record<string, unknown>
    expect(parsed).toEqual({
      model: 'sonnet',
      read: ['CONVENTIONS.md', path.join(WS, AIDER_SOPS_FILE)],
      'set-env': ['FOO=bar', 'ANTHROPIC_BASE_URL=http://127.0.0.1:4000'],
      'openai-api-base': URL_V1,
    })
  })

  it('is idempotent and drops the SOP read entry when there are no SOPs', () => {
    const once = mergeAiderYaml(userConfig, 'http://127.0.0.1:4000', WS, true).content!
    expect(mergeAiderYaml(once, 'http://127.0.0.1:4000', WS, true).content).toBe(once)
    const parsed = parseYaml(mergeAiderYaml(once, 'http://127.0.0.1:4000', WS, false).content!) as Record<string, unknown>
    expect(parsed.read).toEqual(['CONVENTIONS.md'])
  })

  it('lists the SOP file by absolute path, since Aider resolves read entries against the directory it runs in', () => {
    // Earlier versions wrote the workspace-relative path, which Aider missed
    // when started from a subdirectory; it is replaced, not kept alongside.
    const legacy = 'model: sonnet\nread:\n  - CONVENTIONS.md\n  - .intutic/aider-sops.md\n'
    const parsed = parseYaml(mergeAiderYaml(legacy, 'http://127.0.0.1:4000', WS, true).content!) as Record<string, unknown>
    expect(parsed.read).toEqual(['CONVENTIONS.md', path.join(WS, AIDER_SOPS_FILE)])
    expect(path.isAbsolute((parsed.read as string[])[1]!)).toBe(true)
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

describe('Pi ~/.pi/agent', () => {
  let root: string
  const prevHome = process.env.HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-pi-'))
    process.env.HOME = root
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    await fs.rm(root, { recursive: true, force: true })
  })

  it('writes the extension where Pi discovers it and routes models.json there, not under ~/.pi', async () => {
    await writePiHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    const extension = await fs.readFile(path.join(root, '.pi', 'agent', 'extensions', 'intutic-governance.js'), 'utf-8')
    expect(extension).toContain('export default function intuticGovernance(pi)')
    expect(extension).toContain("pi.on('tool_call', toolCall)")
    const models = JSON.parse(await fs.readFile(path.join(root, '.pi', 'agent', 'models.json'), 'utf-8'))
    expect(models.providers.anthropic.baseUrl).toBe('http://127.0.0.1:4000')
    for (const unread of ['hooks.json', 'models.json']) {
      await expect(fs.access(path.join(root, '.pi', unread)), unread).rejects.toThrow()
    }
  })

  it('leaves a models.json that is not plain JSON untouched', async () => {
    const models = path.join(root, '.pi', 'agent', 'models.json')
    await fs.mkdir(path.dirname(models), { recursive: true })
    await fs.writeFile(models, '{ "providers": { // mine\n } }\n')
    await writePiHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    expect(await fs.readFile(models, 'utf-8')).toBe('{ "providers": { // mine\n } }\n')
  })
})

describe('OpenClaw ~/.openclaw/openclaw.json', () => {
  const PLUGIN = '/home/u/.intutic/hooks/openclaw/intutic-governance.cjs'
  let root: string
  const prevHome = process.env.HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-openclaw-'))
    process.env.HOME = root
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists the plugin in plugins.load.paths, keeping every other key, and does not stack', () => {
    const user = { agents: { defaults: { workspace: '~/a' } }, plugins: { load: { paths: ['~/mine.ts'] }, entries: { mine: { enabled: true } } } }
    const merged = mergeOpenclawConfig(user, PLUGIN)
    expect(merged).toEqual({
      agents: { defaults: { workspace: '~/a' } },
      plugins: { load: { paths: ['~/mine.ts', PLUGIN] }, entries: { mine: { enabled: true } } },
    })
    expect(mergeOpenclawConfig(merged, PLUGIN)).toEqual(merged)
  })

  it('adds the plugin id to a restrictive allowlist, and leaves an empty or absent one alone', () => {
    expect((mergeOpenclawConfig({ plugins: { allow: ['mine'] } }, PLUGIN).plugins as { allow: string[] }).allow).toEqual(['mine', 'intutic-governance'])
    expect((mergeOpenclawConfig({ plugins: { allow: [] } }, PLUGIN).plugins as { allow: string[] }).allow).toEqual([])
    expect((mergeOpenclawConfig({}, PLUGIN).plugins as Record<string, unknown>).allow).toBeUndefined()
  })

  it('writes the plugin and a JSON5 config with comments as JSON, the user keys kept', async () => {
    const config = path.join(root, '.openclaw', 'openclaw.json')
    await fs.mkdir(path.dirname(config), { recursive: true })
    await fs.writeFile(config, '{\n  // mine\n  "gateway": { "port": 18789 },\n}\n')
    await writeOpenclawHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    const plugin = path.join(root, '.intutic', 'hooks', 'openclaw', 'intutic-governance.cjs')
    expect(await fs.readFile(plugin, 'utf-8')).toContain("api.on('before_tool_call', beforeToolCall, { timeoutMs: 10000 })")
    expect(JSON.parse(await fs.readFile(config, 'utf-8'))).toEqual({ gateway: { port: 18789 }, plugins: { load: { paths: [plugin] } } })
  })

  it('leaves a config that does not parse untouched', async () => {
    const config = path.join(root, '.openclaw', 'openclaw.json')
    await fs.mkdir(path.dirname(config), { recursive: true })
    await fs.writeFile(config, '{ gateway: { port: 18789 } }\n')
    await writeOpenclawHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    expect(await fs.readFile(config, 'utf-8')).toBe('{ gateway: { port: 18789 } }\n')
  })
})

describe('Pi ~/.pi/agent/models.json', () => {
  it('gives each provider the base URL its SDK expects, leaves Google and other keys alone', () => {
    const merged = mergePiModels({
      providers: {
        anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
        google: { baseUrl: 'https://generativelanguage.googleapis.com' },
      },
      defaultModel: 'claude',
    }, 'http://127.0.0.1:4000')
    expect(merged.providers?.anthropic).toEqual({ apiKey: 'env:ANTHROPIC_API_KEY', baseUrl: 'http://127.0.0.1:4000' })
    expect(merged.providers?.openai).toEqual({ baseUrl: 'http://127.0.0.1:4000/v1' })
    expect(merged.providers?.google).toEqual({ baseUrl: 'https://generativelanguage.googleapis.com' })
    expect(merged.defaultModel).toBe('claude')
  })
})

describe('Hermes ~/.hermes/config.yaml', () => {
  it('registers a fail-closed pre_tool_call hook in place of the preToolUse key Hermes never read, keeping comments', () => {
    const config = '# mine\nmcp_servers:\n  fs:\n    command: mcp-fs\nhooks:\n  preToolUse:\n    command: /old/hermes-check.sh\n'
    const merged = mergeHermesYaml(config, '/home/u/.intutic/hooks/hermes-check.sh')!
    expect(merged).toContain('# mine')
    expect(parseYaml(merged)).toEqual({
      mcp_servers: { fs: { command: 'mcp-fs' } },
      hooks: { pre_tool_call: [{ command: '/home/u/.intutic/hooks/hermes-check.sh', timeout: 10, fail_closed: true }] },
    })
    expect(mergeHermesYaml(merged, '/home/u/.intutic/hooks/hermes-check.sh')).toBe(merged)
  })

  it('keeps the user\'s own pre_tool_call hooks and quotes a path with a space for shlex', () => {
    const config = 'hooks:\n  pre_tool_call:\n    - command: ~/.hermes/agent-hooks/scan.sh\n      fail_closed: true\n'
    const merged = parseYaml(mergeHermesYaml(config, '/home/my u/.intutic/hooks/hermes-check.sh')!)
    expect(merged.hooks.pre_tool_call).toEqual([
      { command: '~/.hermes/agent-hooks/scan.sh', fail_closed: true },
      { command: "'/home/my u/.intutic/hooks/hermes-check.sh'", timeout: 10, fail_closed: true },
    ])
  })

  it('leaves a pre_tool_call it would not know how to edit untouched', () => {
    expect(mergeHermesYaml('hooks:\n  pre_tool_call: nope\n', '/x/hermes-check.sh')).toBeNull()
  })

  it('leaves a file that does not parse untouched', () => {
    expect(mergeHermesYaml('hooks: [\n', '/x.sh')).toBeNull()
  })
})

describe('OpenHands config.toml', () => {
  const user = '# my openhands\n[core]\nworkspace_base = "./ws"\n\n[llm]\nmodel = "anthropic/claude-sonnet"\napi_key = "env"\n'

  it('sets [llm] base_url for the model\'s SDK, keeping everything else', () => {
    const merged = mergeOpenHandsToml(user, 'http://127.0.0.1:4000')!
    expect(merged.startsWith('# my openhands\n[core]')).toBe(true)
    const parsed = parseToml(merged) as Record<string, any>
    expect(parsed.core.workspace_base).toBe('./ws')
    expect(parsed.llm).toEqual({ base_url: 'http://127.0.0.1:4000', model: 'anthropic/claude-sonnet', api_key: 'env' })
    expect(Object.keys(parsed)).toEqual(['core', 'llm'])
    expect(mergeOpenHandsToml(merged, 'http://127.0.0.1:4000')).toBe(merged)
  })

  it('drops the [intutic] table earlier versions put the rules in, which OpenHands never reads', () => {
    const stale = `${user}\n[intutic]\nproxy_url = "http://127.0.0.1:4000"\ninstructions = """\n## Rule\n"""\n`
    expect(mergeOpenHandsToml(stale, 'http://127.0.0.1:4000')).toBe(mergeOpenHandsToml(user, 'http://127.0.0.1:4000'))
  })

  it('uses the OpenAI-style base for other models, regenerates the old overwrite, and leaves invalid TOML alone', () => {
    const openai = parseToml(mergeOpenHandsToml('[llm]\nmodel = "gpt-4o"\n', 'http://h:4000')!) as Record<string, any>
    expect(openai.llm.base_url).toBe('http://h:4000/v1')
    const legacy = '# Intutic Governance Rules (auto-generated)\n[intutic]\nproxy_url = "x"\n'
    expect(Object.keys(parseToml(mergeOpenHandsToml(legacy, 'http://h:4000')!))).toEqual(['llm'])
    expect(mergeOpenHandsToml('[llm\n', 'http://h:4000')).toBeNull()
  })
})

describe('OpenHands base_url outside [llm]', () => {
  // The old text edit replaced the first `base_url =` line in the file,
  // whichever table held it.
  const user = '[llm.draft]\nmodel = "gpt-4o-mini"\nbase_url = "https://draft.example/v1"\n\n[llm]\nmodel = "gpt-4o"\n'

  it('sets only [llm] base_url and leaves a named llm table\'s own', () => {
    for (const merged of [mergeOpenHandsBaseUrl(user, 'http://h:4000')!, mergeOpenHandsToml(user, 'http://h:4000')!]) {
      const parsed = parseToml(merged) as Record<string, any>
      expect(parsed.llm.base_url).toBe('http://h:4000/v1')
      expect(parsed.llm.draft).toEqual({ model: 'gpt-4o-mini', base_url: 'https://draft.example/v1' })
    }
  })

  it('adds an [llm] table rather than editing another table\'s base_url', () => {
    const merged = mergeOpenHandsBaseUrl('[mcp]\nbase_url = "https://mcp.example"\n', 'http://h:4000')!
    const parsed = parseToml(merged) as Record<string, any>
    expect(parsed.mcp.base_url).toBe('https://mcp.example')
    expect(parsed.llm.base_url).toBe('http://h:4000/v1')
    expect(mergeOpenHandsBaseUrl(merged, 'http://h:4000')).toBe(merged)
  })

  it('leaves a file that is not TOML alone', () => {
    expect(mergeOpenHandsBaseUrl('[llm\n', 'http://h:4000')).toBeNull()
  })
})

describe('Goose config.yaml', () => {
  const script = '/home/u/.agents/plugins/intutic-governance/scripts/intutic-check.sh'

  it('sets provider.host and hooks.pre_tool_use, and no other host or hook key', () => {
    // The old text edit replaced the first `host:` line and the first
    // `pre_tool_use:` line in the file, whichever key held them.
    const user =
      '# mine\nextensions:\n  search:\n    host: https://search.example\n    pre_tool_use: keep-me\n' +
      'provider:\n  name: openai\n  host: https://api.openai.com\n'
    const merged = mergeGooseConfigYaml(user, 'http://127.0.0.1:4000', script)!
    const parsed = parseYaml(merged)
    expect(parsed.extensions.search).toEqual({ host: 'https://search.example', pre_tool_use: 'keep-me' })
    expect(parsed.provider).toEqual({ name: 'openai', host: 'http://127.0.0.1:4000' })
    expect(parsed.hooks).toEqual({ pre_tool_use: script })
    expect(merged.startsWith('# mine\n')).toBe(true)
    expect(mergeGooseConfigYaml(merged, 'http://127.0.0.1:4000', script)).toBe(merged)
  })

  it('writes both keys into an empty file, and keeps the host when no proxy URL is given', () => {
    expect(parseYaml(mergeGooseConfigYaml('', 'http://h:4000', script)!)).toEqual({
      provider: { host: 'http://h:4000' },
      hooks: { pre_tool_use: script },
    })
    const kept = parseYaml(mergeGooseConfigYaml('provider:\n  host: http://h:4000\n', '', script)!)
    expect(kept.provider.host).toBe('http://h:4000')
  })

  it('leaves a file it cannot merge into alone', () => {
    expect(mergeGooseConfigYaml('provider: [unclosed\n', 'http://h:4000', script)).toBeNull()
    expect(mergeGooseConfigYaml('- a list\n', 'http://h:4000', script)).toBeNull()
    expect(mergeGooseConfigYaml('provider: openai\n', 'http://h:4000', script)).toBeNull()
  })
})
