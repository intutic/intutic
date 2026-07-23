/**
 * configWriterSopRef.test.ts — Tests SOP pointer injection in config files.
 *
 * Verifies that sopRef comments (<!-- sop://intutic/{sopId} -->) are
 * correctly embedded in harness config files alongside full SOP content.
 *
 * LLD #51 — Phase B Verification
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { writeConfigFiles } from '../../src/configWriter.js'
import { HarnessType, type SyncSopEntry } from '@intutic/shared-types'

describe('Config Writer — SOP Pointer Injection', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-configwriter-'))
  })

  it('embeds sop:// pointer comment in .cursorrules when sopRef is present', async () => {
    const sops: SyncSopEntry[] = [{
      sopId: 'sop_abc123',
      title: 'No Destructive Commands',
      content: 'Do not run rm -rf or any destructive file operations.',
      contentHash: 'deadbeef',
      harnessTargets: [HarnessType.CURSOR],
      sopRef: '<!-- sop://intutic/sop_abc123 | No Destructive Commands -->',
    }]

    // Signature: (workspaceRoot, sops, proxyUrl, harnesses, workspaceId?)
    await writeConfigFiles(tmpDir, sops, 'http://proxy:4000', [HarnessType.CURSOR], 'wk_test')
    const content = await node_fs.readFile(node_path.join(tmpDir, '.cursorrules'), 'utf-8')

    // Full content should be present
    expect(content).toContain('Do not run rm -rf')
    // SOP pointer comment should be present
    expect(content).toContain('<!-- sop://intutic/sop_abc123 | No Destructive Commands -->')
  })

  it('does NOT embed sop:// comment when sopRef is undefined', async () => {
    const sops: SyncSopEntry[] = [{
      sopId: 'sop_legacy',
      title: 'Legacy Rule',
      content: 'Use TypeScript strict mode.',
      contentHash: 'cafebabe',
      harnessTargets: [HarnessType.CURSOR],
      // sopRef is intentionally omitted
    }]

    await writeConfigFiles(tmpDir, sops, 'http://proxy:4000', [HarnessType.CURSOR], 'wk_test')
    const content = await node_fs.readFile(node_path.join(tmpDir, '.cursorrules'), 'utf-8')

    expect(content).toContain('Use TypeScript strict mode')
    expect(content).not.toContain('sop://')
  })

  it('embeds multiple sop:// pointers for multiple SOPs', async () => {
    const sops: SyncSopEntry[] = [
      {
        sopId: 'sop_1',
        title: 'Rule One',
        content: 'First rule content.',
        contentHash: 'hash1',
        harnessTargets: [HarnessType.CURSOR],
        sopRef: '<!-- sop://intutic/sop_1 | Rule One -->',
      },
      {
        sopId: 'sop_2',
        title: 'Rule Two',
        content: 'Second rule content.',
        contentHash: 'hash2',
        harnessTargets: [HarnessType.CURSOR],
        sopRef: '<!-- sop://intutic/sop_2 | Rule Two -->',
      },
    ]

    await writeConfigFiles(tmpDir, sops, 'http://proxy:4000', [HarnessType.CURSOR], 'wk_test')
    const content = await node_fs.readFile(node_path.join(tmpDir, '.cursorrules'), 'utf-8')

    expect(content).toContain('<!-- sop://intutic/sop_1 | Rule One -->')
    expect(content).toContain('<!-- sop://intutic/sop_2 | Rule Two -->')
    expect(content).toContain('First rule content.')
    expect(content).toContain('Second rule content.')
  })

  it('loads and writes local sops when configured in session-context.json', async () => {
    // 1. Create local sops directory structure
    const intuticDir = node_path.join(tmpDir, '.intutic')
    const sopsDir = node_path.join(intuticDir, 'sops')
    await node_fs.mkdir(node_path.join(sopsDir, 'security-dlp'), { recursive: true })
    await node_fs.mkdir(node_path.join(sopsDir, 'db-migration'), { recursive: true })

    await node_fs.writeFile(
      node_path.join(sopsDir, 'security-dlp', 'dlp.md'),
      'Strictly avoid committing private keys.',
      'utf-8'
    )
    await node_fs.writeFile(
      node_path.join(sopsDir, 'db-migration', 'migration.md'),
      'Always use drizzle migrations.',
      'utf-8'
    )

    // 2. Configure session-context.json to select only security-dlp
    await node_fs.writeFile(
      node_path.join(intuticDir, 'session-context.json'),
      JSON.stringify({ activeLocalSops: ['security-dlp'] }),
      'utf-8'
    )

    // 3. Write config files
    await writeConfigFiles(tmpDir, [], 'http://proxy:4000', [HarnessType.CURSOR], 'wk_test')
    const content = await node_fs.readFile(node_path.join(tmpDir, '.cursorrules'), 'utf-8')

    // Only security-dlp local rules should be present
    expect(content).toContain('Strictly avoid committing private keys')
    expect(content).not.toContain('Always use drizzle migrations')
  })
})
