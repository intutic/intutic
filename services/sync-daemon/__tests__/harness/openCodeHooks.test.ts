/**
 * openCodeHooks.test.ts — the writer itself. The gate's verdicts are covered
 * by the registry-driven suites (`generatedGateBehaviour.test.ts`'s "OpenCode
 * plugin gate" block, `generatedGateFailClosed.test.ts`); this file pins what
 * the writer puts on disk, that it is idempotent, and — when `bun` is on the
 * machine — that the file loads under the runtime OpenCode actually uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'
import {
  writeOpenCodeHooks, buildPluginScript, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE, OPENCODE_PLUGIN_V2_FILE,
  OPENCODE_MCP_ID_JS,
} from '../../src/harness/openCodeHooks.js'

const PROXY_URL = 'http://127.0.0.1:4000'
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

describe('writeOpenCodeHooks', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intutic-opencode-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the plugin under .opencode/plugins and nothing else, atomically', async () => {
    await writeOpenCodeHooks(root, PROXY_URL, 'ws_test')
    const pluginPath = join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE)
    const body = await readFile(pluginPath, 'utf8')
    expect(body).toContain('Intutic gate body')
    expect(body).toContain('harness: opencode')
    expect(body).toContain("'tool.execute.before'")
    expect(body).toContain("ctx.tool.hook('execute.before'")
    expect(body).toContain('export default plugin')
    // Both layouts, identical bytes; no temp file left behind, no opencode.json written.
    expect((await readdir(join(root, OPENCODE_PLUGIN_DIR))).sort()).toEqual(['intutic-governance', OPENCODE_PLUGIN_FILE].sort())
    expect(await readFile(join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_V2_FILE), 'utf8')).toBe(body)
    await expect(stat(join(root, 'opencode.json'))).rejects.toThrow()
    // The events dir the audit line appends to exists up front.
    expect((await stat(join(root, '.intutic', 'events'))).isDirectory()).toBe(true)
  })

  it('is idempotent — a second run replaces the file rather than stacking', async () => {
    await writeOpenCodeHooks(root, PROXY_URL, 'ws_test')
    await writeOpenCodeHooks(root, PROXY_URL, 'ws_test')
    expect((await readdir(join(root, OPENCODE_PLUGIN_DIR))).sort()).toEqual(['intutic-governance', OPENCODE_PLUGIN_FILE].sort())
    expect(await readdir(join(root, OPENCODE_PLUGIN_DIR, 'intutic-governance'))).toEqual(['index.js'])
  })

  it('embeds the workspace id and the events log path, and installs no process-level handlers', () => {
    const body = buildPluginScript(PROXY_URL, '/ws/root', 'ws_abc')
    expect(body).toContain('_intuticWsId = "ws_abc"')
    expect(body).toContain('/ws/root/.intutic/events/hook-events.jsonl')
    expect(body).not.toContain("process.on('uncaughtException'")
    expect(body).not.toContain('process.exit(')
  })

  it.skipIf(!hasBun)('loads under bun (the runtime OpenCode embeds) and refuses a protected-path command', async () => {
    await writeOpenCodeHooks(root, PROXY_URL, 'ws_test')
    const pluginPath = join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE)
    const script = [
      `const m = await import(${JSON.stringify(pluginPath)});`,
      'const hooks = await m.default.server({ directory: process.cwd() });',
      'try {',
      "  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'chflags nouchg .intutic/hooks/x' } });",
      "  console.log('ALLOWED'); process.exit(1);",
      '} catch (e) { console.log(String(e.message)); process.exit(0); }',
    ].join('\n')
    const r = spawnSync('bun', ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: join(root, 'none') },
    })
    expect(r.status, `bun run failed:\n${r.stderr}\n${r.stdout}`).toBe(0)
    expect(r.stdout).toContain('[Intutic Governance] BLOCKED')
  })
})

/** The embedded id-composition JavaScript, evaluated exactly as the plugin
 *  carries it (the plugin supplies `fs`, `path` and `os` from its require). */
function loadMcpId(): {
  id: (tool: string, names: string[]) => string
  names: (dirs: string[]) => string[]
} {
  const factory = new Function('fs', 'path', 'os',
    OPENCODE_MCP_ID_JS + '\nreturn { id: intuticOpenCodeMcpId, names: intuticOpenCodeMcpServerNames };')
  return factory(nodeFs, nodePath, nodeOs)
}

describe('OpenCode MCP tool id composition (TD-487)', () => {
  const { id, names } = loadMcpId()

  it('composes <server>_<tool> into mcp__<server>__<tool>', () => {
    expect(id('github_create_issue', ['github'])).toBe('mcp__github__create_issue')
  })

  it('chooses the LONGEST configured server name, so a server name containing _ is not split', () => {
    expect(id('my_db_query', ['my', 'my_db'])).toBe('mcp__my_db__query')
    expect(id('my_db_query', ['my_db', 'my'])).toBe('mcp__my_db__query')
    expect(id('my_search', ['my', 'my_db'])).toBe('mcp__my__search')
  })

  it('matches OpenCode\'s sanitized server name but composes the configured one', () => {
    expect(id('docs_site_fetch', ['docs.site'])).toBe('mcp__docs.site__fetch')
  })

  it('passes built-in and unconfigured tools through unchanged', () => {
    for (const t of ['bash', 'read', 'apply_patch', 'todo_write', 'github', 'github_']) {
      expect(id(t, ['github'])).toBe(t)
    }
    expect(id('bash', [])).toBe('bash')
    expect(id('mcp__a__b', ['mcp'])).toBe('mcp__a__b')
  })

  describe('reads server names from the OpenCode config files', () => {
    let home: string
    let project: string
    const saved: Record<string, string | undefined> = {}
    const vars = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT']
    beforeEach(async () => {
      for (const v of vars) saved[v] = process.env[v]
      home = await mkdtemp(join(tmpdir(), 'intutic-opencode-home-'))
      project = await mkdtemp(join(tmpdir(), 'intutic-opencode-proj-'))
      process.env.HOME = home
      process.env.USERPROFILE = home
      for (const v of vars.slice(2)) delete process.env[v]
    })
    afterEach(async () => {
      for (const v of vars) {
        if (saved[v] === undefined) delete process.env[v]
        else process.env[v] = saved[v]
      }
      await rm(home, { recursive: true, force: true })
      await rm(project, { recursive: true, force: true })
    })

    it('global .json, project .jsonc with comments and trailing commas, .opencode/, and OPENCODE_CONFIG_CONTENT', () => {
      nodeFs.mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      nodeFs.writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { github: {} }, theme: 'x' }))
      nodeFs.writeFileSync(
        join(project, 'opencode.jsonc'),
        '{\n  // a comment with "quotes" and // slashes\n  "mcp": { "my_db": {}, /* inline */ "url_thing": { "url": "https://a.b//c" }, },\n}\n',
      )
      nodeFs.mkdirSync(join(project, '.opencode'), { recursive: true })
      nodeFs.writeFileSync(join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { inner: {} } }))
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { fromenv: {} } })
      expect(names([project]).sort()).toEqual(['fromenv', 'github', 'inner', 'my_db', 'url_thing'])
    })

    it('an unreadable or malformed file contributes nothing and does not throw', () => {
      nodeFs.writeFileSync(join(project, 'opencode.json'), '{ "mcp": ')
      expect(names([project, join(project, 'missing')])).toEqual([])
    })
  })
})
