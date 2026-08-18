import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkCommand,
  checkWrittenManifest,
  E_DIGEST_MISMATCH,
  E_MANIFEST_UNPARSEABLE,
  E_UNKNOWN_IMAGE,
  E_UNKNOWN_REGISTRY,
  E_UNPINNED_LATEST,
  E_UNPINNED_TAG,
  isDeployCommand,
  isPinned,
  type ImagePolicy,
  parseImageRef,
} from '../imagecheck.js'

// Port of packages/intutic-clawde/tests/test_gate_imagecheck.py.

const CATALOGUE = 'us-central1-docker.pkg.dev/intutic/intutic/sockshop/catalogue'
const GOOD_DIGEST = 'sha256:0147a65b7116569439eefb1a6dbed455fe022464ef70e0c3cab75bc4a226b39b'
const OTHER_DIGEST = 'sha256:' + 'b'.repeat(64)

const POLICY: ImagePolicy = {
  require_digest: true,
  registries_allowed: ['us-central1-docker.pkg.dev/intutic/intutic'],
  images: { [CATALOGUE]: { approved_digests: [GOOD_DIGEST] } },
}

function manifest(image: string, kind = 'Deployment'): string {
  return `
apiVersion: apps/v1
kind: ${kind}
metadata:
  name: catalogue
  namespace: sock-shop
spec:
  template:
    spec:
      containers:
        - name: catalogue
          image: ${image}
`
}

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'intutic-gate-imagecheck-'))
  mkdirSync(join(repo, 'k8s'))
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

function write(image: string, name = 'catalogue.yaml', kind = 'Deployment'): string {
  writeFileSync(join(repo, 'k8s', name), manifest(image, kind), 'utf-8')
  return `k8s/${name}`
}

describe('reference parsing', () => {
  it('parses a digest-pinned reference', () => {
    const r = parseImageRef(`${CATALOGUE}:0.3.5@${GOOD_DIGEST}`)
    expect(r.repository).toBe(CATALOGUE)
    expect(r.tag).toBe('0.3.5')
    expect(r.digest).toBe(GOOD_DIGEST)
    expect(isPinned(r)).toBe(true)
  })

  it('parses a tag-only reference', () => {
    const r = parseImageRef(`${CATALOGUE}:0.3.5`)
    expect(r.tag).toBe('0.3.5')
    expect(r.digest).toBeNull()
    expect(isPinned(r)).toBe(false)
  })

  it('parses a bare name with no tag', () => {
    const r = parseImageRef('mongo')
    expect(r.repository).toBe('mongo')
    expect(r.tag).toBeNull()
  })

  it('does not mistake a registry port for a tag', () => {
    const r = parseImageRef('localhost:5000/foo')
    expect(r.repository).toBe('localhost:5000/foo')
    expect(r.tag).toBeNull()
  })

  it('finds the tag after a registry port', () => {
    const r = parseImageRef('localhost:5000/foo:v1')
    expect(r.repository).toBe('localhost:5000/foo')
    expect(r.tag).toBe('v1')
  })
})

describe('failure codes', () => {
  it('blocks a :latest tag', () => {
    const rel = write(`${CATALOGUE}:latest`)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_LATEST)
  })

  it('blocks an untagged reference as latest', () => {
    const rel = write(CATALOGUE)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_LATEST)
  })

  it('blocks a real tag without a digest', () => {
    const rel = write(`${CATALOGUE}:0.3.5`)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_TAG)
  })

  it('blocks an unknown registry', () => {
    const rel = write(`docker.io/weaveworksdemos/catalogue:0.3.5@${GOOD_DIGEST}`)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNKNOWN_REGISTRY)
  })

  it('blocks an unreviewed image', () => {
    const other = 'us-central1-docker.pkg.dev/intutic/intutic/sockshop/not-reviewed'
    const rel = write(`${other}:1.0@${GOOD_DIGEST}`)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNKNOWN_IMAGE)
  })

  it('blocks a wrong digest', () => {
    const rel = write(`${CATALOGUE}:0.3.5@${OTHER_DIGEST}`)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_DIGEST_MISMATCH)
  })

  it('allows an approved digest', () => {
    const rel = write(`${CATALOGUE}:0.3.5@${GOOD_DIGEST}`)
    const v = checkCommand(`kubectl apply -f ${rel}`, repo, POLICY)
    expect(v.ok).toBe(true)
  })
})

describe('fail closed', () => {
  it('fails closed on a missing file', () => {
    const v = checkCommand('kubectl apply -f k8s/does-not-exist.yaml', repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_MANIFEST_UNPARSEABLE)
  })

  it('fails closed on stdin', () => {
    const v = checkCommand('kubectl apply -f -', repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_MANIFEST_UNPARSEABLE)
  })

  it('fails closed on a remote URL', () => {
    const v = checkCommand('kubectl apply -f https://example.com/x.yaml', repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_MANIFEST_UNPARSEABLE)
  })
})

describe('coverage', () => {
  it('checks every file in a directory apply', () => {
    write(`${CATALOGUE}:0.3.5@${GOOD_DIGEST}`, 'good.yaml')
    write(`${CATALOGUE}:latest`, 'bad.yaml')
    const v = checkCommand('kubectl apply -f k8s/', repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_LATEST)
  })

  it('reaches containers nested under a CronJob jobTemplate', () => {
    writeFileSync(
      join(repo, 'k8s', 'cron.yaml'),
      `
apiVersion: batch/v1
kind: CronJob
metadata: {name: reap}
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: reap
              image: ${CATALOGUE}:latest
`,
      'utf-8',
    )
    const v = checkCommand('kubectl apply -f k8s/cron.yaml', repo, POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_LATEST)
  })

  it('catches kubectl set image with no manifest at all', () => {
    const v = checkCommand(
      `kubectl set image deploy/catalogue catalogue=${CATALOGUE}:latest -n sock-shop`,
      repo,
      POLICY,
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_LATEST)
  })

  it('lets a rollout restart naming no image through', () => {
    const v = checkCommand('kubectl rollout restart deploy/catalogue -n sock-shop', repo, POLICY)
    expect(v.ok).toBe(true)
  })
})

describe('authoring-time check', () => {
  it('flags a written manifest with a bad image', () => {
    const v = checkWrittenManifest('k8s/catalogue.yaml', manifest(`${CATALOGUE}:latest`), POLICY)
    expect(v.ok).toBe(false)
    expect(v.code).toBe(E_UNPINNED_LATEST)
  })

  it('passes a written manifest with a good image', () => {
    const v = checkWrittenManifest('k8s/catalogue.yaml', manifest(`${CATALOGUE}:0.3.5@${GOOD_DIGEST}`), POLICY)
    expect(v.ok).toBe(true)
  })

  it('passes non-manifest content', () => {
    const v = checkWrittenManifest('k8s/notes.yaml', 'just: a value\n', POLICY)
    expect(v.ok).toBe(true)
  })
})

describe('trigger', () => {
  it('a deploy command triggers the check', () => {
    expect(isDeployCommand('shell', { command: 'kubectl apply -f k8s/' })).toBe(true)
  })

  it('a benign command does not', () => {
    expect(isDeployCommand('shell', { command: 'ls -la' })).toBe(false)
  })
})
