#!/usr/bin/env node
/**
 * TD-229: SOP policy became deliverable to the cluster proxy only once the
 * manifests carried `INTUTIC_SOPS_DIR` and a non-optional `proxy-sops`
 * ConfigMap mount — wiring introduced by hand-editing YAML, with nothing to
 * catch a typo in a `configMapGenerator` reference, a broken overlay patch,
 * or a kustomize syntax error before it reached a real cluster. `deploy.yml`
 * never renders these manifests either: it deploys by `kubectl set image` on
 * Deployments that already exist, so a change to `infra/kubernetes/` is
 * otherwise applied for the first time by a human running `kubectl apply -k`
 * by hand.
 *
 * This renders every overlay with the exact tool that would consume it and
 * fails loudly on any error, then asserts the specific regression TD-229
 * documents — the SOPS env var and its ConfigMap mount — so a bad edit to
 * the proxy's k8s manifests fails here rather than silently shipping a proxy
 * that resolves zero SOPs.
 */
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OVERLAYS_DIR = join(ROOT, 'infra', 'kubernetes', 'overlays')

if (!existsSync(OVERLAYS_DIR)) {
  console.log('[skip] no infra/kubernetes/overlays in this tree')
  process.exit(0)
}

try {
  execFileSync('kubectl', ['version', '--client'], { stdio: 'ignore' })
} catch {
  console.error(
    '✖ kubernetes manifests: `kubectl` is not on PATH — cannot render. Install kubectl ' +
      '(its built-in kustomize is what `kubectl apply -k` uses in production).',
  )
  process.exit(1)
}

const overlays = ['dev', 'staging', 'prod']
const failures = []
let proxyChecked = false

for (const overlay of overlays) {
  const dir = join(OVERLAYS_DIR, overlay)
  if (!existsSync(dir)) {
    failures.push(`overlay "${overlay}" is missing from infra/kubernetes/overlays`)
    continue
  }
  let rendered
  try {
    rendered = execFileSync('kubectl', ['kustomize', dir], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (err) {
    failures.push(`overlay "${overlay}" failed to render:\n${err.stderr || err.message}`)
    continue
  }

  // The regression this gate exists to catch (TD-229): SOP policy silently
  // undeliverable to the cluster proxy. Only assert on overlays that carry a
  // proxy deployment at all — a future overlay without one should not be
  // forced to declare SOPS wiring it has no use for.
  if (/kind:\s*Deployment/.test(rendered) && /name:\s*proxy\b/.test(rendered)) {
    proxyChecked = true
    // Anchored to the env-entry `name:` field, not a bare substring search —
    // `INTUTIC_SOPS_DIR_TYPO` contains `INTUTIC_SOPS_DIR` too, and a
    // substring match would call that a pass. This was caught by the
    // verify-by-neutralisation pass this gate is required to survive: it
    // renamed the var and the first version of this check stayed green.
    if (!/^\s*- name:\s*INTUTIC_SOPS_DIR\s*$/m.test(rendered)) {
      failures.push(
        `overlay "${overlay}" renders a proxy Deployment with no INTUTIC_SOPS_DIR env var — ` +
          `SOP policy would silently resolve to nothing in this cluster (TD-229).`,
      )
    }
    // Same anchoring concern: the generated ConfigMap resource is named
    // `proxy-sops-<hash>` by configMapGenerator, and a bare substring/prefix
    // match would treat that resource existing as proof the pod's *volume*
    // (whose own name is the literal `proxy-sops`, unhashed) is still wired.
    // It is a separate field — deleting the volume or its mount would still
    // leave the hashed ConfigMap name elsewhere in the same document. No
    // leading `- ` here (unlike the env entry above): both the volumeMount's
    // and the volume's `name:` are continuation keys of a multi-field list
    // item (`- mountPath: ...` / `- configMap: ...`), never the item's own
    // first key, so requiring a dash on this line would never match either.
    if (!/^\s+name:\s*proxy-sops\s*$/m.test(rendered)) {
      failures.push(
        `overlay "${overlay}" renders a proxy Deployment with no proxy-sops volume mount — ` +
          `INTUTIC_SOPS_DIR would point at a directory nothing populated (TD-229).`,
      )
    }
  }
}

if (!proxyChecked) {
  failures.push(
    'no overlay rendered a proxy Deployment — the TD-229 regression check never ran. ' +
      'A vacuous pass here is worse than no check.',
  )
}

if (failures.length > 0) {
  console.error(`✖ kubernetes manifests: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`    ${f}\n`)
  process.exit(1)
}

console.log(`[PASS] kubernetes manifests: ${overlays.length} overlay(s) render cleanly, SOPS wiring intact.`)
