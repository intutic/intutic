/**
 * n8nHooks.test.ts — the importable event-forwarding workflow `writeN8nHooks`
 * writes to `~/.intutic/n8n/governance-workflow.json`.
 *
 * The gate module's behaviour is covered by generatedGateBehaviour.test.ts's
 * "n8n workflow gate" block; this file covers the workflow JSON, which nothing
 * asserted: it posted to the proxy (which serves no `/api/v1/hook-events`) and
 * sent its Authorization header as literal text, because the value lacked the
 * `=` that makes an n8n parameter an expression.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { CLOUD_RELEASED, HOSTED_CONTROL_PLANE_URL } from '@intutic/shared-types'
import { writeN8nHooks } from '../../src/harness/n8nHooks.js'

const PROXY_URL = 'http://127.0.0.1:4000'

interface N8nNode {
  name: string
  parameters: Record<string, any>
}

describe('n8n event-forwarding workflow', () => {
  let home: string
  let workspaceRoot: string
  const prevHome = process.env.HOME

  beforeEach(async () => {
    home = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-n8n-home-'))
    workspaceRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-n8n-ws-'))
    // writeN8nHooks reads os.homedir() at call time.
    process.env.HOME = home
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    await node_fs.rm(home, { recursive: true, force: true })
    await node_fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  async function forwardNode(): Promise<N8nNode> {
    const raw = await node_fs.readFile(node_path.join(home, '.intutic', 'n8n', 'governance-workflow.json'), 'utf-8')
    const workflow = JSON.parse(raw) as { nodes: N8nNode[] }
    const node = workflow.nodes.find((n) => n.name === 'Forward to Intutic')
    expect(node).toBeDefined()
    return node!
  }

  function header(node: N8nNode, name: string): string | undefined {
    const params = node.parameters.headerParameters.parameters as Array<{ name: string; value: string }>
    return params.find((p) => p.name === name)?.value
  }

  it('posts to the control plane named in runtime.env, not to the proxy', async () => {
    await node_fs.mkdir(node_path.join(home, '.intutic', 'env'), { recursive: true })
    await node_fs.writeFile(
      node_path.join(home, '.intutic', 'env', 'runtime.env'),
      'INTUTIC_HOST=https://cp.example.test/\nINTUTIC_WORKSPACE_ID=ws_n8n\n',
    )

    await writeN8nHooks(workspaceRoot, PROXY_URL, 'ws_n8n')
    const node = await forwardNode()

    expect(node.parameters.url).toBe('https://cp.example.test/api/v1/hook-events')
    expect(header(node, 'X-Intutic-Workspace-Id')).toBe('ws_n8n')
  })

  it.runIf(CLOUD_RELEASED)('falls back to the hosted control plane when runtime.env is absent', async () => {
    await writeN8nHooks(workspaceRoot, PROXY_URL, 'ws_n8n')
    const node = await forwardNode()
    expect(node.parameters.url).toBe(`${HOSTED_CONTROL_PLANE_URL}/api/v1/hook-events`)
  })

  it.runIf(!CLOUD_RELEASED)('writes the gate but no forwarding workflow with no control plane to forward to', async () => {
    await writeN8nHooks(workspaceRoot, PROXY_URL, 'ws_n8n')
    await expect(node_fs.access(node_path.join(home, '.intutic', 'hooks', 'n8n-governance-hook.js'))).resolves.toBeUndefined()
    await expect(node_fs.access(node_path.join(home, '.intutic', 'n8n', 'governance-workflow.json'))).rejects.toThrow()
    const install = await node_fs.readFile(node_path.join(home, '.intutic', 'n8n', 'INSTALL.md'), 'utf-8')
    expect(install).toContain('EXTERNAL_HOOK_FILES')
    expect(install).not.toContain('event-forwarding workflow')
  })

  it('sends the API key through an n8n expression, not as literal braces', async () => {
    await node_fs.mkdir(node_path.join(home, '.intutic', 'env'), { recursive: true })
    await node_fs.writeFile(node_path.join(home, '.intutic', 'env', 'runtime.env'), 'INTUTIC_HOST=https://cp.example.test\n')
    await writeN8nHooks(workspaceRoot, PROXY_URL, 'ws_n8n')
    const node = await forwardNode()

    // n8n evaluates a parameter as an expression only when it starts with `=`.
    expect(header(node, 'Authorization')).toBe('=Bearer {{ $env.INTUTIC_API_KEY }}')
    expect(node.parameters.jsonBody).toMatch(/^=/)
  })
})
