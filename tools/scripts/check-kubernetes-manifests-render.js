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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { loadAll } from 'js-yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OVERLAYS_DIR = join(ROOT, 'infra', 'kubernetes', 'overlays')
const CELLS_REMOTE_DIR = join(ROOT, 'infra', 'kubernetes', 'cells-remote')

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
let gatewayChecked = false

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

  // LLD #64 / TD-334 increment 3: the hosted-gateway ingress must stay on its
  // OWN dedicated cert (`intutic-gateway-cert`), never merged into the
  // primary `intutic-ingress`'s pre-shared cert — that resource already
  // serves six live production domains (api/app/docs/intutic.ai/releases/www)
  // and a merge would put an edit meant only for the new seventh domain in
  // the blast radius of all of them. This is deliberately narrow — it checks
  // the isolation invariant, not whether the gateway is "done" (it is not;
  // see gateway-ingress.yaml's header for the remaining operator steps).
  if (/kind:\s*Ingress/.test(rendered) && /name:\s*intutic-gateway-ingress\b/.test(rendered)) {
    gatewayChecked = true
    if (!/networking\.gke\.io\/managed-certificates:\s*intutic-gateway-cert\b/.test(rendered)) {
      failures.push(
        `overlay "${overlay}" renders intutic-gateway-ingress without its dedicated ` +
          `intutic-gateway-cert annotation — it may have been merged onto the primary ` +
          `ingress's pre-shared cert, risking the six already-live production domains.`,
      )
    }
    if (/networking\.gke\.io\/managed-certificates:\s*intutic-gateway-cert\b/.test(rendered)
      && /ingress\.gcp\.kubernetes\.io\/pre-shared-cert/.test(
        // Scope this specific check to the gateway Ingress document only —
        // the primary intutic-ingress document in the SAME rendered output
        // legitimately carries pre-shared-cert, so a whole-output substring
        // search would always "find" it and never fail.
        rendered.split('---').find((doc) => /name:\s*intutic-gateway-ingress\b/.test(doc)) ?? '',
      )
    ) {
      failures.push(
        `overlay "${overlay}"'s intutic-gateway-ingress carries a pre-shared-cert ` +
          `annotation — it should use ONLY the dedicated managed-certificates annotation.`,
      )
    }
  }
  if (/kind:\s*ManagedCertificate/.test(rendered) && /name:\s*intutic-gateway-cert\b/.test(rendered)) {
    const doc = rendered.split('---').find((d) => /name:\s*intutic-gateway-cert\b/.test(d)) ?? ''
    if (!/^\s*-\s*gateway\.intutic\.ai\s*$/m.test(doc)) {
      failures.push(
        `overlay "${overlay}"'s intutic-gateway-cert ManagedCertificate does not declare ` +
          `gateway.intutic.ai — TLS for the gateway would never validate.`,
      )
    }
  }
}

// Remote cells regions (multi-region cells): each infra/kubernetes/
// cells-remote/<region>/ is its own standalone kustomization applied against
// a remote cluster (or, for *-sim, the us cluster) — render each with the
// same tool `kubectl apply -k` would use. Their gateway-bootstrap.yaml files
// are DELIBERATELY excluded from the kustomizations (applied once by the
// runbook, never re-applied — see the file headers), so rendering never
// touches them; YAML-parse them directly instead so a syntax error can't
// hide in the one file the render gate would otherwise never read.
let cellsRemoteRendered = 0
if (existsSync(CELLS_REMOTE_DIR)) {
  for (const entry of readdirSync(CELLS_REMOTE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(CELLS_REMOTE_DIR, entry.name)
    if (existsSync(join(dir, 'kustomization.yaml'))) {
      try {
        execFileSync('kubectl', ['kustomize', dir], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        cellsRemoteRendered += 1
      } catch (err) {
        failures.push(`cells-remote "${entry.name}" failed to render:\n${err.stderr || err.message}`)
      }
    }
    const bootstrap = join(dir, 'gateway-bootstrap.yaml')
    if (existsSync(bootstrap)) {
      try {
        const docs = loadAll(readFileSync(bootstrap, 'utf8')).filter((d) => d != null)
        // A truncated file parses "cleanly" as fewer documents — assert the
        // bootstrap still carries a Gateway so the parse isn't vacuous.
        if (!docs.some((d) => d.kind === 'Gateway')) {
          failures.push(
            `cells-remote "${entry.name}"'s gateway-bootstrap.yaml parses but contains no Gateway document.`,
          )
        }
      } catch (err) {
        failures.push(`cells-remote "${entry.name}"'s gateway-bootstrap.yaml is not valid YAML:\n${err.message}`)
      }
    }
  }
}

if (!proxyChecked) {
  failures.push(
    'no overlay rendered a proxy Deployment — the TD-229 regression check never ran. ' +
      'A vacuous pass here is worse than no check.',
  )
}
if (!gatewayChecked) {
  failures.push(
    'no overlay rendered an intutic-gateway-ingress — the LLD #64 / TD-334 cert-isolation ' +
      'check never ran. A vacuous pass here is worse than no check.',
  )
}

if (failures.length > 0) {
  console.error(`✖ kubernetes manifests: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`    ${f}\n`)
  process.exit(1)
}

console.log(
  `[PASS] kubernetes manifests: ${overlays.length} overlay(s) and ${cellsRemoteRendered} cells-remote ` +
    `kustomization(s) render cleanly, SOPS wiring intact.`,
)
