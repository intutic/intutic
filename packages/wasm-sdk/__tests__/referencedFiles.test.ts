/**
 * `readReferencedFile` (assembly/referencedFiles.ts) against a host shim that
 * answers the way the proxies' `read_referenced_file` does: a size query, then
 * the copy, or a negative code.
 *
 * The rule under test governs one manifest. It must refuse when it could not
 * read the manifest the call names — above all on `ERR_NOT_READ`, which is what
 * padding a command with decoy paths produces — and judge the bytes when it
 * could.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const genDir = join(sdkRoot, '.gen-test-reffile')

const RULE = `import { readReferencedFile } from "../assembly/referencedFiles";

export function allocate(size: i32): i32 {
  return 1024;
}

export function evaluate(offset: i32, len: i32): i32 {
  const manifest = readReferencedFile("k8s/prod.yaml");
  if (manifest.unread) return 1;
  if (manifest.code == 0 && String.UTF8.decode(manifest.bytes.buffer).includes(":latest")) return 1;
  return 0;
}
`

let wasm: WebAssembly.Module
let outDir: string

/** Async, never `spawnSync`: see dropInRules.test.ts for why. */
function asc(args: string[]): Promise<{ status: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'asc', ...args], { cwd: sdkRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d: Buffer) => { output += d.toString() })
    child.stderr.on('data', (d: Buffer) => { output += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code ?? -1, output }))
  })
}

beforeAll(async () => {
  mkdirSync(genDir, { recursive: true })
  outDir = mkdtempSync(join(tmpdir(), 'intutic-reffile-'))
  writeFileSync(join(genDir, 'rule.ts'), RULE)
  const out = join(outDir, 'rule.wasm')
  const res = await asc([join('.gen-test-reffile', 'rule.ts'), '-o', out, '--optimize', '--exportRuntime'])
  if (res.status !== 0) throw new Error(`asc failed:\n${res.output}`)
  wasm = new WebAssembly.Module(readFileSync(out))
}, 240_000)

afterAll(() => {
  rmSync(genDir, { recursive: true, force: true })
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

/** Evaluate the rule with the host answering `answer` for the one path it asks about. */
function evaluate(answer: number | string): number {
  let memory: WebAssembly.Memory | undefined
  const asked: string[] = []
  const env = {
    abort: () => {
      throw new Error('abort')
    },
    trace: () => {},
    read_referenced_file: (pathPtr: number, pathLen: number, outPtr: number, outCap: number): number => {
      asked.push(new TextDecoder().decode(new Uint8Array(memory!.buffer, pathPtr, pathLen)))
      if (typeof answer === 'number') return answer
      const bytes = new TextEncoder().encode(answer)
      if (outCap === 0) return bytes.length
      if (outCap < bytes.length) return -5
      new Uint8Array(memory!.buffer, outPtr, bytes.length).set(bytes)
      return bytes.length
    },
  }
  const instance = new WebAssembly.Instance(wasm, { env })
  memory = instance.exports['memory'] as WebAssembly.Memory
  const verdict = (instance.exports['evaluate'] as (o: number, l: number) => number)(0, 0)
  expect(asked.every((p) => p === 'k8s/prod.yaml')).toBe(true)
  return verdict
}

describe('readReferencedFile', () => {
  it('imports the host reader only in a rule that uses it', () => {
    const imports = WebAssembly.Module.imports(wasm).map((i) => `${i.module}.${i.name}`)
    expect(imports).toContain('env.read_referenced_file')
  })

  it('reads the bytes and lets the rule judge them', () => {
    expect(evaluate('image: app:latest')).toBe(1)
    expect(evaluate('image: app@sha256:0f00')).toBe(0)
  })

  it.each([
    ['ERR_NOT_READ (named past the limits)', -7],
    ['ERR_REFUSED (a guard, or no root)', -2],
    ['ERR_TOO_LARGE', -4],
    ['ERR_BUDGET', -6],
  ])('a manifest the rule could not read is refused: %s', (_name, code) => {
    expect(evaluate(code)).toBe(1)
  })

  it('a manifest named but absent is left to the rule', () => {
    expect(evaluate(-3)).toBe(0)
  })
})
