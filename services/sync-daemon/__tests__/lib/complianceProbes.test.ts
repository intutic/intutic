import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as https from 'node:https'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import * as tls from 'node:tls'
import { checkHostContainment } from '../../src/lib/complianceProbes.js'

describe('Network Compliance Probes', () => {
  const tmpDir = path.join(process.cwd(), 'node_modules', '.tmp_certs')
  const intuticKey = path.join(tmpDir, 'intutic-key.pem')
  const intuticCert = path.join(tmpDir, 'intutic-cert.pem')
  const externalKey = path.join(tmpDir, 'external-key.pem')
  const externalCert = path.join(tmpDir, 'external-cert.pem')
  const caKey = path.join(tmpDir, 'ca-key.pem')
  const caCert = path.join(tmpDir, 'ca-cert.pem')
  const leafKey = path.join(tmpDir, 'leaf-key.pem')
  const leafCsr = path.join(tmpDir, 'leaf.csr')
  const leafCert = path.join(tmpDir, 'leaf-cert.pem')
  // The probes connect to an IP, so no SNI is sent and SNICallback never runs:
  // the server's default context is the certificate presented. Replace it.
  const use = (key: string, cert: string) => {
    serverCertToUse = { key: fs.readFileSync(key, 'utf-8'), cert: fs.readFileSync(cert, 'utf-8') }
    server!.setSecureContext(serverCertToUse)
  }

  let server: https.Server | null = null
  let serverPort = 0
  let serverCertToUse: { key: string; cert: string } | null = null

  beforeAll(() => {
    // 1. Create tmp dir for certs
    fs.mkdirSync(tmpDir, { recursive: true })

    // 2. Generate self-signed certs with openssl
    // Intutic CA (issuer has "Intutic")
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${intuticKey}" -out "${intuticCert}" ` +
        `-days 1 -nodes -subj "/O=Intutic Local CA/CN=localhost"`,
      { stdio: 'ignore' }
    )

    // A real CA and a leaf it signed, as the proxy's MITM presents.
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${caKey}" -out "${caCert}" ` +
        `-days 1 -nodes -subj "/O=Intutic Local CA/CN=Intutic CA"`,
      { stdio: 'ignore' }
    )
    execSync(
      `openssl req -newkey rsa:2048 -keyout "${leafKey}" -out "${leafCsr}" -nodes -subj "/CN=api.anthropic.com"`,
      { stdio: 'ignore' }
    )
    execSync(
      `openssl x509 -req -in "${leafCsr}" -CA "${caCert}" -CAkey "${caKey}" -CAcreateserial -out "${leafCert}" -days 1`,
      { stdio: 'ignore' }
    )

    // External CA (issuer does NOT have "Intutic")
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${externalKey}" -out "${externalCert}" ` +
        `-days 1 -nodes -subj "/O=DigiCert Global/CN=localhost"`,
      { stdio: 'ignore' }
    )

    // 3. Start a local HTTPS server on an ephemeral port
    serverCertToUse = {
      key: fs.readFileSync(intuticKey, 'utf-8'),
      cert: fs.readFileSync(intuticCert, 'utf-8'),
    }

    server = https.createServer({
      // We pass functions to dynamically load the cert/key based on our test setup
      SNICallback: (servername, cb) => {
        const secureContext = tls.createSecureContext({
          key: serverCertToUse!.key,
          cert: serverCertToUse!.cert,
        })
        cb(null, secureContext)
      },
      // Default key/cert if SNI doesn't match
      key: serverCertToUse.key,
      cert: serverCertToUse.cert,
    } as https.ServerOptions, (req, res) => {
      res.writeHead(200)
      res.end('OK')
    })

    return new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const address = server!.address()
        if (address && typeof address === 'object') {
          serverPort = address.port
        }
        resolve()
      })
    })
  })

  afterAll(async () => {
    // 1. Clean up cert files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // A leftover temp cert directory is not worth failing a run over.
    }

    // 2. Stop HTTPS server
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve())
      })
    }
  })

  it('counts a connection as contained when the certificate is one the Intutic CA issued', async () => {
    use(leafKey, leafCert)
    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, { caCertPem: fs.readFileSync(caCert, 'utf-8') })
    expect(result.contained).toBe(true)
    expect(result.incident).toBeUndefined()
  })

  it('counts the CA certificate itself as Intutic\'s', async () => {
    use(intuticKey, intuticCert)
    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, { caCertPem: fs.readFileSync(intuticCert, 'utf-8') })
    expect(result.contained).toBe(true)
  })

  // The check was the substring "Intutic" in the issuer or subject, which any
  // certificate can carry. It is now the CA's fingerprint and signature.
  it('does not take a certificate that merely says "Intutic" for the Intutic CA', async () => {
    use(intuticKey, intuticCert)
    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, { caCertPem: fs.readFileSync(caCert, 'utf-8') })
    expect(result.contained).toBe(false)
    expect(result.incident?.event).toBe('network_bypass')
  })

  it('reports a bypass when no Intutic CA is known to check against', async () => {
    use(leafKey, leafCert)
    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort)
    expect(result.contained).toBe(false)
  })

  it('should detect connection as uncontained when certificate issuer is NOT Intutic', async () => {
    use(externalKey, externalCert)

    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, { caCertPem: fs.readFileSync(caCert, 'utf-8') })
    expect(result.contained).toBe(false)
    expect(result.incident).toBeDefined()
    expect(result.incident?.event).toBe('network_bypass')
    expect(result.incident?.toolName).toBe('127.0.0.1')
    expect(result.incident?.workspaceId).toBe('ws_test')
    expect(result.incident?.reason).toContain('bypassed proxy containment rules')
    expect(result.incident?.eventId, 'the id the control plane processes each event once by').toMatch(/^[0-9a-f]{32}$/)
  })

  // The control plane files one incident per BypassRef; per detection, every
  // sync filed another CRITICAL incident.
  it('gives every bypass a machine reports on one day the same reference, and each its own event id', async () => {
    use(externalKey, externalCert)
    const opts = { caCertPem: fs.readFileSync(caCert, 'utf-8'), machineId: 'machine-1' }
    const a = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, opts)
    const b = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, opts)
    const other = await checkHostContainment('127.0.0.1', 'ws_test', serverPort, { ...opts, machineId: 'machine-2' })
    expect(a.incident?.incidentId).toBe(b.incident?.incidentId)
    expect(a.incident?.eventId).not.toBe(b.incident?.eventId)
    expect(other.incident?.incidentId).not.toBe(a.incident?.incidentId)
  })

  it('should handle connection failure (e.g. refused connection) as contained', async () => {
    // Use an unused port where no server is running
    const result = await checkHostContainment('127.0.0.1', 'ws_test', 59999)
    expect(result.contained).toBe(true)
    expect(result.error).toBeDefined()
    expect(result.incident).toBeUndefined()
  })
})
