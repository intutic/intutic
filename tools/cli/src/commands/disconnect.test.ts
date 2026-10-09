/**
 * `intutic disconnect` round trips, one per harness: seed a machine with the
 * user's own config, run the writers `intutic connect` runs, disconnect, and
 * require every file and directory to be back exactly as it was. Then again
 * with an edit the user makes while connected, which must survive.
 *
 * The writers keep some paths in module-level constants computed from the
 * home directory at import time, so HOME is moved before anything is
 * imported (`vi.hoisted`) and every case shares that one fake home, emptied
 * between cases.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/intutic-disconnect-test-${process.pid}-${Date.now()}`.replace(/\/+/g, '/')
  process.env.HOME = `${base}/home`
  process.env.USERPROFILE = `${base}/home`
  delete process.env.XDG_CONFIG_HOME
  delete process.env.CODEX_HOME
  delete process.env.DSH_HOME
  delete process.env.PORT
  // Nothing listens on the discard port: the n8n adapter's API calls fail fast.
  process.env.N8N_URL = 'http://127.0.0.1:9'
  return { base, home: `${base}/home`, ws: `${base}/home/code/project` }
})

import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import { join, dirname, relative, extname } from 'node:path'
import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'
import {
  injectMcpServer,
  keepOriginal,
  noteProxyUrl,
  writeOwnedFile,
  planDisconnect,
  updatePreToolUseHooks,
  writeBundledSkills,
  writeDecisionsTargets,
} from '@intutic/sync-daemon'
import { getAdapter } from '../harness/detector.js'
import { runDisconnect } from './disconnect.js'

const PROXY = 'http://localhost:4000'
const LEGACY_DECISIONS = '<!-- INTUTIC:DECISIONS_LOG:START -->\n## Recent Governed Decisions\n\n- old entry\n<!-- INTUTIC:DECISIONS_LOG:END -->'
const SOPS: SyncSopEntry[] = [
  { sopId: 'sop_1', title: 'No secrets', content: 'Never print a secret.', contentHash: '', harnessTargets: [] },
]
const { home, ws } = fake

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function put(path: string, content: string | object): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
}

// The edits reach into whatever shape each harness's JSON has.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function editJson(path: string, fn: (doc: Record<string, any>) => void): Promise<void> {
  const doc = JSON.parse(await fs.readFile(path, 'utf-8'))
  fn(doc)
  await fs.writeFile(path, JSON.stringify(doc, null, 2) + '\n')
}

async function editText(path: string, from: string, to: string): Promise<void> {
  const text = await fs.readFile(path, 'utf-8')
  if (!text.includes(from)) throw new Error(`${path} does not contain ${from}`)
  await fs.writeFile(path, text.replace(from, to))
}

type Snapshot = Map<string, string>

/** Every file (mode and bytes) and directory under the fake home. */
async function snapshot(): Promise<Snapshot> {
  const out: Snapshot = new Map()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      const rel = relative(home, p)
      if (entry.isDirectory()) {
        out.set(rel, 'dir')
        await walk(p)
      } else {
        const mode = ((await fs.stat(p)).mode & 0o777).toString(8)
        out.set(rel, `${mode}\n${await fs.readFile(p, 'utf-8')}`)
      }
    }
  }
  await walk(home)
  return out
}

/**
 * Equal by meaning: a JSON config the reverser rewrote after the user's
 * edit is compared parsed. Everything else must match byte for byte.
 */
function sameMeaning(path: string, a: string, b: string): boolean {
  if (a === b) return true
  if (extname(path) !== '.json') return false
  const [modeA, ...restA] = a.split('\n')
  const [modeB, ...restB] = b.split('\n')
  try {
    return modeA === modeB && JSON.stringify(JSON.parse(restA.join('\n'))) === JSON.stringify(JSON.parse(restB.join('\n')))
  } catch {
    return false
  }
}

async function clear(): Promise<void> {
  await fs.rm(home, { recursive: true, force: true })
  await fs.mkdir(ws, { recursive: true })
}

async function disconnect(): Promise<number> {
  const plan = await planDisconnect({ workspaceRoots: [ws] })
  await plan.apply()
  return plan.visible().length
}

const darwin = process.platform === 'darwin'
const appSupport = (...p: string[]) => (darwin ? join(home, 'Library', 'Application Support', ...p) : join(home, '.config', ...p))

// ─── Cases ───────────────────────────────────────────────────────────────────

interface Case {
  harness: string
  /** Test title, when one harness has more than one case. */
  name?: string
  /** The user's own config before connect. */
  seed: () => Promise<void>
  /** What connect writes; the harness adapter and the MCP wrapping when omitted. */
  connect?: () => Promise<void>
  /** An edit the user makes while connected. */
  edit: () => Promise<void>
  /** Assertions about what connect wrote, run while connected. */
  connected?: () => Promise<void>
}

async function connectHarness(harness: string): Promise<void> {
  await noteProxyUrl(PROXY)
  const adapter = getAdapter(harness)
  if (!adapter) throw new Error(`no adapter for ${harness}`)
  await adapter.installGate?.(ws, PROXY)
  await adapter.writeConfig(ws, SOPS, PROXY)
  await injectMcpServer(ws, 'ws_test')
}

const CASES: Case[] = [
  {
    harness: 'claude-code',
    seed: async () => {
      await put(join(ws, 'CLAUDE.md'), '# Project rules\n\nUse tabs.\n')
      await put(join(ws, '.claude', 'settings.json'), {
        permissions: { deny: ['Bash(curl:*)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-lint' }] }] },
      })
      await put(join(home, '.claude', 'settings.json'), { model: 'opus', permissions: { allow: ['Read'], deny: ['WebFetch'] } })
      await put(join(ws, '.mcp.json'), { mcpServers: { shared: { command: 'node', args: ['server.js'] } } })
      await put(join(home, '.claude.json'), {
        numStartups: 3,
        mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'x' } } },
        projects: {
          [ws]: {
            hasTrustDialogAccepted: true,
            enabledMcpjsonServers: ['shared'],
            mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } } },
          },
        },
      })
    },
    connect: async () => {
      await connectHarness('claude-code')
      // Vitest's own guard keeps the writer off a real ~/.claude; HOME is fake here.
      vi.stubEnv('VITEST', '')
      try {
        await updatePreToolUseHooks(ws, SOPS, { highRiskTools: ['Bash'], patterns: ['rm -rf'] })
      } finally {
        vi.unstubAllEnvs()
      }
    },
    edit: () => editJson(join(home, '.claude', 'settings.json'), (d) => {
      d.permissions.deny.push('Read(.env)')
      d.hooks = { ...d.hooks, PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }] }
    }),
  },
  {
    harness: 'claude-desktop',
    seed: () => put(appSupport('Claude', 'claude_desktop_config.json'), { globalShortcut: 'x', mcpServers: { fs: { command: 'npx', args: ['fs-mcp'] } } }),
    edit: () => editJson(appSupport('Claude', 'claude_desktop_config.json'), (d) => { d.theme = 'dark' }),
  },
  {
    harness: 'cursor',
    seed: async () => {
      await put(join(ws, '.cursorrules'), 'Prefer small functions.\n')
      await put(join(home, '.cursor', 'hooks.json'), { version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }] } })
      await put(join(ws, '.cursor', 'mcp.json'), { mcpServers: { db: { command: 'uvx', args: ['mcp-db'], disabled: false, autoApprove: ['query'] } } })
      await put(appSupport('Cursor', 'User', 'globalSettings.json'), { theme: 'dark' })
    },
    edit: () => editJson(join(ws, '.cursor', 'mcp.json'), (d) => { d.mcpServers.added = { command: 'later' } }),
  },
  {
    harness: 'windsurf',
    seed: async () => {
      await put(join(ws, '.windsurfrules'), 'Explain before editing.\n')
      await put(appSupport('Windsurf', 'User', 'settings.json'), { 'editor.fontSize': 13, 'http.proxy': 'http://corp-proxy:3128' })
      await put(join(home, '.codeium', 'windsurf', 'mcp_config.json'), { mcpServers: { fs: { command: 'npx', args: ['fs-mcp'] } } })
      await put(
        join(darwin ? appSupport('JetBrains') : join(home, '.config', 'JetBrains'), 'IntelliJIdea2026.1', 'options', 'CodeiumSettings.xml'),
        '<application>\n  <component name="com.codeium.intellij.settings.AppSettingsState">\n    <option name="indexingMaxFileCount" value="5000" />\n  </component>\n</application>\n',
      )
    },
    edit: () => editJson(appSupport('Windsurf', 'User', 'settings.json'), (d) => { d['editor.tabSize'] = 2 }),
    connected: async () => {
      const settings = JSON.parse(await fs.readFile(appSupport('Windsurf', 'User', 'settings.json'), 'utf-8'))
      expect(settings['http.proxy']).toBe('http://127.0.0.1:4000')
      expect(existsSync(join(home, '.codeium', 'windsurf', 'settings.json'))).toBe(false)
    },
  },
  {
    harness: 'github-copilot',
    seed: async () => {
      await put(join(ws, '.github', 'copilot-instructions.md'), 'Write tests first.\n')
      await put(join(ws, '.github', 'workflows', 'ci.yml'), 'on: push\n')
    },
    edit: () => put(join(ws, '.github', 'hooks', 'mine.json'), { hooks: {} }),
  },
  {
    harness: 'muse-code',
    seed: async () => {
      await put(join(ws, 'AGENTS.md'), '# Agents\n\nBe brief.\n')
      await put(join(home, '.config', 'muse', 'settings.json'), { schema_version: 2, theme: 'x', mcp_servers: { a: { command: 'a-mcp' } } })
      await put(join(ws, '.muse', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } })
    },
    edit: () => editJson(join(home, '.config', 'muse', 'settings.json'), (d) => { d.theme = 'y' }),
  },
  {
    harness: 'grok',
    // Laid out the way smol-toml writes it: connect rewrites this file through
    // it, so after an edit the restored file comes back in that layout.
    seed: () => put(join(home, '.grok', 'config.toml'), '[model.grok-code]\nbase_url = "https://api.x.ai/v1"\n\n[mcp_servers.search]\ncommand = "search-mcp"\n'),
    edit: () => editText(join(home, '.grok', 'config.toml'), '[model.grok-code]\n', '[model.grok-code]\ntemperature = 0.2\n'),
  },
  {
    harness: 'opencode',
    seed: async () => {
      await put(join(ws, 'opencode.json'), {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          local1: { type: 'local', command: ['npx', 'x-mcp'], enabled: true, timeout: 5000 },
          remote1: { type: 'remote', url: 'https://r.example/mcp', headers: { A: 'b' } },
        },
      })
      await put(join(home, '.config', 'opencode', 'opencode.json'), { theme: 'opencode' })
    },
    edit: () => editJson(join(ws, 'opencode.json'), (d) => { d.model = 'x' }),
  },
  {
    harness: 'roo-code',
    seed: () => put(join(ws, '.roorules'), 'Be concise.\n'),
    edit: () => put(join(ws, 'NOTES.md'), 'unrelated\n'),
  },
  {
    harness: 'cline',
    seed: () => put(join(ws, 'README.md'), '# project\n'),
    edit: () => put(join(ws, '.clinerules', 'mine.md'), 'My own rule.\n'),
  },
  {
    harness: 'codex',
    seed: async () => {
      await put(join(home, '.codex', 'config.toml'), '# my codex config\nmodel = "o4"\n\n[mcp_servers.x]\ncommand = "y"\n')
      await put(join(home, '.codex', 'hooks.json'), {
        description: 'mine',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
      })
    },
    edit: () => editText(join(home, '.codex', 'config.toml'), 'model = "o4"', 'model = "gpt-5"'),
  },
  {
    harness: 'langgraph',
    seed: () => put(join(ws, 'requirements.txt'), 'langgraph\n'),
    edit: () => put(join(ws, 'requirements.txt'), 'langgraph\nhttpx\n'),
  },
  {
    harness: 'aider',
    seed: () => put(join(ws, '.aider.conf.yml'), '# my aider config\nmodel: gpt-4o\ntest-cmd: pytest\nset-env: FOO=1\n'),
    edit: () => editText(join(ws, '.aider.conf.yml'), 'model: gpt-4o', 'model: o3'),
  },
  {
    harness: 'openhands',
    seed: () =>
      put(join(ws, 'config.toml'), '[llm]\nmodel = "anthropic/claude-sonnet"\nbase_url = "https://my.gateway/v1"\n\n[core]\nworkspace_base = "./"\n'),
    edit: () => editText(join(ws, 'config.toml'), 'workspace_base = "./"', 'workspace_base = "./src"'),
    connected: async () => {
      expect(await fs.readFile(join(ws, '.openhands', 'microagents', 'intutic-governance.md'), 'utf-8')).toContain('Never print a secret.')
      expect(await fs.readFile(join(ws, 'config.toml'), 'utf-8')).not.toContain('[intutic]')
    },
  },
  {
    // `base_url` is set in `[llm]` only: an earlier text edit rewrote the
    // first `base_url` line in the file, whichever table held it.
    harness: 'openhands',
    name: 'openhands, base_url in other tables',
    seed: async () => {
      await put(join(ws, 'config.toml'), '[llm.draft]\nmodel = "gpt-4o-mini"\nbase_url = "https://draft.example/v1"\n\n[llm]\nmodel = "gpt-4o"\n')
      await put(join(home, '.openhands', 'config.toml'), '[mcp]\nbase_url = "https://mcp.example"\n')
    },
    edit: () => editText(join(ws, 'config.toml'), 'model = "gpt-4o"', 'model = "gpt-4.1"'),
    connected: async () => {
      const project = await fs.readFile(join(ws, 'config.toml'), 'utf-8')
      expect(project).toContain('[llm.draft]\nmodel = "gpt-4o-mini"\nbase_url = "https://draft.example/v1"\n')
      expect(project).toContain(`[llm]\nbase_url = "${PROXY}/v1"\n`)
      const user = await fs.readFile(join(home, '.openhands', 'config.toml'), 'utf-8')
      expect(user).toBe(`[mcp]\nbase_url = "https://mcp.example"\n\n[llm]\nbase_url = "${PROXY}/v1"\n`)
    },
  },
  {
    harness: 'antigravity',
    seed: async () => {
      await put(join(ws, '.gemini', 'settings.json'), { theme: 'dark', customInstructions: 'Be brief.' })
      await put(join(home, '.gemini', 'settings.json'), {
        hooks: { BeforeTool: [{ matcher: 'x', hooks: [{ name: 'mine', type: 'command', command: 'echo' }] }] },
      })
    },
    edit: () => editJson(join(home, '.gemini', 'settings.json'), (d) => { d.theme = 'light' }),
    connected: async () => {
      const hooks = JSON.parse(await fs.readFile(join(home, '.gemini', 'config', 'hooks.json'), 'utf-8'))
      expect(hooks['intutic-governance'].PreToolUse[0].hooks[0].command).toContain('antigravity-cli-check.js')
    },
  },
  {
    harness: 'antigravity',
    name: 'antigravity, with a GEMINI.md of the user\'s own',
    seed: async () => {
      await put(join(ws, 'GEMINI.md'), '# Project notes\n\nPrefer small diffs.\n')
      await put(join(ws, '.gemini', 'settings.json'), { theme: 'dark' })
    },
    edit: () => editText(join(ws, 'GEMINI.md'), 'Prefer small diffs.', 'Prefer large diffs.'),
    connected: async () => {
      const gemini = await fs.readFile(join(ws, 'GEMINI.md'), 'utf-8')
      expect(gemini).toMatch(/^# Project notes\n\nPrefer small diffs\.\n\n<!-- INTUTIC:RULES:START -->\n[\s\S]*Never print a secret\.[\s\S]*<!-- INTUTIC:RULES:END -->\n$/)
      expect(JSON.parse(await fs.readFile(join(ws, '.gemini', 'settings.json'), 'utf-8'))).toEqual({ theme: 'dark' })
    },
  },
  {
    harness: 'antigravity',
    name: 'antigravity, with a GEMINI.md that has no final line break',
    seed: () => put(join(ws, 'GEMINI.md'), '# Project notes\n\nPrefer small diffs.'),
    edit: () => editText(join(ws, 'GEMINI.md'), 'Prefer small diffs.', 'Prefer large diffs.'),
  },
  ...[true, false].map((recorded): Case => ({
    // Earlier versions put the rules in `customInstructions`, which neither
    // Gemini CLI nor Antigravity reads; disconnect still takes the key out.
    harness: 'antigravity',
    name: `antigravity, rules an earlier version left in .gemini/settings.json (${recorded ? 'with' : 'without'} the original kept)`,
    seed: () => put(join(ws, '.gemini', 'settings.json'), { theme: 'dark' }),
    connect: async () => {
      const settings = join(ws, '.gemini', 'settings.json')
      if (recorded) await keepOriginal(settings, ws)
      await editJson(settings, (d) => { d.customInstructions = '# Intutic Governance Rules (auto-generated)\n\n## No secrets' })
      await connectHarness('antigravity')
    },
    edit: () => editJson(join(ws, '.gemini', 'settings.json'), (d) => { d.theme = 'light' }),
  })),
  {
    harness: 'antigravity',
    name: 'antigravity, with hooks of the user\'s own in Antigravity\'s hooks file',
    seed: () =>
      put(join(home, '.gemini', 'config', 'hooks.json'), {
        'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] },
      }),
    edit: () => editJson(join(home, '.gemini', 'config', 'hooks.json'), (d) => {
      d.reminder = { PreInvocation: [{ type: 'command', command: './remind.sh' }] }
    }),
  },
  {
    harness: 'continue',
    seed: async () => {
      await put(
        join(home, '.continue', 'config.yaml'),
        'name: mine\nmodels:\n  - name: gpt\n    provider: openai\n    model: gpt-4o\n    apiBase: https://api.openai.com/v1\n  - name: local\n    provider: ollama\n    model: llama3\n',
      )
      await put(join(home, '.continue', 'config.json'), { mcpServers: [{ name: 'fs', command: 'npx', args: ['fs-mcp'], timeout: 10 }] })
    },
    edit: () => editText(join(home, '.continue', 'config.yaml'), 'name: mine', 'name: renamed'),
  },
  {
    harness: 'goose',
    seed: () =>
      put(
        join(home, '.config', 'goose', 'config.yaml'),
        '# goose config\nprovider:\n  name: openai\n  host: https://api.openai.com\nmcp:\n  fetch:\n    command: uvx\n    args: [mcp-fetch]\n',
      ),
    edit: () => editText(join(home, '.config', 'goose', 'config.yaml'), 'name: openai', 'name: anthropic'),
  },
  {
    // The proxy host and the gate registration are set by key: an earlier
    // text edit rewrote the first `host:` and `pre_tool_use:` lines in the
    // file, here the extension's.
    harness: 'goose',
    name: 'goose, other host and pre_tool_use keys',
    seed: () =>
      put(
        join(home, '.config', 'goose', 'config.yaml'),
        'extensions:\n  search:\n    host: https://search.example\n    pre_tool_use: mine.sh\nprovider:\n  name: openai\n',
      ),
    edit: () => editText(join(home, '.config', 'goose', 'config.yaml'), 'name: openai', 'name: anthropic'),
    connected: async () => {
      const text = await fs.readFile(join(home, '.config', 'goose', 'config.yaml'), 'utf-8')
      expect(text).toContain('    host: https://search.example\n    pre_tool_use: mine.sh\n')
      expect(text).toContain(`  host: ${PROXY}\n`)
    },
  },
  {
    harness: 'hermes',
    seed: () => put(join(home, '.hermes', 'config.yaml'), 'model: x\nhooks:\n  postToolUse:\n    command: /bin/true\n'),
    edit: () => editText(join(home, '.hermes', 'config.yaml'), 'model: x', 'model: y'),
  },
  {
    harness: 'pi',
    seed: () => put(join(home, '.pi', 'models.json'), { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' }, google: { baseUrl: 'https://g.example' } } }),
    edit: () => editJson(join(home, '.pi', 'models.json'), (d) => { d.providers.mistral = { apiKeyEnv: 'M' } }),
  },
  {
    harness: 'openclaw',
    seed: () => put(join(home, '.openclaw', 'openclaw.json'), { agents: { default: 'x' } }),
    edit: () => editJson(join(home, '.openclaw', 'openclaw.json'), (d) => { d.agents.second = 'y' }),
  },
  {
    harness: 'n8n',
    seed: () => put(join(ws, 'workflows', 'a.json'), { name: 'a' }),
    edit: () => put(join(ws, 'workflows', 'b.json'), { name: 'b' }),
  },
  {
    harness: 'open-webui',
    seed: () => put(join(ws, 'README.md'), '# project\n'),
    edit: () => put(join(home, '.open-webui', 'mine.py'), 'print(1)\n'),
  },
  {
    harness: 'dsh',
    seed: async () => {
      const profile = join(home, '.dsh', 'profiles', 'main')
      await put(join(profile, 'package.json'), { name: 'main', dependencies: { x: '1.0.0' } })
      await put(join(profile, 'cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_KEY\n    baseURL: https://api.deepseek.com\n')
    },
    edit: () => editJson(join(home, '.dsh', 'profiles', 'main', 'package.json'), (d) => { d.dependencies.y = '2.0.0' }),
  },
  {
    // Codex and OpenCode share AGENTS.md: one section, the team's text kept around it.
    harness: 'codex',
    name: 'codex and opencode, with an AGENTS.md of the team\'s own',
    seed: () => put(join(ws, 'AGENTS.md'), '# Team\n\nRun the tests.\n'),
    connect: async () => {
      await connectHarness('codex')
      await connectHarness('opencode')
    },
    edit: () => editText(join(ws, 'AGENTS.md'), 'Run the tests.', 'Run every test.'),
    connected: async () => {
      const text = await fs.readFile(join(ws, 'AGENTS.md'), 'utf-8')
      expect(text).toMatch(/^# Team\n\nRun the tests\.\n\n<!-- INTUTIC:RULES:START -->\n[\s\S]*Never print a secret\.[\s\S]*<!-- INTUTIC:RULES:END -->\n$/)
      expect(text.match(/INTUTIC:RULES:START/g)).toHaveLength(1)
    },
  },
  ...(['muse-code', 'claude-code', 'cursor', 'windsurf', 'roo-code'] as const).map((harness): Case => {
    // Earlier versions wrote these files whole. Connect gives the user's copy
    // back (or turns AGENTS.md into the section), and disconnect still
    // restores everything byte for byte.
    const legacy = { 'muse-code': 'AGENTS.md', 'claude-code': 'CLAUDE.md', cursor: '.cursorrules', windsurf: '.windsurfrules', 'roo-code': '.roorules' }[harness]
    return {
      harness,
      name: `${harness}, ${legacy} an earlier version wrote whole`,
      seed: () => put(join(ws, legacy), 'The team\'s own rules.\n'),
      connect: async () => {
        const file = join(ws, legacy)
        await keepOriginal(file, ws)
        await writeOwnedFile(file, ws, '# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT — managed by intutic sync daemon\n\n## Old rule\n')
        await getAdapter(harness)!.writeConfig(ws, SOPS, PROXY)
      },
      edit: () => put(join(ws, 'NOTES.md'), 'unrelated\n'),
      connected: async () => {
        const text = await fs.readFile(join(ws, legacy), 'utf-8')
        expect(text).not.toContain('Old rule')
        expect(text.startsWith('The team\'s own rules.\n')).toBe(true)
      },
    }
  }),
  ...(['claude-code', 'codex', 'cursor', 'aider', 'goose', 'continue'] as const).map((harness): Case => {
    // The decisions log next to the rules: its own file, or its own section.
    const seeds: Record<typeof harness, () => Promise<void>> = {
      'claude-code': () => put(join(ws, 'CLAUDE.md'), '# Project rules\n\nUse tabs.\n'),
      codex: () => put(join(ws, 'AGENTS.md'), '# Team\n\nRun the tests.\n'),
      cursor: () => put(join(ws, '.cursor', 'rules', 'style.mdc'), '---\nalwaysApply: true\n---\nTabs.\n'),
      aider: () => put(join(ws, '.aider.conf.yml'), 'model: gpt-4o\nread:\n  - CONVENTIONS.md\n'),
      goose: () => put(join(ws, '.goosehints'), 'Prefer small diffs.\n'),
      continue: () => put(join(ws, 'README.md'), '# project\n'),
    }
    return {
      harness,
      name: `${harness}, with the decisions log`,
      seed: seeds[harness],
      connect: async () => {
        await connectHarness(harness)
        await writeDecisionsTargets(ws, [harness as HarnessType], '## Recent Governed Decisions\n\n- 2026-10-09 — Decision: rollout approved')
      },
      edit: () => put(join(ws, 'NOTES.md'), 'unrelated\n'),
      connected: async () => {
        // No harness's decisions log goes to CLAUDE.md.
        if (harness === 'claude-code') expect(await fs.readFile(join(ws, 'CLAUDE.md'), 'utf-8')).toBe('# Project rules\n\nUse tabs.\n')
        else expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(false)
      },
    }
  }),
  {
    // Earlier versions appended the decisions log to the team's CLAUDE.md.
    harness: 'claude-code',
    name: 'claude-code, the decisions section an earlier version appended to CLAUDE.md',
    seed: () => put(join(ws, 'CLAUDE.md'), '# Project rules\n\nUse tabs.\n'),
    connect: () => editText(join(ws, 'CLAUDE.md'), 'Use tabs.\n', `Use tabs.\n\n${LEGACY_DECISIONS}\n`),
    edit: () => put(join(ws, 'NOTES.md'), 'unrelated\n'),
  },
  {
    // ... and to the CLAUDE.md they had created whole for the rules.
    harness: 'claude-code',
    name: 'claude-code, a CLAUDE.md an earlier version created, with the decisions section',
    seed: () => put(join(ws, 'README.md'), '# project\n'),
    connect: async () => {
      await writeOwnedFile(join(ws, 'CLAUDE.md'), ws, '# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT — managed by intutic sync daemon\n\n## Old rule\n')
      await fs.appendFile(join(ws, 'CLAUDE.md'), `\n${LEGACY_DECISIONS}\n`)
    },
    edit: () => put(join(ws, 'NOTES.md'), 'unrelated\n'),
  },
  {
    harness: 'openclaw',
    name: 'openclaw, with an AGENTS.md of the user\'s own in a configured agent workspace',
    seed: async () => {
      await put(join(home, '.openclaw', 'openclaw.json'), { agents: { defaults: { workspace: '~/assistant' } } })
      await put(join(home, 'assistant', 'AGENTS.md'), '# How I work\n\nAsk first.\n')
    },
    // The rules only: the gate writer runs `openclaw hooks check`, which an
    // installed OpenClaw answers slowly for a configured workspace.
    connect: async () => {
      await getAdapter('openclaw')!.writeConfig(ws, SOPS, PROXY)
    },
    edit: () => editText(join(home, 'assistant', 'AGENTS.md'), 'Ask first.', 'Ask twice.'),
    connected: async () => {
      expect(await fs.readFile(join(home, 'assistant', 'AGENTS.md'), 'utf-8')).toContain('Never print a secret.')
      expect(existsSync(join(home, '.openclaw', 'workspace'))).toBe(false)
    },
  },
]

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  expect(os.homedir()).toBe(home)
})

afterAll(async () => {
  await fs.rm(fake.base, { recursive: true, force: true })
})

describe('intutic disconnect restores what connect changed', () => {
  beforeEach(clear)

  for (const c of CASES) {
    const connect = c.connect ?? (() => connectHarness(c.harness))

    it(`${c.name ?? c.harness}: every file back byte for byte, and a second run changes nothing`, async () => {
      await c.seed()
      const before = await snapshot()

      await connect()
      expect(await snapshot()).not.toEqual(before)
      await c.connected?.()

      expect(await disconnect()).toBeGreaterThan(0)
      expect(Object.fromEntries(await snapshot())).toEqual(Object.fromEntries(before))

      expect(await disconnect()).toBe(0)
      expect(Object.fromEntries(await snapshot())).toEqual(Object.fromEntries(before))
    })

    it(`${c.name ?? c.harness}: an edit made while connected survives`, async () => {
      await c.seed()
      await c.edit()
      const expected = await snapshot()

      await clear()
      await c.seed()
      await connect()
      await c.edit()
      await disconnect()
      const actual = await snapshot()

      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
      for (const [path, content] of expected) {
        expect(sameMeaning(path, actual.get(path)!, content), `${path} differs:\n${actual.get(path)}\n---\n${content}`).toBe(true)
      }
    })
  }
})

// ─── The command ─────────────────────────────────────────────────────────────

describe('intutic disconnect, the command', () => {
  const bin = join(fake.base, 'bin')
  const psOut = join(fake.base, 'ps-output')
  const prevPath = process.env.PATH
  const config = join(home, '.intutic', 'config.json')
  const credentials = join(home, '.intutic', 'credentials.json')
  let output: string[]

  beforeAll(async () => {
    // `ps` reports what each test says is running; `git` finds no repository,
    // so the command never adds the real checkout this test runs in; `docker`
    // finds no container, so a real one on this machine is never touched.
    await put(join(bin, 'ps'), `#!/bin/sh\n[ -f "${psOut}" ] && cat "${psOut}"\nexit 0\n`)
    await put(join(bin, 'git'), '#!/bin/sh\nexit 1\n')
    await put(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
    for (const tool of ['ps', 'git', 'docker']) await fs.chmod(join(bin, tool), 0o755)
  })

  beforeEach(async () => {
    await clear()
    await fs.rm(psOut, { force: true })
    process.env.PATH = `${bin}:${prevPath}`
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')) })
    // A real run reports the disconnect; no control plane answers here.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
  })

  afterEach(() => {
    process.env.PATH = prevPath
    process.exitCode = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function seedUser(): Promise<void> {
    await put(join(ws, 'CLAUDE.md'), 'team rules\n')
    await put(join(home, '.cursor', 'hooks.json'), { version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }] } })
  }

  async function connectAs(harnesses: string[]): Promise<void> {
    for (const h of harnesses) await connectHarness(h)
    await put(config, { workspaceRoot: ws, harnesses, configVersion: 7, devMode: false })
    await put(credentials, { apiKey: 'test-key', workspaceId: 'ws_test', controlPlaneUrl: 'http://localhost:3001', email: 't@example.com', storedAt: '' })
  }

  it('--dry-run prints every change and makes none', async () => {
    await seedUser()
    await connectAs(['cursor'])
    const before = await snapshot()
    await runDisconnect({ dryRun: true })
    expect(await snapshot()).toEqual(before)
    const text = output.join('\n')
    expect(text).toContain('intutic disconnect would:')
    expect(text).toContain('~/.cursor/hooks.json')
    expect(text).toContain('log out')
  })

  it('restores the files, resets the synced version, and keeps the login with --keep-login', async () => {
    await seedUser()
    const before = await snapshot()
    await connectAs(['cursor'])
    await runDisconnect({ keepLogin: true })
    expect(process.exitCode).toBeUndefined()

    // What is left is the login and the config, and nothing else of Intutic's.
    const after = await snapshot()
    for (const path of [config, credentials, join(home, '.intutic')]) after.delete(relative(home, path))
    expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before))
    expect(JSON.parse(await fs.readFile(config, 'utf-8')).configVersion).toBe(0)
    expect(existsSync(credentials)).toBe(true)
  })

  // connect writes the Kitkat and rule-author skills into the workspace when
  // they are missing; disconnect takes back exactly those, and nothing the
  // user wrote or changed.
  it('removes the agent skills connect wrote, and keeps a skill the user had or edited', async () => {
    const kitkat = join(ws, '.agents', 'skills', 'intutic-governance-kitkat', 'SKILL.md')
    const ruleAuthor = join(ws, '.agents', 'skills', 'intutic-rule-author', 'SKILL.md')
    await seedUser()
    await put(kitkat, '# the copy I downloaded\n')
    const before = await snapshot()
    await connectAs(['cursor'])
    expect(await writeBundledSkills(ws)).toEqual([ruleAuthor])
    await runDisconnect({ keepLogin: true })
    const after = await snapshot()
    for (const path of [config, credentials, join(home, '.intutic')]) after.delete(relative(home, path))
    expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before))

    await clear()
    await seedUser()
    await connectAs(['cursor'])
    expect(await writeBundledSkills(ws)).toEqual([ruleAuthor, kitkat])
    await fs.appendFile(kitkat, '\nOur team also asks you to name the ticket.\n')
    await runDisconnect({ keepLogin: true })
    expect(existsSync(ruleAuthor)).toBe(false)
    expect(await fs.readFile(kitkat, 'utf-8')).toContain('Our team also asks you to name the ticket.')
  })

  it('--harness takes one harness out and leaves the others connected', async () => {
    await seedUser()
    await connectAs(['claude-code', 'cursor'])
    await runDisconnect({ harness: 'cursor' })
    expect(JSON.parse(await fs.readFile(join(home, '.cursor', 'hooks.json'), 'utf-8'))).toEqual({
      version: 1,
      hooks: { beforeShellExecution: [{ command: './audit.sh' }] },
    })
    expect(await fs.readFile(join(ws, '.claude', 'rules', 'intutic-governance.md'), 'utf-8')).toContain('Intutic Governance Rules')
    expect(await fs.readFile(join(ws, 'CLAUDE.md'), 'utf-8')).toBe('team rules\n')
    expect(existsSync(join(ws, '.cursor', 'mcp.json'))).toBe(false)
    const saved = JSON.parse(await fs.readFile(config, 'utf-8'))
    expect(saved.harnesses).toEqual(['claude-code'])
    expect(saved.disconnectedHarnesses).toEqual(['cursor'])
    expect(existsSync(credentials)).toBe(true)
  })

  it('tells the control plane before it removes the credentials, and goes on when it cannot', async () => {
    const calls: Array<{ url: string; auth: string; body: Record<string, unknown>; credentialsThere: boolean }> = []
    let answer = 200
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: String((init.headers as Record<string, string>).Authorization),
        body: JSON.parse(String(init.body)),
        credentialsThere: existsSync(credentials),
      })
      return new Response('{}', { status: answer })
    }))
    try {
      await seedUser()
      await connectAs(['claude-code', 'cursor'])
      await runDisconnect({ harness: 'cursor', dryRun: true })
      expect(calls).toEqual([])

      await runDisconnect({ harness: 'cursor' })
      await runDisconnect({})
      expect(calls.map((c) => [c.url, c.auth, c.body.scope, c.body.harnesses, c.credentialsThere])).toEqual([
        ['http://localhost:3001/api/v1/devices/disconnect', 'Bearer test-key', 'harness', ['cursor'], true],
        ['http://localhost:3001/api/v1/devices/disconnect', 'Bearer test-key', 'machine', ['claude-code'], true],
      ])
      expect(calls[0]!.body.fingerprint).toMatch(/^[0-9a-f]{32}$/)
      expect(existsSync(credentials)).toBe(false)
      expect(output.join('\n')).toContain('Told the control plane')

      // A control plane that refuses does not stop the disconnect.
      answer = 503
      await connectAs(['cursor'])
      await runDisconnect({})
      expect(process.exitCode).toBeUndefined()
      expect(existsSync(credentials)).toBe(false)
      expect(output.join('\n')).toContain('Could not tell the control plane (the control plane answered 503)')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses while intutic connect is running, before changing anything', async () => {
    await seedUser()
    await connectAs(['cursor'])
    await put(psOut, '4242 /usr/local/bin/node /usr/local/bin/intutic connect\n')
    const before = await snapshot()
    await runDisconnect({ keepLogin: true })
    expect(process.exitCode).toBe(1)
    expect(await snapshot()).toEqual(before)
    expect(output.join('\n')).toContain('4242')
  })

  it('rejects a harness it does not know', async () => {
    await runDisconnect({ harness: 'no-such-harness' })
    expect(process.exitCode).toBe(1)
  })
})
