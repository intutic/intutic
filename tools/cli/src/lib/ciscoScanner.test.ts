/**
 * ciscoScanner.ts — the opt-in Cisco `skill-scanner` shell-out.
 *
 * Mock-first: every test here runs against a FAKE `skill-scanner` binary — a
 * small Node script placed on PATH for the duration of each test (removed
 * from PATH afterward) — never the real Python-packaged tool. This keeps the
 * suite deterministic and dependency-free in CI, which does not (and should
 * not need to) have `pipx install skill-scanner` run anywhere.
 *
 * The fake binary's `scan` behaviour is driven by an env var
 * (`FIXTURE_MODE`) so each test can select clean / findings / no-analyzer /
 * slow-timeout output without juggling multiple fixture scripts.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ciscoScannerOnPath,
  ciscoScannerVersion,
  runCiscoScan,
  combineCiscoSarifRuns,
  CISCO_SCANNER_BINARY,
  CISCO_SCAN_TIMEOUT_MS,
} from './ciscoScanner.js'

/** A minimal fake `skill-scanner`. Understands just enough of the real CLI
 *  shape (`scan --path <dir> --format sarif --output <file>`, `--version`)
 *  to exercise `runCiscoScan`/`ciscoScannerVersion` without the real tool. */
const FAKE_SKILL_SCANNER = `#!/usr/bin/env node
const args = process.argv.slice(2)
const mode = process.env.FIXTURE_MODE || 'clean'

if (args.includes('--version')) {
  process.stdout.write('skill-scanner-fixture, version 0.3.3-test\\n')
  process.exit(0)
}

const outIdx = args.indexOf('--output')
const outFile = outIdx >= 0 ? args[outIdx + 1] : null
const pathIdx = args.indexOf('--path')
const scannedDir = pathIdx >= 0 ? args[pathIdx + 1] : ''

if (mode === 'no-analyzer') {
  process.stderr.write('No analyzers enabled for scan.\\n')
  process.exit(2)
}

{
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'skill-scanner', rules: mode === 'findings' ? [
          { id: 'skill-scanner/exfiltration', name: 'Exfiltration', shortDescription: { text: 'Exfiltration' } },
        ] : [] } },
        results: mode === 'findings' ? [
          {
            ruleId: 'skill-scanner/exfiltration',
            level: 'error',
            message: { text: 'Skill reads ~/.ssh/id_rsa and sends it to an external URL.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: scannedDir + '/SKILL.md' },
                  region: { startLine: 4 },
                },
              },
            ],
          },
        ] : [],
      },
    ],
  }
  if (outFile) require('fs').writeFileSync(outFile, JSON.stringify(sarif), 'utf8')
  process.exit(0)
}
`

describe('ciscoScanner (mock-first, against a fake skill-scanner binary)', () => {
  let binDir: string
  let originalPath: string | undefined

  beforeEach(async () => {
    binDir = await fs.mkdtemp(join(tmpdir(), 'intutic-cisco-fixture-'))
    const binPath = join(binDir, CISCO_SCANNER_BINARY)
    await fs.writeFile(binPath, FAKE_SKILL_SCANNER, { mode: 0o755 })
    originalPath = process.env.PATH
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    delete process.env.FIXTURE_MODE
    await fs.rm(binDir, { recursive: true, force: true })
  })

  function withFixtureOnPath() {
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
  }

  function withoutFixtureOnPath() {
    // A minimal PATH that cannot possibly resolve `skill-scanner`, whether
    // or not the developer running this suite happens to have the REAL tool
    // pipx-installed on their machine.
    process.env.PATH = '/usr/bin:/bin'
  }

  describe('ciscoScannerOnPath', () => {
    it('resolves true when the binary is on PATH', async () => {
      withFixtureOnPath()
      expect(await ciscoScannerOnPath()).toBe(true)
    })

    it('resolves false when the binary is absent from PATH', async () => {
      withoutFixtureOnPath()
      expect(await ciscoScannerOnPath()).toBe(false)
    })
  })

  describe('ciscoScannerVersion', () => {
    it('returns the trimmed --version output when present', async () => {
      withFixtureOnPath()
      expect(await ciscoScannerVersion()).toBe('skill-scanner-fixture, version 0.3.3-test')
    })

    it('returns null when the binary is absent', async () => {
      withoutFixtureOnPath()
      expect(await ciscoScannerVersion()).toBeNull()
    })
  })

  describe('runCiscoScan', () => {
    it('reports ok:false with a friendly message when the binary is absent (ENOENT)', async () => {
      withoutFixtureOnPath()
      const [result] = await runCiscoScan(['/some/skill/dir'])
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found on PATH')
      expect(result.error).toContain('pipx install skill-scanner')
      expect(result.findings).toEqual([])
    })

    it('returns ok:true with no findings for a clean scan', async () => {
      withFixtureOnPath()
      process.env.FIXTURE_MODE = 'clean'
      const [result] = await runCiscoScan(['/workspace/.claude/skills/demo'])
      expect(result.ok).toBe(true)
      expect(result.findings).toEqual([])
      expect(result.sarifRuns).toHaveLength(1)
    })

    it('parses a real finding out of the SARIF output', async () => {
      withFixtureOnPath()
      process.env.FIXTURE_MODE = 'findings'
      const dir = '/workspace/.claude/skills/demo'
      const [result] = await runCiscoScan([dir])
      expect(result.ok).toBe(true)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toMatchObject({
        ruleId: 'skill-scanner/exfiltration',
        level: 'error',
        filePath: `${dir}/SKILL.md`,
        line: 4,
      })
      expect(result.findings[0].message).toContain('id_rsa')
    })

    it('scans multiple directories, one invocation each', async () => {
      withFixtureOnPath()
      process.env.FIXTURE_MODE = 'findings'
      const results = await runCiscoScan(['/ws/a', '/ws/b'])
      expect(results).toHaveLength(2)
      expect(results[0].dir).toBe('/ws/a')
      expect(results[1].dir).toBe('/ws/b')
      expect(results[0].findings[0].filePath).toBe('/ws/a/SKILL.md')
      expect(results[1].findings[0].filePath).toBe('/ws/b/SKILL.md')
    })

    it('reports ok:false, not clean, when the tool exits with no analyzer configured', async () => {
      withFixtureOnPath()
      process.env.FIXTURE_MODE = 'no-analyzer'
      const [result] = await runCiscoScan(['/workspace/.claude/skills/demo'])
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
      expect(result.findings).toEqual([])
    })

    it('applies a bounded, generous timeout — not tested by actually hanging a process', () => {
      // A real hang test would need to wait out the full timeout (or fake
      // it), which is either slow or risks leaving an orphaned child
      // process in CI. This just pins the exported constant so a future
      // change to it is a deliberate, reviewed edit, not a silent drift —
      // see the module doc comment for why 60s vs the 3-5s every other
      // shell-out in this codebase uses.
      expect(CISCO_SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
    })
  })

  describe('combineCiscoSarifRuns', () => {
    it('returns null for an empty input', () => {
      expect(combineCiscoSarifRuns([])).toBeNull()
    })

    it('merges rule catalogs by id and concatenates results across runs', () => {
      const runA = {
        tool: { driver: { name: 'skill-scanner', rules: [{ id: 'skill-scanner/exfiltration' }] } },
        results: [{ ruleId: 'skill-scanner/exfiltration' }],
      }
      const runB = {
        tool: { driver: { name: 'skill-scanner', rules: [{ id: 'skill-scanner/command_execution' }] } },
        results: [{ ruleId: 'skill-scanner/command_execution' }],
      }
      const combined = combineCiscoSarifRuns([runA, runB]) as any
      expect(combined.tool.driver.name).toBe('skill-scanner')
      expect(combined.tool.driver.rules.map((r: any) => r.id).sort()).toEqual([
        'skill-scanner/command_execution',
        'skill-scanner/exfiltration',
      ])
      expect(combined.results).toHaveLength(2)
    })

    it('de-duplicates a rule id that appears in more than one run', () => {
      const runA = {
        tool: { driver: { name: 'skill-scanner', rules: [{ id: 'skill-scanner/exfiltration' }] } },
        results: [{ ruleId: 'skill-scanner/exfiltration' }],
      }
      const runB = {
        tool: { driver: { name: 'skill-scanner', rules: [{ id: 'skill-scanner/exfiltration' }] } },
        results: [{ ruleId: 'skill-scanner/exfiltration' }],
      }
      const combined = combineCiscoSarifRuns([runA, runB]) as any
      expect(combined.tool.driver.rules).toHaveLength(1)
      expect(combined.results).toHaveLength(2)
    })
  })
})
