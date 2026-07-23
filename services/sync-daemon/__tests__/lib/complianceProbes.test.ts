import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as https from 'node:https'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { checkHostContainment, runComplianceProbes } from '../../src/lib/complianceProbes.js'

describe('Network Compliance Probes', () => {
  const tmpDir = path.join(process.cwd(), 'node_modules', '.tmp_certs')
  const intuticKey = path.join(tmpDir, 'intutic-key.pem')
  const intuticCert = path.join(tmpDir, 'intutic-cert.pem')
  const externalKey = path.join(tmpDir, 'external-key.pem')
  const externalCert = path.join(tmpDir, 'external-cert.pem')

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
    } as any, (req, res) => {
      res.writeHead(200)
      res.end('OK')
    })

    // Import tls module for SNICallback context creation
    const tls = require('node:tls')

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
    } catch {}

    // 2. Stop HTTPS server
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve())
      })
    }
  })

  it('should detect connection as contained when certificate issuer is Intutic', async () => {
    // Set server to use the Intutic certificate
    serverCertToUse = {
      key: fs.readFileSync(intuticKey, 'utf-8'),
      cert: fs.readFileSync(intuticCert, 'utf-8'),
    }

    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort)
    expect(result.contained).toBe(true)
    expect(result.incident).toBeUndefined()
  })

  it('should detect connection as uncontained when certificate issuer is NOT Intutic', async () => {
    // Set server to use the External certificate
    serverCertToUse = {
      key: fs.readFileSync(externalKey, 'utf-8'),
      cert: fs.readFileSync(externalCert, 'utf-8'),
    }

    const result = await checkHostContainment('127.0.0.1', 'ws_test', serverPort)
    expect(result.contained).toBe(false)
    expect(result.incident).toBeDefined()
    expect(result.incident?.event).toBe('network_bypass')
    expect(result.incident?.toolName).toBe('127.0.0.1')
    expect(result.incident?.workspaceId).toBe('ws_test')
    expect(result.incident?.reason).toContain('bypassed proxy containment rules')
  })

  it('should handle connection failure (e.g. refused connection) as contained', async () => {
    // Use an unused port where no server is running
    const result = await checkHostContainment('127.0.0.1', 'ws_test', 59999)
    expect(result.contained).toBe(true)
    expect(result.error).toBeDefined()
    expect(result.incident).toBeUndefined()
  })
})
