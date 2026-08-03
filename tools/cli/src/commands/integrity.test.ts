import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as nodeSign, createPublicKey, KeyObject } from 'node:crypto'
import {
  failsIntegrity,
  keyPublication,
  runIntegrityChain,
  runIntegrityConfigChain,
  runIntegrityRoots,
  runIntegrityVerify,
  signingPreimage,
  verifyRootSignature,
  type SignedRootRow,
  type SigningJwks,
} from './integrity.js'

vi.mock('../config/store.js', () => ({
  loadCredentials: async () => ({ apiKey: 'vk_test', workspaceId: 'wk_alpha' }),
}))

/** The unauthenticated JWKS path the verifier reads its keys from. */
const JWKS_SUFFIX = '/.well-known/intutic-trace-signing.json'

/** An Ed25519 keypair plus the JWK a JWKS would publish for it. */
function keyFixture(kid: string): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid }
  return { privateKey, jwk: jwk as Record<string, unknown> }
}

/**
 * A root as the detail endpoint serves one.
 *
 * `signing_preimage_version` is deliberately absent by default, which is how a
 * control plane older than migration 113 answers and therefore means 1. The v2
 * cases set it explicitly — the same way the column decides it in production.
 */
function rootFixture(over: Partial<SignedRootRow> = {}): SignedRootRow {
  return {
    workspace_id: 'wk_alpha',
    loop_run_id: 'lr_7',
    leaf_schema_version: 2,
    merkle_root: 'a'.repeat(64),
    signature_alg: 'EdDSA',
    signature: null,
    signing_key_id: null,
    previous_root: 'b'.repeat(64),
    ...over,
  }
}

function signed(root: SignedRootRow, privateKey: KeyObject, kid: string): SignedRootRow {
  return {
    ...root,
    signature_alg: 'EdDSA',
    signing_key_id: kid,
    signature: nodeSign(null, Buffer.from(signingPreimage(root), 'utf8'), privateKey).toString('base64'),
  }
}

describe('signingPreimage', () => {
  // Pinned as a literal, not rebuilt from the same helper: this is the one
  // place the CLI has to agree byte-for-byte with the control plane's
  // rootSigner.ts, and a helper comparing itself to itself would agree with
  // anything.
  it('matches the domain-separated field order the control plane signs', () => {
    expect(signingPreimage(rootFixture({ merkle_root: 'deadbeef' }))).toBe(
      'intutic.merkle-root.v1\x1fwk_alpha\x1flr_7\x1f2\x1fdeadbeef',
    )
  })

  it('writes an empty field, not "null", for a root that is not scoped to a run', () => {
    expect(signingPreimage(rootFixture({ loop_run_id: null, merkle_root: 'deadbeef' }))).toBe(
      'intutic.merkle-root.v1\x1fwk_alpha\x1f\x1f2\x1fdeadbeef',
    )
  })

  it('binds the scope, so a signature does not carry to another workspace', () => {
    expect(signingPreimage(rootFixture())).not.toBe(
      signingPreimage(rootFixture({ workspace_id: 'wk_beta' })),
    )
  })

  it('adds a presence-tagged previous_root at version 2, and nothing else', () => {
    // Also pinned as a literal, and it has to match the v2 arm of
    // rootSigner.ts's builder exactly. Three programs rebuild these bytes; a
    // one-byte disagreement between any two of them tells an auditor a root
    // was forged.
    expect(
      signingPreimage(
        rootFixture({ merkle_root: 'deadbeef', signing_preimage_version: 2 }),
      ),
    ).toBe(`intutic.merkle-root.v2\x1fwk_alpha\x1flr_7\x1f2\x1fdeadbeef\x1f1\x1f${'b'.repeat(64)}`)
  })

  it('writes a presence tag, not an empty field, for a root with no predecessor', () => {
    // "Nothing preceded me" is a claim about the chain — the one a relinking
    // attacker needs the surviving root to make — so it cannot encode the same
    // as any value could.
    expect(
      signingPreimage(
        rootFixture({ merkle_root: 'deadbeef', previous_root: null, signing_preimage_version: 2 }),
      ),
    ).toBe('intutic.merkle-root.v2\x1fwk_alpha\x1flr_7\x1f2\x1fdeadbeef\x1f0\x1f')
  })

  it('encodes a previous_root the server omitted exactly as an explicit null', () => {
    // The row is parsed from JSON, so "absent" is reachable however the type is
    // declared, and it is the same claim as an explicit null. The dashboard
    // verifier normalises the same way; encoding absent as present-with-an-
    // empty-value here would make the two of them disagree about one root.
    const omitted = rootFixture({ signing_preimage_version: 2 })
    delete (omitted as { previous_root?: string | null }).previous_root
    expect(signingPreimage(omitted)).toBe(
      signingPreimage(rootFixture({ previous_root: null, signing_preimage_version: 2 })),
    )
  })

  it('rebuilds v1 for a root sealed under v1, whatever the newest version is', () => {
    // The regression the version column exists to prevent: the roots already in
    // the ledger were signed over these bytes and must keep being checked
    // against them.
    expect(signingPreimage(rootFixture({ signing_preimage_version: 1 }))).toBe(
      signingPreimage(rootFixture()),
    )
    expect(signingPreimage(rootFixture({ signing_preimage_version: 1 }))).not.toBe(
      signingPreimage(rootFixture({ signing_preimage_version: 2 })),
    )
  })
})

describe('verifyRootSignature', () => {
  it('accepts a signature made by the published key', () => {
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture(), privateKey, 'kid_active')
    expect(verifyRootSignature(root, { keys: [jwk] })).toBe('valid')
  })

  it('reports invalid when the named key rejects the signature', () => {
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture(), privateKey, 'kid_active')
    // The root now claims a different merkle_root than the one that was signed.
    const tampered = { ...root, merkle_root: 'b'.repeat(64) }
    expect(verifyRootSignature(tampered, { keys: [jwk] })).toBe('invalid')
  })

  it('reports unverifiable — never invalid — when the JWKS does not publish the key', () => {
    const { privateKey } = keyFixture('kid_retired')
    const other = keyFixture('kid_active')
    const root = signed(rootFixture(), privateKey, 'kid_retired')

    // The operator dropped the rotated-out key. Nothing is known to be wrong
    // with this root, and calling it invalid would accuse them of forgery.
    expect(verifyRootSignature(root, { keys: [other.jwk] })).toBe('unverifiable')
  })

  it('does not fall back to another published key that happens to verify', () => {
    const { privateKey } = keyFixture('kid_retired')
    const root = signed(rootFixture(), privateKey, 'kid_retired')
    // Same key material, published under a different kid than the root names.
    const republished = {
      ...(createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, unknown>),
      kid: 'kid_other',
    }
    expect(verifyRootSignature(root, { keys: [republished] })).toBe('unverifiable')
  })

  it('reports unsigned when no key was configured at seal time', () => {
    const { jwk } = keyFixture('kid_active')
    expect(verifyRootSignature(rootFixture(), { keys: [jwk] })).toBe('unsigned')
  })

  it('reports keys_unavailable when the JWKS could not be read', () => {
    const { privateKey } = keyFixture('kid_active')
    const root = signed(rootFixture(), privateKey, 'kid_active')
    expect(verifyRootSignature(root, null)).toBe('keys_unavailable')
  })

  it('reports unverifiable for an algorithm this build cannot check', () => {
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture(), privateKey, 'kid_active')
    expect(verifyRootSignature({ ...root, signature_alg: 'ES256' }, { keys: [jwk] })).toBe(
      'unverifiable',
    )
  })

  it('still accepts a root sealed under preimage v1 after v2 shipped', () => {
    // THE regression. Every root sealed before migration 113 is v1, and if this
    // stops holding the product reports tampering on rows nobody touched.
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture({ signing_preimage_version: 1 }), privateKey, 'kid_active')
    expect(verifyRootSignature(root, { keys: [jwk] })).toBe('valid')
  })

  it('accepts a v2 root, and rejects one whose previous_root was relinked', () => {
    // The defect this round closes. Under v1 the chain link sat outside the
    // signed bytes, so an attacker who deleted a root could point the survivor
    // at a different predecessor — the whole content of hiding the deletion —
    // and every signature still verified.
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture({ signing_preimage_version: 2 }), privateKey, 'kid_active')
    expect(verifyRootSignature(root, { keys: [jwk] })).toBe('valid')

    expect(verifyRootSignature({ ...root, previous_root: 'c'.repeat(64) }, { keys: [jwk] })).toBe(
      'invalid',
    )
    // Including the relink to "I am this workspace's first root", which is what
    // deleting the oldest root would require.
    expect(verifyRootSignature({ ...root, previous_root: null }, { keys: [jwk] })).toBe('invalid')
  })

  it('reports unverifiable for a preimage version this build cannot rebuild', () => {
    // A CLI older than the control plane. We cannot produce the bytes that were
    // signed, so we have established nothing. Without the check this reports
    // `valid` — it rebuilds the newest encoding it knows, that happens to match
    // here, and it announces a verification it never performed. On a version
    // whose new fields do matter it reports INVALID instead and exits 1 over a
    // deployment skew. Both are the mistake failing on a rotated-out key would be.
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture({ signing_preimage_version: 2 }), privateKey, 'kid_active')
    expect(verifyRootSignature({ ...root, signing_preimage_version: 3 }, { keys: [jwk] })).toBe(
      'unverifiable',
    )
  })
})

describe('keyPublication', () => {
  const jwks: SigningJwks = { keys: [{ kid: 'kid_active' }] }

  it('separates published, unpublished, unsigned and unread', () => {
    expect(keyPublication({ signing_key_id: 'kid_active' }, jwks)).toBe('published')
    expect(keyPublication({ signing_key_id: 'kid_retired' }, jwks)).toBe('not_published')
    expect(keyPublication({ signing_key_id: null }, jwks)).toBe('unsigned')
    expect(keyPublication({ signing_key_id: 'kid_active' }, null)).toBe('keys_unavailable')
  })
})

// ─── Exit status, end to end through the commands ───────────────────
//
// The unit tests above pin the decision; these pin that the commands act on
// it. A CI job reads the exit code and nothing else, so a verdict that is
// printed but not acted on is the same as no check at all.

/** Route stubbed responses by URL suffix. */
function stubFetch(routes: Array<[string, number, unknown]>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const hit = routes.find(([suffix]) => url.includes(suffix))
    if (!hit) throw new Error(`unstubbed fetch: ${url}`)
    return new Response(JSON.stringify(hit[2]), {
      status: hit[1],
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

describe('command exit status', () => {
  let exitCode: number | null

  beforeEach(() => {
    exitCode = null
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Run a command that is expected to call process.exit, and report the code. */
  async function exitCodeOf(run: () => Promise<void>): Promise<number | null> {
    try {
      await run()
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
    return exitCode
  }

  const rootDetail = {
    ok: true,
    root: { ...rootFixture(), root_id: 'tmr_1', leaf_count: 2, sealed_at: '2026-07-01T00:00:00Z' },
    leaves: [{ trace_id: 'tr_a', leaf_index: 0, leaf_hash: 'x' }],
  }

  it('exits 1 when a covered trace changed after sealing', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/recompute', 200, { ok: true, verdict: 'mismatch', storedRoot: 'a', recomputedRoot: 'b', changedTraceIds: ['tr_a'], missingTraceIds: [] }],
        ['/integrity/roots/tmr_1', 200, rootDetail],
        [JWKS_SUFFIX, 200, { keys: [] }],
      ]),
    )
    expect(await exitCodeOf(() => runIntegrityVerify('tmr_1', {}))).toBe(1)
  })

  it('exits 0 on a match whose signing key is no longer published', async () => {
    const { privateKey } = keyFixture('kid_retired')
    const root = signed(rootFixture(), privateKey, 'kid_retired')
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/recompute', 200, { ok: true, verdict: 'match', storedRoot: 'a', recomputedRoot: 'a', changedTraceIds: [], missingTraceIds: [] }],
        ['/integrity/roots/tmr_1', 200, { ...rootDetail, root: { ...rootDetail.root, ...root } }],
        // The rotated-out key is gone from the JWKS: unverifiable, and an
        // operator's key-retention gap must not fail a customer's build.
        [JWKS_SUFFIX, 200, { keys: [] }],
      ]),
    )
    expect(await exitCodeOf(() => runIntegrityVerify('tmr_1', {}))).toBeNull()
  })

  it('exits 1 when the recompute matched but a published key rejects the signature', async () => {
    const { privateKey, jwk } = keyFixture('kid_active')
    const root = signed(rootFixture(), privateKey, 'kid_active')
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/recompute', 200, { ok: true, verdict: 'match', storedRoot: 'a', recomputedRoot: 'a', changedTraceIds: [], missingTraceIds: [] }],
        ['/integrity/roots/tmr_1', 200, {
          ...rootDetail,
          root: { ...rootDetail.root, ...root, merkle_root: 'b'.repeat(64) },
        }],
        [JWKS_SUFFIX, 200, { keys: [jwk] }],
      ]),
    )
    expect(await exitCodeOf(() => runIntegrityVerify('tmr_1', {}))).toBe(1)
  })

  it('says nothing is sealed yet, rather than printing an empty table', async () => {
    const printed: string[] = []
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    })
    vi.stubGlobal('fetch', stubFetch([['/integrity/roots', 200, { ok: true, data: [], leafSchemaVersion: 2 }]]))

    await runIntegrityRoots({})
    expect(exitCode).toBeNull()
    expect(printed.join('\n')).toContain('No roots sealed yet')
  })

  it('marks a listed root whose signing key is not published as unverifiable', async () => {
    const printed: string[] = []
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    })
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/integrity/roots', 200, {
          ok: true,
          leafSchemaVersion: 2,
          data: [{
            root_id: 'tmr_1',
            loop_run_id: 'lr_7',
            leaf_schema_version: 2,
            merkle_root: 'a'.repeat(64),
            leaf_count: 12,
            first_trace_at: '2026-07-01T00:00:00Z',
            last_trace_at: '2026-07-01T01:00:00Z',
            signature_alg: 'EdDSA',
            signing_key_id: 'kid_retired',
            sealed_at: '2026-07-01T01:15:00Z',
          }],
        }],
        [JWKS_SUFFIX, 200, { keys: [{ kid: 'kid_active' }] }],
      ]),
    )

    await runIntegrityRoots({})
    const report = printed.join('\n')
    expect(report).toContain('unverifiable')
    // The listing has no signature to check, so it must not read as a verdict
    // on one in either direction.
    expect(report).not.toContain('valid')
  })

  it('exits 1 on a chain break, reading the 409 body rather than throwing on it', async () => {
    const printed: string[] = []
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    })
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/integrity/chain', 409, {
          ok: false,
          workspaceId: 'wk_alpha',
          rootsWalked: 3,
          rootsNotWalked: 0,
          unchainedRootIds: [],
          breaks: [{ rootId: 'tmr_3', namedPrevious: 'gone', precedingRootId: 'tmr_1', precedingMerkleRoot: 'aaa' }],
          intact: false,
        }],
      ]),
    )
    expect(await exitCodeOf(() => runIntegrityChain({}))).toBe(1)
    // Both ends of the gap, not just "the chain is broken" — and the 409 body
    // is where they come from, so this also pins that the status did not
    // become an exception on the way out.
    const report = printed.join('\n')
    expect(report).toContain('tmr_3')
    expect(report).toContain('tmr_1')
  })

  it('exits 0 when roots are merely unchained', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/integrity/chain', 200, {
          ok: false,
          workspaceId: 'wk_alpha',
          rootsWalked: 3,
          rootsNotWalked: 0,
          // A pre-migration-108 writer during a rolling deploy. Nothing was
          // claimed, so nothing contradicts.
          unchainedRootIds: ['tmr_2'],
          breaks: [],
          intact: false,
        }],
      ]),
    )
    expect(await exitCodeOf(() => runIntegrityChain({}))).toBeNull()
  })

  // ── config-chain ──────────────────────────────────────────────────
  //
  // Same contract as `chain`, over `harness_config_snapshots`, plus the second
  // finding that walk carries: a stored body that no longer hashes to the
  // content_hash stored beside it.

  /** Capture everything the command prints — log.error goes to console.error. */
  function captureOutput(): string[] {
    const printed: string[] = []
    const push = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    vi.mocked(console.log).mockImplementation(push)
    vi.mocked(console.error).mockImplementation(push)
    return printed
  }

  function configChainBody(over: Record<string, unknown> = {}) {
    return {
      ok: true,
      workspaceId: 'wk_alpha',
      harnessType: null,
      snapshotsWalked: 3,
      snapshotsNotWalked: 0,
      unchainedSnapshotIds: [],
      breaks: [],
      contentMismatches: [],
      intact: true,
      ...over,
    }
  }

  it('exits 0 on an intact config chain', async () => {
    vi.stubGlobal('fetch', stubFetch([['/integrity/config-chain', 200, configChainBody()]]))
    expect(await exitCodeOf(() => runIntegrityConfigChain({}))).toBeNull()
  })

  it('exits 1 on a config chain break and names both ends of the gap', async () => {
    const printed = captureOutput()
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/integrity/config-chain', 409, configChainBody({
          ok: false,
          intact: false,
          breaks: [{
            snapshotId: 'cfs_3',
            harnessType: 'claude-code',
            filePath: 'CLAUDE.md',
            namedPrevious: 'deadbeef',
            precedingSnapshotId: 'cfs_1',
            precedingContentHash: 'cafebabe',
          }],
        })],
      ]),
    )

    expect(await exitCodeOf(() => runIntegrityConfigChain({}))).toBe(1)
    // Both ends, as with `chain`: "the chain is broken" is not actionable.
    // Reading them off the 409 body also pins that the status did not become an
    // exception on the way out.
    const report = printed.join('\n')
    expect(report).toContain('cfs_3')
    expect(report).toContain('cfs_1')
    expect(report).toContain('cafebabe')
  })

  it('exits 1 on a content mismatch and calls it that, not a break', async () => {
    const printed = captureOutput()
    vi.stubGlobal(
      'fetch',
      stubFetch([
        ['/integrity/config-chain', 409, configChainBody({
          ok: false,
          intact: false,
          // Every link is intact here. One snapshot's stored body was rewritten
          // under the hash recorded with it — which link-checking cannot see,
          // and which is a different finding with a different cause.
          contentMismatches: [{
            snapshotId: 'cfs_2',
            harnessType: 'claude-code',
            filePath: 'CLAUDE.md',
            storedHash: 'aaaa',
            recomputedHash: 'bbbb',
          }],
        })],
      ]),
    )

    expect(await exitCodeOf(() => runIntegrityConfigChain({}))).toBe(1)
    const report = printed.join('\n')
    expect(report).toContain('content mismatch')
    expect(report).toContain('cfs_2')
    // Collapsing the two findings into one label is the mistake
    // audit_log_integrity made. An operator told "break" would go looking for a
    // deleted snapshot that is not missing.
    expect(report).not.toMatch(/break/i)
  })

  it('does not report an empty workspace as a clean config chain', async () => {
    const printed = captureOutput()
    vi.stubGlobal(
      'fetch',
      stubFetch([
        // `intact` is true with nothing to walk — no breaks, no mismatches, no
        // unchained snapshots — so a command that echoed the server's verdict
        // would print a pass for a workspace it verified nothing about.
        ['/integrity/config-chain', 200, configChainBody({ snapshotsWalked: 0 })],
      ]),
    )

    expect(await exitCodeOf(() => runIntegrityConfigChain({}))).toBeNull()
    const report = printed.join('\n')
    expect(report).toContain('nothing was verified')
    expect(report).not.toMatch(/No breaks and no content mismatches/)
  })
})

describe('failsIntegrity', () => {
  it('fails the run on a re-derivation that did not match', () => {
    expect(failsIntegrity({ kind: 'recompute', verdict: 'mismatch' })).toBe(true)
    expect(failsIntegrity({ kind: 'recompute', verdict: 'missing_traces' })).toBe(true)
    expect(failsIntegrity({ kind: 'recompute', verdict: 'match' })).toBe(false)
  })

  it('fails on a rejected signature and on nothing else about signatures', () => {
    expect(failsIntegrity({ kind: 'signature', state: 'invalid' })).toBe(true)
    // The distinction the exit code exists to preserve: a key we no longer
    // publish is a key-retention gap, not tampering, and must not turn a
    // customer's CI red.
    expect(failsIntegrity({ kind: 'signature', state: 'unverifiable' })).toBe(false)
    expect(failsIntegrity({ kind: 'signature', state: 'keys_unavailable' })).toBe(false)
    expect(failsIntegrity({ kind: 'signature', state: 'unsigned' })).toBe(false)
    expect(failsIntegrity({ kind: 'signature', state: 'valid' })).toBe(false)
  })

  it('fails on a chain break', () => {
    expect(failsIntegrity({ kind: 'chain', breaks: 1 })).toBe(true)
    expect(failsIntegrity({ kind: 'chain', breaks: 0 })).toBe(false)
  })

  it('fails on either config chain finding, independently', () => {
    // A break alone and an edited body alone are each enough. Requiring both,
    // or reading only the link half, is how a walker that checks two things
    // ends up enforcing one.
    expect(failsIntegrity({ kind: 'configChain', breaks: 1, contentMismatches: 0 })).toBe(true)
    expect(failsIntegrity({ kind: 'configChain', breaks: 0, contentMismatches: 1 })).toBe(true)
    expect(failsIntegrity({ kind: 'configChain', breaks: 0, contentMismatches: 0 })).toBe(false)
  })
})
