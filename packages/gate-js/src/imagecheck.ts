/**
 * Container image integrity checking.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/imagecheck.py`.
 *
 * Given a deploy command, find the manifests it would apply, extract every
 * container image reference, and check each against an allowlist of approved
 * sha256 digests. Nothing else in Intutic does this — no cosign, no sigstore,
 * no admission webhook — so this check is the argument-level enforcement
 * point for "deploy only pinned, reviewed images".
 *
 * Fail-closed on anything it cannot read. That is a deliberate departure from
 * Intutic's fail-open default (WASM rules, hook-gate, the MCP proxy all fail
 * open). The reasoning: a gate that cannot parse what it is being asked to
 * approve does not know what it is approving, and "I could not read it" is
 * not evidence of safety.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseAllDocuments } from 'yaml'
import { isDeploy } from './actions.js'
import { shlexSplit } from './shlex.js'

// Failure codes. Each becomes the operator-visible reason, so they are
// specific rather than a single "policy violation".
export const E_UNPINNED_LATEST = 'E_UNPINNED_LATEST'
export const E_UNPINNED_TAG = 'E_UNPINNED_TAG'
export const E_UNKNOWN_REGISTRY = 'E_UNKNOWN_REGISTRY'
export const E_UNKNOWN_IMAGE = 'E_UNKNOWN_IMAGE'
export const E_DIGEST_MISMATCH = 'E_DIGEST_MISMATCH'
export const E_MANIFEST_UNPARSEABLE = 'E_MANIFEST_UNPARSEABLE'

/** A parsed container image reference. */
export interface ImageRef {
  raw: string
  /** registry/namespace/name, no tag, no digest */
  repository: string
  tag: string | null
  /** `sha256:...` or null */
  digest: string | null
  /** which manifest file it came from */
  source: string
}

export function isPinned(img: ImageRef): boolean {
  return img.digest !== null
}

export interface ImagePolicy {
  require_digest?: boolean
  registries_allowed?: string[]
  images?: Record<string, { approved_digests?: string[] }>
}

export interface Verdict {
  ok: boolean
  code: string
  detail: string
  images: ImageRef[]
}

/** The single line an operator sees on the dashboard. */
export function verdictReason(v: Verdict): string {
  if (v.ok) return ''
  return `[image-integrity] ${v.code}: ${v.detail}`
}

function ok(images: ImageRef[] = []): Verdict {
  return { ok: true, code: '', detail: '', images }
}

function fail(code: string, detail: string, images: ImageRef[] = []): Verdict {
  return { ok: false, code, detail, images }
}

/**
 * Parse `registry/repo:tag@sha256:...` into its parts.
 *
 * Docker's own rule for splitting registry from repository: the first path
 * component is a registry host only if it contains a dot or a colon, or is
 * exactly `localhost`. This function does not need to make that
 * classification itself — it only needs to find the tag/digest boundary,
 * which is a colon (or `@`) in the LAST path component; a colon earlier
 * (a registry port, `localhost:5000/foo`) is left alone.
 */
export function parseImageRef(raw: string, source = ''): ImageRef {
  let ref = raw.trim()
  let digest: string | null = null
  let tag: string | null = null

  const at = ref.indexOf('@')
  if (at !== -1) {
    digest = ref.slice(at + 1)
    ref = ref.slice(0, at)
  }

  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  if (colon > slash) {
    tag = ref.slice(colon + 1)
    ref = ref.slice(0, colon)
  }

  return { raw: raw.trim(), repository: ref, tag, digest, source }
}

/** Walk a parsed YAML document for container image references. */
function extractImagesFromDoc(doc: unknown, source: string): ImageRef[] {
  const found: ImageRef[] = []
  const containerKeys = new Set(['containers', 'initContainers', 'ephemeralContainers'])

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (containerKeys.has(key) && Array.isArray(value)) {
          for (const c of value) {
            if (c !== null && typeof c === 'object' && typeof (c as Record<string, unknown>).image === 'string') {
              found.push(parseImageRef((c as Record<string, unknown>).image as string, source))
            }
          }
        } else {
          walk(value)
        }
      }
    }
  }

  walk(doc)
  return found
}

/**
 * Extract the -f/-k targets from a kubectl/helm command.
 *
 * Returns `{paths, readable}`. `readable` is false when the command applies
 * something we cannot inspect — stdin (`-f -`), a URL, or a command we could
 * not tokenise. That drives the fail-closed path.
 */
export function manifestPathsFromCommand(command: string): { paths: string[]; readable: boolean } {
  let tokens: string[]
  try {
    tokens = shlexSplit(command)
  } catch {
    return { paths: [], readable: false }
  }

  const paths: string[] = []
  let readable = true
  const flagsWithPath = new Set(['-f', '--filename', '-k', '--kustomize'])

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    let value: string | null = null
    if (flagsWithPath.has(tok) && i + 1 < tokens.length) {
      value = tokens[i + 1]!
      i += 1
    } else if (tok.startsWith('--filename=') || tok.startsWith('--kustomize=')) {
      value = tok.split('=', 2)[1] ?? ''
    } else if (tok.startsWith('-f') && tok.length > 2 && !tok.startsWith('--')) {
      value = tok.slice(2)
    }

    if (value !== null) {
      if (value === '-' || value.startsWith('http://') || value.startsWith('https://')) {
        readable = false
      } else {
        paths.push(value)
      }
    }
    i += 1
  }

  return { paths, readable }
}

/** Load every YAML document under a file or directory. */
function loadYamlDocs(path: string): unknown[] {
  const docs: unknown[] = []
  if (statSync(path).isDirectory()) {
    for (const fn of readdirSync(path).sort()) {
      if (fn.endsWith('.yaml') || fn.endsWith('.yml')) {
        docs.push(...loadYamlDocs(join(path, fn)))
      }
    }
    return docs
  }
  const text = readFileSync(path, 'utf-8')
  for (const d of parseAllDocuments(text)) {
    const value = d.toJS()
    if (value !== null && value !== undefined) docs.push(value)
  }
  return docs
}

/**
 * Catch images named directly on the command line.
 *
 * `kubectl set image deploy/catalogue catalogue=repo:latest` never touches a
 * manifest, so the YAML path would miss it entirely.
 */
export function inlineImagesFromCommand(command: string): ImageRef[] {
  const out: ImageRef[] = []
  let tokens: string[]
  try {
    tokens = shlexSplit(command)
  } catch {
    return out
  }
  for (const tok of tokens) {
    const eq = tok.indexOf('=')
    const afterEq = eq !== -1 ? tok.slice(eq + 1) : ''
    const candidate = eq !== -1 && afterEq.includes('/') ? afterEq : tok
    // A bare word is only an image reference if it looks like one.
    if (candidate.includes('/') && (candidate.includes(':') || candidate.includes('@'))) {
      if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('-')) {
        continue
      }
      out.push(parseImageRef(candidate, '<command line>'))
    }
  }
  return out
}

/** Evaluate parsed references against the allowlist. First failure wins. */
export function checkImages(images: readonly ImageRef[], policy: ImagePolicy): Verdict {
  const requireDigest = policy.require_digest ?? true
  const allowedRegistries = policy.registries_allowed ?? []
  const known = policy.images ?? {}
  const all = [...images]

  for (const img of images) {
    const where = img.source ? ` (in ${img.source})` : ''

    // 1. Unpinned by tag — `:latest` or no tag at all.
    if (img.digest === null && (img.tag === null || img.tag === 'latest')) {
      const shown = img.tag ? img.raw : `${img.raw} (no tag -> :latest)`
      return fail(
        E_UNPINNED_LATEST,
        `${shown} resolves to a mutable tag and is not pinned to an approved sha256 digest${where}`,
        all,
      )
    }

    // 2. A real tag, but still no digest.
    if (img.digest === null && requireDigest) {
      return fail(
        E_UNPINNED_TAG,
        `${img.raw} is pinned only by tag; policy requires an @sha256 digest${where}`,
        all,
      )
    }

    // 3. Registry not on the allowlist.
    if (allowedRegistries.length > 0 && !allowedRegistries.some((r) => img.repository.startsWith(r))) {
      return fail(
        E_UNKNOWN_REGISTRY,
        `${img.repository} is not in an approved registry (${allowedRegistries.join(', ')})${where}`,
        all,
      )
    }

    // 4. Approved registry, but this image was never reviewed.
    const entry = known[img.repository]
    if (entry === undefined) {
      return fail(E_UNKNOWN_IMAGE, `${img.repository} has no entry in the image allowlist${where}`, all)
    }

    // 5. Pinned to a digest nobody approved.
    const approved = entry.approved_digests ?? []
    if (img.digest === null || !approved.includes(img.digest)) {
      return fail(
        E_DIGEST_MISMATCH,
        `${img.repository} is pinned to ${img.digest}, which is not an approved digest for this image${where}`,
        all,
      )
    }
  }

  return ok(all)
}

/** Full check for a deploy command. The entry point the gate calls. */
export function checkCommand(command: string, repoRoot: string, policy: ImagePolicy): Verdict {
  const { paths, readable } = manifestPathsFromCommand(command)
  const images = inlineImagesFromCommand(command)

  if (!readable) {
    return fail(
      E_MANIFEST_UNPARSEABLE,
      'the deploy reads from stdin or a remote URL, so its images cannot be verified before it runs',
    )
  }

  for (const p of paths) {
    const full = isAbsolute(p) ? p : join(repoRoot, p)
    if (!existsSync(full)) {
      return fail(E_MANIFEST_UNPARSEABLE, `${p} does not exist, so its images cannot be verified`)
    }
    let docs: unknown[]
    try {
      docs = loadYamlDocs(full)
    } catch (exc) {
      const name = exc instanceof Error ? exc.constructor.name : 'Error'
      return fail(
        E_MANIFEST_UNPARSEABLE,
        `${p} could not be parsed as YAML (${name}), so its images cannot be verified`,
      )
    }
    for (const doc of docs) {
      images.push(...extractImagesFromDoc(doc, p))
    }
  }

  // A deploy naming no image at all is not a provenance decision to make here
  // (`kubectl rollout restart`, `kubectl apply` of a ConfigMap). Let it pass;
  // the ordering floor and the snapshot rules still apply.
  if (images.length === 0) return ok([])

  return checkImages(images, policy)
}

/**
 * Check a manifest at authoring time, before it is ever applied.
 *
 * Lets the dashboard show the bad image being *written* a full turn before it
 * is *applied* — the write is flagged, the apply is blocked.
 */
export function checkWrittenManifest(path: string, content: string, policy: ImagePolicy): Verdict {
  let docs: unknown[]
  try {
    docs = parseAllDocuments(content)
      .map((d) => d.toJS())
      .filter((v) => v !== null && v !== undefined)
  } catch (exc) {
    const name = exc instanceof Error ? exc.constructor.name : 'Error'
    return fail(E_MANIFEST_UNPARSEABLE, `${path} is not valid YAML (${name})`)
  }
  const images: ImageRef[] = []
  for (const doc of docs) images.push(...extractImagesFromDoc(doc, path))
  if (images.length === 0) return ok([])
  return checkImages(images, policy)
}

/** True when this call should be image-checked. */
export function isDeployCommand(toolName: string, toolInput: unknown): boolean {
  return isDeploy(toolName, toolInput)
}
