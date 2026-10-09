/**
 * Every `ControlPlaneClient` method against
 * packages/shared-types/fixtures/control-plane-operations.json, the list the
 * Python SDK's `tests/test_control_plane_operations.py` runs too: the method
 * set must equal the list's, and each method must make the listed request and
 * return the listed answer. A method added to one SDK and not the other, or a
 * call that drifts, fails here or there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ControlPlaneClient } from '../src/control-plane'
import { ClawdeConnectionError } from '../src/errors'
import * as sdk from '../src/index'

interface Vector {
  ts: string
  py: string
  cli: string | null
  args?: unknown[]
  options?: Record<string, unknown>
  tsArgs?: unknown[]
  request: {
    method: string
    path: string
    auth?: boolean
    body?: unknown
    multipart?: {
      file: { field: string; fileName: string; contentType: string; text: string }
      fields: Record<string, string>
    }
  }
  response: { status: number; body?: unknown; text?: string; contentType?: string }
  returns?: unknown
  returnsText?: string
}

interface ErrorVector {
  ts: string
  args: unknown[]
  response: { status: number; body: unknown }
  message: string
}

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../../shared-types/fixtures/control-plane-operations.json'), 'utf-8'),
) as {
  operations: Vector[]
  errors: ErrorVector[]
  offline: Array<{ ts: string; py: string; cli: string; keys: string; vectors: string }>
}

/** `{ "$bytes": text }` in the fixture is a bytes argument. */
function decodeArg(arg: unknown): unknown {
  if (arg && typeof arg === 'object' && '$bytes' in arg) return new TextEncoder().encode((arg as { $bytes: string }).$bytes)
  return arg
}

function callArgs(v: { args?: unknown[]; options?: Record<string, unknown>; tsArgs?: unknown[] }): unknown[] {
  if (v.tsArgs) return v.tsArgs.map(decodeArg)
  const args = (v.args ?? []).map(decodeArg)
  return v.options ? [...args, v.options] : args
}

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

describe('ControlPlaneClient operations (shared with the Python SDK)', () => {
  let server: Server
  let baseUrl: string
  let received: { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }
  let respond: { status: number; body?: unknown; text?: string; contentType?: string }

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
            if (respond.text !== undefined) {
              res.writeHead(respond.status, { 'Content-Type': respond.contentType ?? 'text/plain' })
              res.end(respond.text)
            } else {
              res.writeHead(respond.status, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(respond.body))
            }
          })
        })
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number }
          baseUrl = `http://127.0.0.1:${addr.port}`
          resolve()
        })
      }),
  )

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const client = () => new ControlPlaneClient({ apiKey: 'vk_test', baseUrl })
  const invoke = (c: ControlPlaneClient, name: string, args: unknown[]) =>
    (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args)

  it('has exactly the methods the shared list names, and the Python names are their snake_case', () => {
    const source = readFileSync(join(__dirname, '../src/control-plane.ts'), 'utf-8')
    const declared = [...source.matchAll(/public async (\w+)\(/g)].map((m) => m[1]).sort()
    expect(declared).toEqual(FIXTURE.operations.map((v) => v.ts).sort())
    for (const v of FIXTURE.operations) expect(v.py).toBe(snake(v.ts))
  })

  it('exports exactly the offline checks the shared list names, each with its key fetch and its CLI fixture', () => {
    const exported = Object.keys(sdk).filter((name) => /^verify[A-Z]/.test(name)).sort()
    expect(exported).toEqual(FIXTURE.offline.map((o) => o.ts).sort())
    for (const o of FIXTURE.offline) {
      expect(o.py).toBe(snake(o.ts))
      expect(FIXTURE.operations.some((v) => v.ts === o.keys)).toBe(true)
      expect(() => readFileSync(join(__dirname, '../../..', o.vectors))).not.toThrow()
    }
  })

  for (const v of FIXTURE.operations) {
    it(`${v.ts}() → ${v.request.method} ${v.request.path}`, async () => {
      respond = v.response
      const result = await invoke(client(), v.ts, callArgs(v))

      expect(received.method).toBe(v.request.method)
      expect(received.url).toBe(v.request.path)
      expect(received.headers['authorization']).toBe(v.request.auth === false ? undefined : 'Bearer vk_test')

      if (v.request.multipart) {
        const { file, fields } = v.request.multipart
        const raw = received.body.toString('utf-8')
        expect(received.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
        expect(raw).toContain(`name="${file.field}"; filename="${file.fileName}"`)
        expect(raw).toContain(`Content-Type: ${file.contentType}`)
        expect(raw).toContain(file.text)
        for (const [name, value] of Object.entries(fields)) expect(raw).toMatch(new RegExp(`name="${name}"\\r\\n\\r\\n${value}\\r\\n`))
      } else if ('body' in v.request) {
        expect(JSON.parse(received.body.toString('utf-8'))).toEqual(v.request.body)
      } else {
        expect(received.body.length).toBe(0)
      }

      if (v.returnsText !== undefined) {
        expect(result).toBeInstanceOf(Uint8Array)
        expect(new TextDecoder().decode(result as Uint8Array)).toBe(v.returnsText)
      } else {
        expect(result ?? null).toEqual(v.returns)
      }
    })
  }

  for (const e of FIXTURE.errors) {
    it(`${e.ts}() throws ClawdeConnectionError: ${e.message}`, async () => {
      respond = e.response
      const err = await invoke(client(), e.ts, e.args).catch((x: unknown) => x)
      expect(err).toBeInstanceOf(ClawdeConnectionError)
      expect((err as Error).message).toBe(e.message)
    })
  }

  it('refuses a coverage format the route does not serve, before any request', async () => {
    await expect(client().downloadFrameworkCoverage('eu_ai_act', 'docx' as never)).rejects.toThrow('format must be one of json, md, csv, pdf')
  })

  it('reports an unreachable control plane as ClawdeConnectionError', async () => {
    const offline = new ControlPlaneClient({ apiKey: 'vk_test', baseUrl: 'http://127.0.0.1:1' })
    await expect(offline.listMcpServers()).rejects.toThrow(/Could not reach control plane/)
  })
})
