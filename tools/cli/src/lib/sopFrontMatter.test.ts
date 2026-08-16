import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { parseSopFile, renderSopFile, slugifyTitle, titleFromFileName } from './sopFrontMatter.js'

describe('parseSopFile', () => {
  it('splits front matter from body and reads title/risk_tier/version', () => {
    const raw = [
      '---',
      'title: Postgres Migration',
      'risk_tier: high',
      'version: 2.1.0',
      '---',
      '',
      'Never run a migration without a backup.',
      '',
    ].join('\n')

    const parsed = parseSopFile(raw)
    expect(parsed.title).toBe('Postgres Migration')
    expect(parsed.riskTier).toBe('HIGH')
    expect(parsed.version).toBe('2.1.0')
    expect(parsed.contentHash).toBeNull()
    expect(parsed.body).toBe('Never run a migration without a backup.')
  })

  it('falls back to the first H1 heading when there is no title: key', () => {
    const raw = '---\nrisk_tier: low\n---\n# Deploy Checklist\nRun tests first.'
    expect(parseSopFile(raw).title).toBe('Deploy Checklist')
  })

  it('is null for title, risk_tier and version when nothing declares them', () => {
    const parsed = parseSopFile('Just prose, no front matter at all.')
    expect(parsed.title).toBeNull()
    expect(parsed.riskTier).toBeNull()
    expect(parsed.version).toBeNull()
    expect(parsed.body).toBe('Just prose, no front matter at all.')
  })

  it('an unrecognised risk_tier reads as null rather than a guess', () => {
    const parsed = parseSopFile('---\nrisk_tier: extreme\n---\nbody')
    expect(parsed.riskTier).toBeNull()
  })

  it('an unterminated fence treats the whole file as body, matching the Rust parser', () => {
    const raw = '---\ntitle: Incomplete\nno closing fence here'
    const parsed = parseSopFile(raw)
    expect(parsed.body).toBe(raw.trim())
    expect(parsed.title).toBeNull()
  })

  it('reads a previously-recorded content_hash so pull can detect local edits', () => {
    const raw = '---\ncontent_hash: abc123\n---\nbody text'
    expect(parseSopFile(raw).contentHash).toBe('abc123')
  })

  it('strips quotes around scalar values', () => {
    const parsed = parseSopFile('---\ntitle: "Quoted Title"\nversion: \'1.2.3\'\n---\nbody')
    expect(parsed.title).toBe('Quoted Title')
    expect(parsed.version).toBe('1.2.3')
  })
})

describe('renderSopFile round-trips through parseSopFile', () => {
  it('the content_hash it writes matches the body it wrote', () => {
    const rendered = renderSopFile({
      title: 'Round Trip SOP',
      riskTier: 'MEDIUM',
      version: '1.0.0',
      body: 'Do the thing carefully.',
    })
    const parsed = parseSopFile(rendered)
    expect(parsed.title).toBe('Round Trip SOP')
    expect(parsed.riskTier).toBe('MEDIUM')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.body).toBe('Do the thing carefully.')
    expect(parsed.contentHash).toHaveLength(64) // sha256 hex

    // Recomputing the hash of the parsed body must reproduce exactly the
    // recorded value — this is the invariant runSopsPull's dirty check
    // depends on.
    const recomputed = createHash('sha256').update(parsed.body, 'utf8').digest('hex')
    expect(parsed.contentHash).toBe(recomputed)
  })

  it('a different body produces a different recorded hash', () => {
    const a = renderSopFile({ title: 't', riskTier: 'LOW', version: '1.0.0', body: 'one' })
    const b = renderSopFile({ title: 't', riskTier: 'LOW', version: '1.0.0', body: 'two' })
    expect(parseSopFile(a).contentHash).not.toBe(parseSopFile(b).contentHash)
  })
})

describe('slugifyTitle', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyTitle('Deploy Checklist')).toBe('deploy-checklist')
  })

  it('strips punctuation and collapses runs of separators', () => {
    expect(slugifyTitle('Postgres: Migration!! (v2)')).toBe('postgres-migration-v2')
  })

  it('falls back to "untitled" for a title with nothing sluggable', () => {
    expect(slugifyTitle('!!!')).toBe('untitled')
  })
})

describe('titleFromFileName', () => {
  it('splits on hyphens and underscores and capitalizes each word', () => {
    expect(titleFromFileName('postgres-migration.md')).toBe('Postgres Migration')
    expect(titleFromFileName('deploy_checklist.md')).toBe('Deploy Checklist')
  })
})
