#!/usr/bin/env node
/**
 * SOP policy became deliverable to the cluster proxy only once the
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
 * fails loudly on any error, then asserts the specific regression that
 * wiring is prone to — the SOPS env var and its ConfigMap mount — so a bad edit to
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
let upstreamsChecked = 0

/**
 * A provider upstream (`OPENAI_UPSTREAM_URL`, `UPSTREAM_URL`, ...) that points
 * at the in-cluster LiteLLM. Until 2026-10-10 the hosted proxy sent every
 * OpenAI-family request to http://litellm:4000, which serves only the
 * self-hosted judge aliases and rejects customer keys: each one failed 401.
 */
function upstreamProblems(where, docs) {
  const problems = []
  for (const d of docs) {
    const pod = d.spec?.template?.spec
    for (const c of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) {
      for (const e of c.env ?? []) {
        if (!/(^|_)UPSTREAM_URL$/.test(e.name) || typeof e.value !== 'string') continue
        upstreamsChecked++
        let host = ''
        try {
          host = new URL(e.value).hostname
        } catch {
          continue
        }
        if (host === 'litellm' || host.startsWith('litellm.')) {
          problems.push(
            `${where}: ${d.kind} ${d.metadata?.name} sets ${e.name}=${e.value}, the in-cluster LiteLLM — it serves ` +
              'only the self-hosted judge aliases and rejects customer keys. Use the provider\'s public API.',
          )
        }
      }
    }
  }
  return problems
}

/** Template values: `changeme`, `REPLACE_WITH_…`, `your-…`, `xxx…` (control-plane secretStrength.ts). */
function isPlaceholder(value) {
  const v = value.trim().toLowerCase()
  return (
    ['changeme', 'change-me', 'change_me', 'secret', 'password', 'example', 'test', 'dev', 'placeholder'].includes(v) ||
    /^(changeme|replace[_-]with|your[-_])/.test(v) ||
    /^x{3,}$/.test(v)
  )
}

/**
 * A rendered Secret holding a placeholder, alone or as the password of a
 * connection URL. The staging overlay rendered control-plane-secrets with
 * `changeme` into the live namespace: applying it would replace the real JWT_SECRET
 * and ENCRYPTION_KEY with a value anyone could forge tokens with.
 */
function placeholderSecretProblems(where, docs) {
  const problems = []
  for (const d of docs.filter((doc) => doc.kind === 'Secret')) {
    const entries = [
      ...Object.entries(d.data ?? {}).map(([k, v]) => [k, Buffer.from(String(v), 'base64').toString('utf8')]),
      ...Object.entries(d.stringData ?? {}).map(([k, v]) => [k, String(v)]),
    ]
    for (const [key, value] of entries) {
      let password = ''
      try {
        password = decodeURIComponent(new URL(value).password)
      } catch {
        // Not a URL.
      }
      if (isPlaceholder(value) || (password && isPlaceholder(password))) {
        problems.push(
          `${where}: Secret ${d.metadata?.name} renders a placeholder value for ${key}. Create real secrets ` +
            'out of band; never apply a template Secret.',
        )
      }
    }
  }
  return problems
}

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

  const overlayDocs = loadAll(rendered).filter((d) => d != null)
  failures.push(...upstreamProblems(`overlay "${overlay}"`, overlayDocs))
  failures.push(...placeholderSecretProblems(`overlay "${overlay}"`, overlayDocs))

  // The regression this gate exists to catch: SOP policy silently
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
          `SOP policy would silently resolve to nothing in this cluster.`,
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
          `INTUTIC_SOPS_DIR would point at a directory nothing populated.`,
      )
    }
  }

  // The hosted-gateway ingress must stay on its
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

/**
 * A pre-install hook runs before Helm creates the release's ordinary
 * resources, so anything it uses must either come from outside the chart (a
 * Secret the operator creates first) or be a pre-install hook itself with a
 * lower weight. Until 2026-10-08 the Self-host migration Job ran as the chart's
 * ordinary ServiceAccount: every fresh `helm install` waited on a Job whose
 * pods the API server refused ("serviceaccount not found") until it timed out.
 */
function preInstallHookProblems(chart, docs) {
  const hookOf = (d) => {
    const a = d.metadata?.annotations ?? {}
    const phases = String(a['helm.sh/hook'] ?? '').split(',').map((p) => p.trim())
    return { preInstall: phases.includes('pre-install'), weight: Number(a['helm.sh/hook-weight'] ?? 0) }
  }
  const rendered = new Map(docs.map((d) => [`${d.kind}/${d.metadata?.name}`, d]))
  const problems = []
  for (const d of docs) {
    const hook = hookOf(d)
    const pod = d.spec?.template?.spec
    if (!hook.preInstall || !pod) continue
    const containers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])]
    const refs = [
      ['ServiceAccount', pod.serviceAccountName],
      ...(pod.imagePullSecrets ?? []).map((s) => ['Secret', s.name]),
      ...(pod.volumes ?? []).flatMap((v) => [['Secret', v.secret?.secretName], ['ConfigMap', v.configMap?.name]]),
      ...containers.flatMap((c) => [
        ...(c.envFrom ?? []).flatMap((e) => [['Secret', e.secretRef?.name], ['ConfigMap', e.configMapRef?.name]]),
        ...(c.env ?? []).flatMap((e) => [
          ['Secret', e.valueFrom?.secretKeyRef?.name],
          ['ConfigMap', e.valueFrom?.configMapKeyRef?.name],
        ]),
      ]),
    ]
    for (const [kind, name] of refs) {
      const target = name && rendered.get(`${kind}/${name}`)
      if (!target) continue
      const dep = hookOf(target)
      if (!dep.preInstall || dep.weight >= hook.weight) {
        problems.push(
          `chart ${chart}: pre-install hook ${d.kind} ${d.metadata.name} uses ${kind} ${name}, which the chart ` +
            `creates ${dep.preInstall ? 'in the same or a later hook weight' : 'as an ordinary resource'} — ` +
            'it does not exist yet when the hook runs on a fresh install',
        )
      }
    }
  }
  return problems
}

/**
 * The gateway chart's local judge, rendered with a real config. Until
 * 2026-10-08 the LiteLLM container set `command:` (replacing the image's
 * entrypoint, so it never started) and the chart rendered `model_list: []`
 * whenever no ConfigMap was named, so every judge call failed.
 */
function localJudgeProblems(docs) {
  const problems = []
  const byComponent = (c) => docs.find((d) => d.kind === 'Deployment' && d.metadata.labels['app.kubernetes.io/component'] === c)
  const container = byComponent('litellm')?.spec.template.spec.containers[0]
  if (!container) return ['chart intutic-gateway renders no LiteLLM Deployment with litellm.enabled=true']
  if (container.command) problems.push("chart intutic-gateway: LiteLLM sets `command`, replacing the image's entrypoint — pass `args`")
  const configMap = docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name.endsWith('-litellm-config'))
  const models = (loadAll(configMap?.data?.['config.yaml'] ?? '')[0]?.model_list ?? []).map((m) => m.model_name)
  if (!models.includes('intutic-openweight-judge')) {
    problems.push(`chart intutic-gateway: the rendered LiteLLM config serves [${models.join(', ')}], not the judge model it was given`)
  }
  const env = Object.fromEntries((byComponent('proxy')?.spec.template.spec.containers[0].env ?? []).map((e) => [e.name, e.value]))
  if (env.LITELLM_LOCAL_JUDGE_MODEL !== 'intutic-openweight-judge') problems.push('chart intutic-gateway: the proxy is not told the local judge model')
  // With LiteLLM on and no config at all, the chart must refuse to render
  // rather than deploy a LiteLLM that answers nothing.
  try {
    execFileSync('helm', ['template', 't', join(HELM_DIR, 'intutic-gateway'), '--set', 'litellm.enabled=true'], { stdio: 'pipe' })
    problems.push('chart intutic-gateway renders litellm.enabled=true with no LiteLLM config')
  } catch {
    // Refused, as it should be.
  }
  return problems
}

// ── Helm charts (Self-host) ──────────────────────────────────────────────────
// tools/helm/intutic is how a Self-host customer installs on Kubernetes, and
// nothing deploys it here, so a broken template would first fail on their
// cluster. Until 2026-10-07 it templated only the control plane, probed a
// /health route the control plane does not serve, and named a ServiceAccount
// it never created. Render both charts and hold the Self-host chart to the
// shape the product needs.
const HELM_DIR = join(ROOT, 'tools', 'helm')
let helmCharts = 0
if (existsSync(HELM_DIR)) {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' })
  } catch {
    failures.push('`helm` is not on PATH — cannot render tools/helm. Install Helm 3.')
  }
  // The gateway chart renders twice: as installed by default, and with the
  // local judge on, given the compose stack's litellm_config.yaml as its
  // config (`--set-file`, as `intutic judge configure` tells users to).
  const localJudge = [
    '--set', 'litellm.enabled=true', '--set', 'proxy.localJudge=true',
    '--set', 'litellm.judgeModel=intutic-openweight-judge',
    '--set-file', `litellm.config=${join(ROOT, 'infra', 'compose', 'litellm_config.yaml')}`,
  ]
  const charts = [
    ['intutic', ['--set', 'hostname=intutic.example.internal', '--set', 'ingress.tls.secretName=tls', '--set', 'bootstrap.secretName=owner']],
    ['intutic-gateway', []],
    ['intutic-gateway', localJudge],
  ]
  for (const [chart, args] of charts) {
    const dir = join(HELM_DIR, chart)
    if (!existsSync(dir)) {
      failures.push(`chart tools/helm/${chart} is missing`)
      continue
    }
    let rendered
    try {
      execFileSync('helm', ['lint', dir, ...args], { encoding: 'utf8', stdio: 'pipe' })
      rendered = execFileSync('helm', ['template', 't', dir, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    } catch (err) {
      failures.push(`chart ${chart} failed to lint or render:\n${err.stderr || err.stdout || err.message}`)
      continue
    }
    helmCharts++
    const docs = loadAll(rendered).filter((d) => d != null)
    const containers = docs.flatMap((d) => d.spec?.template?.spec?.containers ?? [])
    if (containers.some((c) => (c.env ?? []).some((e) => e.name === 'OFFLINE_MODE'))) {
      failures.push(`chart ${chart} still sets OFFLINE_MODE, which nothing reads`)
    }
    const accounts = new Set(docs.filter((d) => d.kind === 'ServiceAccount').map((d) => d.metadata.name))
    for (const d of docs) {
      const sa = d.spec?.template?.spec?.serviceAccountName
      if (sa && !accounts.has(sa)) failures.push(`chart ${chart}: ${d.kind} ${d.metadata.name} runs as ServiceAccount ${sa}, which the chart does not create`)
    }
    failures.push(...preInstallHookProblems(chart, docs))
    failures.push(...upstreamProblems(`chart ${chart}`, docs))
    failures.push(...placeholderSecretProblems(`chart ${chart}`, docs))
    if (args === localJudge) failures.push(...localJudgeProblems(docs))
    if (chart !== 'intutic') continue
    const deployments = new Map(docs.filter((d) => d.kind === 'Deployment').map((d) => [d.metadata.labels['app.kubernetes.io/component'], d]))
    for (const c of ['control-plane', 'proxy', 'dashboard', 'docs', 'valkey']) {
      if (!deployments.has(c)) failures.push(`chart intutic renders no ${c} Deployment`)
    }
    const cp = deployments.get('control-plane')?.spec.template.spec.containers[0]
    if (cp) {
      const env = Object.fromEntries((cp.env ?? []).map((e) => [e.name, e.value]))
      if (env.INTUTIC_DEPLOYMENT !== 'self_host') failures.push('chart intutic: the control plane is not INTUTIC_DEPLOYMENT=self_host')
      if (!env.INTUTIC_LICENSE_FILE) failures.push('chart intutic: the control plane has no INTUTIC_LICENSE_FILE')
      if (cp.livenessProbe?.httpGet?.path !== '/healthz' || cp.readinessProbe?.httpGet?.path !== '/readyz') {
        failures.push('chart intutic: the control plane must probe /healthz (liveness) and /readyz (readiness)')
      }
    }
    const ingress = docs.find((d) => d.kind === 'Ingress')
    const paths = new Set((ingress?.spec.rules[0].http.paths ?? []).map((p) => p.path))
    for (const p of ['/', '/api', '/scim', '/.well-known', '/v1', '/docs']) {
      if (!paths.has(p)) failures.push(`chart intutic: the Ingress does not route ${p}`)
    }
  }
}

if (!proxyChecked) {
  failures.push(
    'no overlay rendered a proxy Deployment — the SOPS-wiring regression check never ran. ' +
      'A vacuous pass here is worse than no check.',
  )
}
if (!gatewayChecked) {
  failures.push(
    'no overlay rendered an intutic-gateway-ingress — the gateway cert-isolation ' +
      'check never ran. A vacuous pass here is worse than no check.',
  )
}

if (upstreamsChecked === 0) {
  failures.push('no rendered workload sets a *_UPSTREAM_URL — the LiteLLM-upstream check never ran.')
}

if (failures.length > 0) {
  console.error(`✖ kubernetes manifests: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`    ${f}\n`)
  process.exit(1)
}

console.log(
  `[PASS] kubernetes manifests: ${overlays.length} overlay(s), ${cellsRemoteRendered} cells-remote ` +
    `kustomization(s) and ${helmCharts} Helm chart render(s) pass, SOPS wiring intact, ` +
    `${upstreamsChecked} provider upstream(s) off LiteLLM, no placeholder Secret.`,
)
