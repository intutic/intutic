import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  generateMobileconfig,
  generateJamfManifest,
  generateIntuneManifest,
  generateJamfFirewallManifest,
  generateIntuneFirewallManifest,
  pemToBase64Der,
} from './mdmManifest.js'

/** Wraps raw bytes as a PEM certificate, matching what `fs.readFile('ca.crt')` returns. */
function toPem(der: Buffer): string {
  const b64 = der.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

describe('pemToBase64Der', () => {
  it('round-trips a PEM cert back to the exact base64 DER payload it was built from', () => {
    const der = randomBytes(600)
    const pem = toPem(der)
    const extracted = pemToBase64Der(pem)
    expect(Buffer.from(extracted, 'base64')).toEqual(der)
  })
})

describe('generateMobileconfig', () => {
  const der = randomBytes(600)
  const caCertPem = toPem(der)

  it('embeds the actual CA certificate DER bytes as the payload data', () => {
    const xml = generateMobileconfig({ caCertPem })
    const match = xml.match(/<data>\n([\s\S]*?)\n\s*<\/data>/)
    expect(match).not.toBeNull()
    const embedded = match![1].replace(/\s+/g, '')
    expect(Buffer.from(embedded, 'base64')).toEqual(der)
  })

  it('does not include a proxy payload', () => {
    const xml = generateMobileconfig({ caCertPem })
    expect(xml).not.toContain('com.apple.proxy.http')
  })

  it('generates fresh UUIDs on every call', () => {
    const first = generateMobileconfig({ caCertPem })
    const second = generateMobileconfig({ caCertPem })
    const uuidsOf = (xml: string) => [...xml.matchAll(/<string>([0-9A-F-]{36})<\/string>/g)].map((m) => m[1])
    expect(uuidsOf(first)).not.toEqual(uuidsOf(second))
  })

  it('is well-formed plist XML with matching tags', () => {
    const xml = generateMobileconfig({ caCertPem })
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect((xml.match(/<dict>/g) ?? []).length).toBe((xml.match(/<\/dict>/g) ?? []).length)
    expect((xml.match(/<array>/g) ?? []).length).toBe((xml.match(/<\/array>/g) ?? []).length)
  })

  it('XML-escapes special characters in workspaceName', () => {
    const xml = generateMobileconfig({ caCertPem, workspaceName: 'R&D <Team> "One"' })
    expect(xml).toContain('R&amp;D &lt;Team&gt; &quot;One&quot;')
    expect(xml).not.toContain('R&D <Team>')
  })
})

describe('hooks manifests (Jamf / Intune)', () => {
  for (const [name, generate] of [
    ['generateJamfManifest', generateJamfManifest],
    ['generateIntuneManifest', generateIntuneManifest],
  ] as const) {
    describe(name, () => {
      it('contains no hardcoded homedir literal', () => {
        const json = generate({ hookScriptPath: '/opt/intutic/hooks/cursor-check.js' })
        expect(json).not.toContain('/Users/')
      })

      it('populates content from the real buildHooksConfig shape, referencing the real script filename', () => {
        const json = generate({ hookScriptPath: '/opt/intutic/hooks/cursor-check.js' })
        const parsed = JSON.parse(json)
        expect(parsed.content.hooks.beforeShellExecution.command).toBe('node "/opt/intutic/hooks/cursor-check.js"')
        expect(parsed.content.failClosed).toBe(true)
      })

      it('defaults target_path to the real macOS system hooks location, not /etc/cursor', () => {
        const json = generate({ hookScriptPath: '/opt/intutic/hooks/cursor-check.js', platform: 'darwin' })
        const parsed = JSON.parse(json)
        expect(parsed.target_path).toBe('/Library/Application Support/Cursor/hooks.json')
      })

      it('is valid JSON', () => {
        const json = generate({ hookScriptPath: '/opt/intutic/hooks/cursor-check.js' })
        expect(() => JSON.parse(json)).not.toThrow()
      })
    })
  }
})

describe('firewall deployment manifests (Jamf / Intune)', () => {
  const cliBinaryPath = '/opt/intutic/bin/intutic'

  // Real rule-generator output markers, grepped from packages/proxy/src/firewall.rs
  // (generate_pf_rules / generate_iptables_rules / generate_nftables_rules /
  // generate_windows_rules). None of these should ever appear in the MDM
  // manifest — it wraps the `enforce apply` COMMAND, not a rules snapshot,
  // because a snapshot generated here would immediately drift from whatever
  // firewall.rs generates at run time on the actual target platform.
  const RULE_SYNTAX_MARKERS = [
    'rdr pass', // pf
    'pass all', // pf
    'iptables', // iptables
    'REDIRECT --to-port', // iptables
    'table ip intutic', // nftables
    'redirect to :', // nftables
    'netsh interface portproxy', // windows
  ]

  for (const [name, generate] of [
    ['generateJamfFirewallManifest', generateJamfFirewallManifest],
    ['generateIntuneFirewallManifest', generateIntuneFirewallManifest],
  ] as const) {
    describe(name, () => {
      it('is valid JSON', () => {
        const json = generate({ cliBinaryPath })
        expect(() => JSON.parse(json)).not.toThrow()
      })

      it('wraps `enforce apply` as the content, using the given cliBinaryPath', () => {
        const json = generate({ cliBinaryPath })
        const parsed = JSON.parse(json)
        expect(parsed.content).toBe(`${cliBinaryPath} enforce apply`)
      })

      it('documents prerequisites, including the CLI install path and privileged execution context', () => {
        const json = generate({ cliBinaryPath })
        const parsed = JSON.parse(json)
        expect(Array.isArray(parsed.prerequisites)).toBe(true)
        expect(parsed.prerequisites.length).toBeGreaterThan(0)
        expect(parsed.prerequisites.join(' ')).toContain(cliBinaryPath)
      })

      it('states the honesty/guarantees boundary: scheduled re-assertion, not tamper-proof', () => {
        const json = generate({ cliBinaryPath })
        const parsed = JSON.parse(json)
        expect(typeof parsed.honesty).toBe('string')
        expect(parsed.honesty.toLowerCase()).toContain('not tamper-proof')
        expect(parsed.honesty.toLowerCase()).toContain('remove')
      })

      it('documents a recurrence/schedule', () => {
        const json = generate({ cliBinaryPath })
        const parsed = JSON.parse(json)
        expect(typeof parsed.schedule).toBe('string')
        expect(parsed.schedule.length).toBeGreaterThan(0)
      })

      it('does not embed any pf/nftables/iptables rule syntax', () => {
        const json = generate({ cliBinaryPath })
        for (const marker of RULE_SYNTAX_MARKERS) {
          expect(json).not.toContain(marker)
        }
      })
    })
  }

  it('Jamf and Intune manifests use distinct deployment-mechanism text', () => {
    const jamf = JSON.parse(generateJamfFirewallManifest({ cliBinaryPath }))
    const intune = JSON.parse(generateIntuneFirewallManifest({ cliBinaryPath }))
    expect(jamf.deployment.jamf).toBeDefined()
    expect(intune.deployment.intune).toBeDefined()
    expect(jamf.deployment.jamf).not.toBe(intune.deployment.intune)
    expect(jamf.deployment.jamf.toLowerCase()).toContain('jamf')
    expect(intune.deployment.intune.toLowerCase()).toContain('scripts')
  })
})
