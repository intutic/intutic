import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  egressDigestInput,
  writeEgressPolicy,
  EGRESS_POLICY_FILE,
} from '../src/lib/egressPolicy.js'

describe('egressDigestInput', () => {
  it('is the canonical string the Rust proxy recomputes: mode then allow, newline-joined', () => {
    expect(egressDigestInput('enforce', ['github.com', '10.0.0.0/8'])).toBe(
      'enforce\ngithub.com\n10.0.0.0/8',
    )
    // null mode → empty first segment (central management not configured)
    expect(egressDigestInput(null, [])).toBe('')
    expect(egressDigestInput('monitor', [])).toBe('monitor')
  })
})

describe('writeEgressPolicy', () => {
  it('writes a file whose digest matches sha256(canonical)[:32] — the contract the proxy verifies', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'egress-'))
    const policy = { mode: 'enforce' as const, allow: ['github.com', '10.0.0.0/8'] }

    const { digest } = await writeEgressPolicy(policy, 'wk_test', dir)

    // the digest is exactly what the proxy will recompute
    const expected = createHash('sha256')
      .update(egressDigestInput(policy.mode, policy.allow))
      .digest('hex')
      .slice(0, 32)
    expect(digest).toBe(expected)

    // on-disk shape carries workspace + digest + mode + allow
    const doc = JSON.parse(await fs.readFile(path.join(dir, EGRESS_POLICY_FILE), 'utf-8'))
    expect(doc.workspace).toBe('wk_test')
    expect(doc.digest).toBe(expected)
    expect(doc.mode).toBe('enforce')
    expect(doc.allow).toEqual(['github.com', '10.0.0.0/8'])

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes mode:null when central management is not configured', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'egress-'))
    await writeEgressPolicy({ mode: null, allow: [] }, 'wk_test', dir)
    const doc = JSON.parse(await fs.readFile(path.join(dir, EGRESS_POLICY_FILE), 'utf-8'))
    expect(doc.mode).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
