import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IntuticGateRefusal } from '../errors.js'
import { Gate } from '../gate.js'
import * as snapshotMod from '../snapshot.js'
import type { SopRule } from '../soprules.js'

// Port of the TestGateIntegration class in
// packages/intutic-clawde/tests/test_gate_soprules.py — the precedence test
// (SOP tier attributed before the image tier) is the one an operator would
// actually notice, so it gets special attention here too.

const REGISTRY = 'us-central1-docker.pkg.dev/intutic/intutic'
const IMAGE = `${REGISTRY}/sockshop/catalogue`
const DIGEST = 'sha256:' + 'a'.repeat(64)

const APPLY = { command: 'kubectl apply -f k8s/catalogue-dep.yaml' }
const APPLY_PINNED = { command: 'kubectl apply -f k8s/pinned.yaml' }

const DIGEST_RULE = {
  id: 'sp_pin',
  toolPattern: '^shell$',
  argPattern: 'kubectl\\s+apply(?!.*@sha256:)',
  action: 'block',
  reason: 'deploy must reference a digest-pinned image',
}

function manifest(image: string): string {
  return (
    'apiVersion: apps/v1\nkind: Deployment\n' +
    'metadata:\n  name: catalogue\n  namespace: sock-shop\n' +
    'spec:\n  template:\n    spec:\n      containers:\n' +
    `        - name: catalogue\n          image: ${image}\n`
  )
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'intutic-gate-'))
  mkdirSync(join(root, '.intutic'))
  writeFileSync(
    join(root, '.intutic', 'image-allowlist.json'),
    JSON.stringify({
      require_digest: true,
      registries_allowed: [REGISTRY],
      images: { [IMAGE]: { approved_digests: [DIGEST] } },
    }),
  )
  mkdirSync(join(root, 'k8s'))
  writeFileSync(join(root, 'k8s', 'catalogue-dep.yaml'), manifest(`${IMAGE}:latest`))
  writeFileSync(join(root, 'k8s', 'pinned.yaml'), manifest(`${IMAGE}@${DIGEST}`))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A Gate with an empty, healthy snapshot and a fixed set of SOP rules —
 *  isolates the tier under test from the real filesystem/network. */
function buildGate(rows: Record<string, unknown>[]): Gate {
  const g = new Gate({ repoRoot: root, workspaceId: 'ws_1', useHookGate: false }, null)
  // Reach past the private cache fields the same way the Python test reaches
  // past Gate._sop_rules / Gate._snapshot — there is no public seam for
  // injecting a rule set that skips the network fetch, and adding one only
  // for tests would widen the real API surface for no runtime benefit.
  ;(g as unknown as { _sopRules: SopRule[] })._sopRules = rows.map((r) => ({
    id: String(r.id),
    toolPattern: String(r.toolPattern),
    action: String(r.action),
    reason: String(r.reason),
    argPattern: typeof r.argPattern === 'string' ? r.argPattern : null,
  }))
  const emptySnapshot = new snapshotMod.Snapshot()
  emptySnapshot.state = 'ok'
  emptySnapshot.workspaceId = 'ws_1'
  ;(g as unknown as { _snapshot: snapshotMod.Snapshot })._snapshot = emptySnapshot
  return g
}

describe('Gate.guard: SOP tier', () => {
  it('a matching block rule stops the call', async () => {
    const g = buildGate([DIGEST_RULE])
    await expect(g.guard('shell', APPLY)).rejects.toMatchObject({ code: 'SOP_RULE' })
    try {
      await g.guard('shell', APPLY)
    } catch (e) {
      expect(e).toBeInstanceOf(IntuticGateRefusal)
      const refusal = e as IntuticGateRefusal
      expect(refusal.reason).toContain('digest-pinned')
      expect(refusal.reason).toContain('sp_pin')
    }
  })

  it('require_approval blocks in an unattended run', async () => {
    const g = buildGate([{ ...DIGEST_RULE, action: 'require_approval' }])
    await expect(g.guard('shell', APPLY)).rejects.toMatchObject({ code: 'SOP_RULE_APPROVAL' })
  })

  it('warn does not stop the call', async () => {
    const g = buildGate([{ ...DIGEST_RULE, action: 'warn' }])
    await expect(g.guard('shell', APPLY_PINNED)).resolves.toBeUndefined()
  })

  it('the SOP tier is attributed before the image tier', async () => {
    // Both tiers would refuse this command. The block must carry the SOP's
    // reason, not imagecheck's error code, or the wrong component gets
    // credited for the decision.
    const g = buildGate([DIGEST_RULE])
    await expect(g.guard('shell', APPLY)).rejects.toMatchObject({ code: 'SOP_RULE' })
  })

  it('an empty register leaves the image tier to do its job', async () => {
    const g = buildGate([])
    await expect(g.guard('shell', APPLY)).rejects.toSatisfy((e: unknown) => {
      return e instanceof IntuticGateRefusal && e.code !== 'SOP_RULE'
    })
  })

  it('the tier can be turned off', async () => {
    const g = buildGate([DIGEST_RULE])
    g.cfg.useSopRules = false
    await expect(g.guard('shell', APPLY)).rejects.toSatisfy((e: unknown) => {
      return e instanceof IntuticGateRefusal && e.code !== 'SOP_RULE'
    })
  })
})

describe('Gate.guard: enforcement switch', () => {
  it('enforce=false allows everything, unconditionally', async () => {
    const g = new Gate({ repoRoot: root, workspaceId: 'ws_1', enforce: false }, null)
    await expect(g.guard('shell', { command: 'rm -rf /' })).resolves.toBeUndefined()
  })
})
