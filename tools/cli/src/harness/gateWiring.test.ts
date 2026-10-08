/**
 * gateWiring.test.ts — `intutic connect` installs each harness's gate.
 *
 * The gate writers for Codex, GitHub Copilot, Continue, Antigravity, Open
 * WebUI and n8n were only ever called from the sync daemon's own loop, which
 * nothing in production runs: the installed service runs `intutic connect`,
 * which calls these adapters. So those gates were never installed. Each case
 * below drives the adapter exactly as connect does (`writeHarnessConfigs`)
 * and checks the gate is on disk where the harness reads it.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeHarnessConfigs } from '../commands/connect.js'

const PROXY_URL = 'http://127.0.0.1:4000'

describe('harness adapters install their gates', () => {
  let root: string
  let home: string
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, N8N_URL: process.env.N8N_URL }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-wiring-'))
    home = await mkdtemp(join(tmpdir(), 'intutic-wiring-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.CODEX_HOME
    // Nothing listens here, so the n8n REST sync fails fast and the test
    // exercises only the local gate write.
    process.env.N8N_URL = 'http://127.0.0.1:9'
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  /** What `intutic connect` does for one harness, with one rule set targeting it. */
  function connectAs(harness: string): Promise<number> {
    const sops = [{ sopId: 'sop_1', title: 'No secrets', content: 'Never commit keys.', contentHash: '', harnessTargets: [harness] }] as never
    return writeHarnessConfigs([harness], root, sops, PROXY_URL, false)
  }

  it('codex: registers the gate in both hooks.json files and merges openai_base_url into the user config', async () => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.fs]\ncommand = "mcp-fs"\n')

    await connectAs('codex')

    for (const hooksJson of [join(root, '.codex', 'hooks.json'), join(home, '.codex', 'hooks.json')]) {
      expect(await readFile(hooksJson, 'utf-8')).toContain('codex-check.js')
    }
    const config = await readFile(join(home, '.codex', 'config.toml'), 'utf-8')
    expect(config).toContain(`openai_base_url = "${PROXY_URL}/v1"`)
    expect(config).toContain('[mcp_servers.fs]\ncommand = "mcp-fs"\n')

    const env = await readFile(join(root, '.env.intutic'), 'utf-8')
    expect(env).toContain(`export ANTHROPIC_BASE_URL="${PROXY_URL}"`)
    expect(env).toContain(`export OPENAI_BASE_URL="${PROXY_URL}/v1"`)
  })

  it('github-copilot: writes the workspace and user hook definitions', async () => {
    await connectAs('github-copilot')
    await access(join(root, '.github', 'hooks', 'intutic-governance.json'))
    await access(join(home, '.copilot', 'hooks', 'intutic-governance.json'))
    await access(join(root, '.github', 'copilot-instructions.md'))
  })

  it('continue: registers the cn gate and routes OpenAI/Anthropic models in config.yaml', async () => {
    await mkdir(join(home, '.continue'), { recursive: true })
    await writeFile(join(home, '.continue', 'config.yaml'), 'models:\n  - name: GPT\n    provider: openai\n    model: gpt-4o\n')

    await connectAs('continue')

    expect(await readFile(join(home, '.continue', 'config.yaml'), 'utf-8')).toContain(`apiBase: ${PROXY_URL}/v1/`)
    for (const settings of [join(root, '.continue', 'settings.json'), join(home, '.continue', 'settings.json')]) {
      expect(await readFile(settings, 'utf-8')).toContain('continue-check.js')
    }
  })

  it('antigravity: registers the BeforeTool gate in ~/.gemini/settings.json', async () => {
    await mkdir(join(root, '.gemini'), { recursive: true })
    await connectAs('antigravity')
    const settings = JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf-8'))
    expect(settings.hooks.BeforeTool[0].hooks[0].command).toContain('antigravity-check.sh')
  })

  it('open-webui: writes the filter an admin installs', async () => {
    await connectAs('open-webui')
    await access(join(home, '.open-webui', 'intutic-governance-filter.py'))
  })

  it('n8n: writes the external-hook gate even when the n8n API is unreachable', async () => {
    await connectAs('n8n')
    await access(join(home, '.intutic', 'hooks', 'n8n-governance-hook.js'))
    await access(join(home, '.intutic', 'n8n', 'INSTALL.md'))
  })

  it('cline: writes rules and the PreToolUse file hook into the .clinerules directory, and no VS Code settings', async () => {
    await connectAs('cline')
    await access(join(root, '.clinerules', 'intutic-governance.md'))
    expect((await stat(join(root, '.clinerules', 'hooks', 'PreToolUse'))).mode & 0o111).not.toBe(0)
    await expect(access(join(root, '.vscode', 'settings.json'))).rejects.toThrow()
  })

  it('roo-code: writes rules and leaves VS Code settings alone', async () => {
    await connectAs('roo-code')
    await access(join(root, '.roorules'))
    await expect(access(join(root, '.vscode', 'settings.json'))).rejects.toThrow()
  })
})
