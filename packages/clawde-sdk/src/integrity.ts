/**
 * Offline verification of a sealed trace root's signature: the check
 * `intutic integrity verify` makes, with nothing but the root and the control
 * plane's published key set, so the answer does not depend on trusting the
 * server that sealed it.
 *
 * The rules are the signer's (`rootSigner.ts` in the control plane) and the
 * CLI's (`commands/integrity.ts`): an Ed25519 signature over a
 * domain-separated preimage of the root's scope, rebuilt here rather than
 * handed over, under the preimage version the root records. The tests hold
 * this, the CLI and the Python SDK to roots the control plane's own signer
 * sealed (`tools/cli/src/commands/__fixtures__/integrity-roots.json`).
 *
 * @module
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'crypto'
import type { IntegrityRootSignatureState, SignedIntegrityRoot, SigningJwks } from './types'

/**
 * Domain tag per preimage version, as the signer writes them. Also the list of
 * versions this build can rebuild: a root naming any other is unverifiable.
 */
const SIGN_DOMAIN: Readonly<Record<number, string>> = {
  1: 'intutic.merkle-root.v1',
  2: 'intutic.merkle-root.v2',
}

/** The version a root was sealed under; absent means 1 (a control plane older than the column). */
function preimageVersionOf(root: SignedIntegrityRoot): number {
  return root.signing_preimage_version ?? 1
}

/**
 * The exact bytes the control plane signed for this root, under the version
 * the root records. Fields joined by U+001F: domain, workspace, loop run (empty
 * for none), leaf schema version, merkle root; from v2 on, a presence tag and
 * the predecessor, so "no predecessor" is not the same bytes as any value.
 */
export function integrityRootPreimage(root: SignedIntegrityRoot): string {
  const version = preimageVersionOf(root)
  const domain = SIGN_DOMAIN[version]
  if (domain === undefined) {
    // Guessing an encoding would produce bytes that were never signed, and the
    // key would then say "forged".
    throw new RangeError(`unknown signing preimage version ${version}`)
  }
  const fields = [domain, root.workspace_id, root.loop_run_id ?? '', String(root.leaf_schema_version), root.merkle_root]
  if (version >= 2) {
    // A previous_root the server omitted is the same claim as an explicit null.
    const previous = root.previous_root ?? null
    fields.push(previous === null ? '0' : '1', previous ?? '')
  }
  return fields.join('\x1f')
}

/**
 * Checks a sealed root's signature against the published key the root itself
 * names (`jwks`, from `ControlPlaneClient.getSigningKeys()` or a saved copy;
 * null when it could not be had). Pass the `root` of
 * `ControlPlaneClient.getIntegrityRoot()`.
 *
 * Only `invalid` says the root was changed: a published key rejected it.
 * `unverifiable` (the key is not published, or the root names an algorithm or
 * preimage version this build cannot check) and `keys_unavailable` are no
 * verdict, and `unsigned` is a deployment that had no signing key. The key is
 * chosen by `signing_key_id` and never by trying others: a root that verifies
 * under some other key is not the same claim.
 */
export function verifyIntegrityRoot(root: SignedIntegrityRoot, jwks: SigningJwks | null): IntegrityRootSignatureState {
  if (!root.signature || !root.signing_key_id) return 'unsigned'
  if (!jwks) return 'keys_unavailable'
  const jwk = jwks.keys.find((k) => k['kid'] === root.signing_key_id)
  if (!jwk) return 'unverifiable'
  if (root.signature_alg !== 'EdDSA') return 'unverifiable'
  if (SIGN_DOMAIN[preimageVersionOf(root)] === undefined) return 'unverifiable'
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(integrityRootPreimage(root), 'utf8'),
      createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }),
      Buffer.from(root.signature, 'base64'),
    )
    return ok ? 'valid' : 'invalid'
  } catch {
    // A published key this runtime cannot load is one we do not effectively hold.
    return 'unverifiable'
  }
}
