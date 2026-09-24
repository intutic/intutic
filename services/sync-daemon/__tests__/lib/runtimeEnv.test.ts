/**
 * `writeRuntimeEnv` — the file every hook script and MCP proxy reads at
 * invocation time. Wave 5.3 (TD-437) adds `INTUTIC_VALKEY_URL`, written only
 * when the caller has a local Valkey running: a proxy must never probe one
 * nobody started.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRuntimeEnv } from '../../src/lib/runtimeEnv.js'

let dir: string
let envPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'intutic-runtime-env-'))
  envPath = join(dir, 'env', 'runtime.env')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const base = { controlPlaneUrl: 'https://api.example.test', apiKey: 'k', workspaceId: 'ws_1' }

describe('writeRuntimeEnv', () => {
  it('writes INTUTIC_VALKEY_URL when a Valkey URL is given, beside the keys every reader already expects', async () => {
    await writeRuntimeEnv({ ...base, envPath, valkeyUrl: 'redis://127.0.0.1:6379' })
    const text = await readFile(envPath, 'utf-8')
    expect(text).toContain('INTUTIC_HOST=https://api.example.test\n')
    expect(text).toContain('INTUTIC_WORKSPACE_ID=ws_1\n')
    expect(text).toContain('INTUTIC_MCP_PROXY_MODE=per-session\n')
    expect(text).toContain('INTUTIC_VALKEY_URL=redis://127.0.0.1:6379\n')
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
  })

  it('omits the line entirely when no Valkey URL is given', async () => {
    await writeRuntimeEnv({ ...base, envPath })
    const text = await readFile(envPath, 'utf-8')
    expect(text).not.toContain('INTUTIC_VALKEY_URL')
    expect(text).toContain('INTUTIC_HOST=https://api.example.test\n')
  })

  it('strips newlines from the URL like every other value, so a value cannot inject a line', async () => {
    await writeRuntimeEnv({ ...base, envPath, valkeyUrl: 'redis://127.0.0.1:6379\nINTUTIC_API_KEY=stolen' })
    const text = await readFile(envPath, 'utf-8')
    expect(text).toContain('INTUTIC_VALKEY_URL=redis://127.0.0.1:6379INTUTIC_API_KEY=stolen\n')
    expect(text.match(/^INTUTIC_API_KEY=/gm)).toHaveLength(1)
  })
})
