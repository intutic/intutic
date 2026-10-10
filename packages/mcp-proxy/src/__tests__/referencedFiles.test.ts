/**
 * referencedFiles.test.ts — the `referenced_files.rs` `#[cfg(test)]` block,
 * ported case for case. Same inputs, same expected codes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  candidateTokens,
  readTokens,
  prefetch,
  resolveRoot,
  ReferencedFiles,
  MAX_REFERENCED_FILES,
  MAX_REFERENCED_FILE_BYTES,
  ERR_NOT_FOUND,
  ERR_NOT_READ,
  ERR_REFUSED,
  ERR_TOO_LARGE,
} from '../wasm/referencedFiles.js'

const call = (name: string, args: unknown) => [{ name, arguments: args }]
const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-mcp-reffiles-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})
const bytes = (r: ReturnType<ReferencedFiles['lookup']>) => (r.ok ? Buffer.from(r.bytes).toString() : r.code)

describe('candidateTokens', () => {
  it('a manifest named by a deploy command is a candidate', () => {
    expect(candidateTokens(call('Bash', { command: 'kubectl apply -f k8s/deploy.yaml' })).tokens).toEqual(['k8s/deploy.yaml'])
  })
  it('structured path arguments are candidates too', () => {
    expect(candidateTokens(call('Read', { file_path: 'infra/main.tf' })).tokens).toEqual(['infra/main.tf'])
  })
  it('a flag with an equals sign still yields the path', () => {
    expect(candidateTokens(call('Bash', { command: 'helm template --values=charts/prod.yaml .' })).tokens).toEqual(['charts/prod.yaml'])
  })
  it('quotes and shell separators do not hide a path', () => {
    expect(candidateTokens(call('Bash', { command: 'cd infra && kubectl apply -f "k8s/deploy.yaml"; echo done' })).tokens).toEqual(['k8s/deploy.yaml'])
  })
  it('a path without a manifest extension is never a candidate', () => {
    for (const command of ['cat README.md', 'python3 deploy.py', 'kubectl apply -f manifest', 'sh run.sh']) {
      expect(candidateTokens(call('Bash', { command })).tokens, command).toEqual([])
    }
  })
  it('candidates are deduped and capped', () => {
    const many = Array.from({ length: MAX_REFERENCED_FILES + 4 }, (_, i) => `m${i}.yaml`)
    const candidates = candidateTokens(call('Bash', { command: `kubectl apply -f ${many.join(' -f ')} -f ${many[0]}` }))
    expect(candidates.pastLimits).toBe(true)
    const tokens = candidates.tokens
    expect(tokens).toHaveLength(MAX_REFERENCED_FILES)
    expect(new Set(tokens).size).toBe(tokens.length)
  })
  it('non-object arguments are ignored', () => {
    expect(candidateTokens([{ name: 'x', arguments: 'kubectl apply -f a.yaml' }]).tokens).toEqual([])
    expect(candidateTokens([{ name: 'x', arguments: null }]).tokens).toEqual([])
  })
})

describe('paths past the limits', () => {
  it('eight decoys before the manifest that matters: it answers ERR_NOT_READ, not ERR_REFUSED', async () => {
    const root = await scratch()
    const decoys = Array.from({ length: MAX_REFERENCED_FILES }, (_, i) => `d${i}.yaml`)
    for (const d of decoys) await fs.writeFile(path.join(root, d), 'kind: ConfigMap')
    await fs.writeFile(path.join(root, 'prod.yaml'), 'image: app:latest')
    const files = await prefetch(call('Bash', { command: `kubectl apply -f ${decoys.join(' -f ')} -f prod.yaml` }), root)
    expect(bytes(files.lookup('d0.yaml'))).toBe('kind: ConfigMap')
    expect(bytes(files.lookup('prod.yaml'))).toBe(ERR_NOT_READ)
    // Within the limits, a path the call never named is still refused.
    expect(bytes((await prefetch(call('Bash', { command: 'kubectl apply -f d0.yaml' }), root)).lookup('prod.yaml'))).toBe(ERR_REFUSED)
  })
  it('a manifest named after 64 KiB of padding answers ERR_NOT_READ, and the flag survives the trip to the worker', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'prod.yaml'), 'image: app:latest')
    const command = `echo ${'x'.repeat(64 * 1024)}; kubectl apply -f prod.yaml`
    const candidates = candidateTokens(call('Bash', { command }))
    expect(candidates).toEqual({ tokens: [], pastLimits: true })
    const files = ReferencedFiles.fromTable(structuredClone((await prefetch(call('Bash', { command }), root)).toTable()))
    expect(bytes(files.lookup('prod.yaml'))).toBe(ERR_NOT_READ)
  })
})

describe('readTokens', () => {
  it('a glob is taken literally and simply fails to resolve', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'a.yaml'), 'x')
    const files = await prefetch(call('Bash', { command: 'kubectl apply -f *.yaml' }), root)
    expect(bytes(files.lookup('*.yaml'))).toBe(ERR_NOT_FOUND)
    expect(bytes(files.lookup('a.yaml'))).toBe(ERR_REFUSED)
  })
  it('a referenced manifest inside the root is readable', async () => {
    const root = await scratch()
    await fs.mkdir(path.join(root, 'k8s'))
    await fs.writeFile(path.join(root, 'k8s', 'deploy.yaml'), 'image: app:latest')
    const files = await prefetch(call('Bash', { command: 'kubectl apply -f k8s/deploy.yaml' }), root)
    expect(bytes(files.lookup('k8s/deploy.yaml'))).toBe('image: app:latest')
    expect(files.readableCount()).toBe(1)
  })
  it('a path the tool call did not name is refused', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'deploy.yaml'), 'a')
    await fs.writeFile(path.join(root, 'secrets.yaml'), 'b')
    const files = await prefetch(call('Bash', { command: 'kubectl apply -f deploy.yaml' }), root)
    expect(files.lookup('deploy.yaml').ok).toBe(true)
    expect(bytes(files.lookup('secrets.yaml'))).toBe(ERR_REFUSED)
    expect(files.refusalReason('secrets.yaml')).toBe("not referenced by this request's tool calls")
  })
  it('a referenced traversal is refused without touching the filesystem', async () => {
    const root = await scratch()
    const outside = await scratch()
    await fs.writeFile(path.join(outside, 'secret.yaml'), 'nope')
    const token = `../${path.basename(outside)}/secret.yaml`
    expect(candidateTokens(call('Bash', { command: `kubectl apply -f ${token}` })).tokens).toEqual([token])
    const files = await readTokens([token], root)
    expect(bytes(files.lookup(token))).toBe(ERR_REFUSED)
    expect(files.refusalReason(token)).toBe('contains a `..` component')
  })
  it('an absolute path outside the root is refused', async () => {
    const root = await scratch()
    const outside = await scratch()
    const token = path.join(outside, 'x.yaml')
    await fs.writeFile(token, 'nope')
    const files = await readTokens([token], root)
    expect(bytes(files.lookup(token))).toBe(ERR_REFUSED)
    expect(files.refusalReason(token)).toBe('resolves outside the configured manifest root')
  })
  it('an absolute path inside the root is readable', async () => {
    const root = await scratch()
    const token = path.join(await fs.realpath(root), 'pod.yaml')
    await fs.writeFile(token, 'kind: Pod')
    expect(bytes((await readTokens([token], root)).lookup(token))).toBe('kind: Pod')
  })
  it('a symlink leading out of the root is refused', async () => {
    const root = await scratch()
    const outside = await scratch()
    await fs.writeFile(path.join(outside, 'real.yaml'), 'nope')
    await fs.symlink(path.join(outside, 'real.yaml'), path.join(root, 'deploy.yaml'))
    const files = await readTokens(['deploy.yaml'], root)
    expect(bytes(files.lookup('deploy.yaml'))).toBe(ERR_REFUSED)
    expect(files.refusalReason('deploy.yaml')).toBe('resolves outside the configured manifest root')
  })
  it('a symlink staying inside the root is readable', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'real.yaml'), 'kind: Pod')
    await fs.symlink(path.join(root, 'real.yaml'), path.join(root, 'alias.yaml'))
    expect(bytes((await readTokens(['alias.yaml'], root)).lookup('alias.yaml'))).toBe('kind: Pod')
  })
  it('a directory is not a readable manifest', async () => {
    const root = await scratch()
    await fs.mkdir(path.join(root, 'charts.yaml'))
    const files = await readTokens(['charts.yaml'], root)
    expect(bytes(files.lookup('charts.yaml'))).toBe(ERR_REFUSED)
    expect(files.refusalReason('charts.yaml')).toBe('is not a regular file')
  })
  it('a missing file is a clean refusal, not a throw', async () => {
    const root = await scratch()
    const files = await readTokens(['nope.yaml'], root)
    expect(bytes(files.lookup('nope.yaml'))).toBe(ERR_NOT_FOUND)
    expect(files.refusalReason('nope.yaml')).toBe('does not exist')
  })
  it('an oversized file is capped and no prefix leaks', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'big.yaml'), Buffer.alloc(MAX_REFERENCED_FILE_BYTES + 1, 0x61))
    const files = await readTokens(['big.yaml'], root)
    expect(bytes(files.lookup('big.yaml'))).toBe(ERR_TOO_LARGE)
  })
  it('a file exactly at the cap is readable', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'exact.yaml'), Buffer.alloc(MAX_REFERENCED_FILE_BYTES, 0x61))
    const r = (await readTokens(['exact.yaml'], root)).lookup('exact.yaml')
    expect(r.ok && r.bytes.length).toBe(MAX_REFERENCED_FILE_BYTES)
  })
  it('a root that does not exist refuses everything without throwing', async () => {
    const files = await readTokens(['deploy.yaml'], path.join(os.tmpdir(), 'intutic-no-such-root-' + process.pid))
    expect(bytes(files.lookup('deploy.yaml'))).toBe(ERR_REFUSED)
    expect(files.refusalReason('deploy.yaml')).toBe('the configured manifest root does not resolve')
  })
  it('the capability is off when no root is configured', () => {
    const empty = ReferencedFiles.empty()
    expect(empty.isEmpty()).toBe(true)
    expect(bytes(empty.lookup('k8s/deploy.yaml'))).toBe(ERR_REFUSED)
    expect(resolveRoot({})).toBeUndefined()
    expect(resolveRoot({ INTUTIC_WASM_MANIFEST_ROOT: '' })).toBeUndefined()
    expect(resolveRoot({ INTUTIC_WASM_MANIFEST_ROOT: '~/m' })).toBe(path.join(os.homedir(), 'm'))
  })
  it('describe() does not print file contents and the table survives a round trip', async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, 'd.yaml'), 'super-secret-value')
    const files = await readTokens(['d.yaml'], root)
    const rendered = files.describe()
    expect(rendered).not.toContain('super-secret-value')
    expect(rendered).toContain('d.yaml => readable')
    const copy = ReferencedFiles.fromTable(structuredClone(files.toTable()))
    expect(bytes(copy.lookup('d.yaml'))).toBe('super-secret-value')
  })
})
