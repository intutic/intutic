/**
 * `intutic compliance coverage <framework_id>` — how the latest compliance
 * probe results cover one framework (EU AI Act, ISO/IEC 42001, NIST AI RMF,
 * MITRE ATLAS), as a summary or as the report file.
 *
 * Server side: `GET /api/v1/compliance/frameworks/:frameworkId/coverage`
 * (services/control-plane/src/routes/compliance.ts), `?format=` json,
 * markdown, csv or pdf. A live report is unsigned; the signed copies are the
 * ones sealed in the evidence pack.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { fail, runApiCommand, writeOutput, type ApiCommandOpts } from './apiCommand.js'

/** The CLI's format names, and the route's for each. */
const FORMATS = { json: 'json', md: 'markdown', csv: 'csv', pdf: 'pdf' } as const
type Format = keyof typeof FORMATS

interface FrameworkCoverage {
  frameworkId: string
  name: string
  mappingVersion: string
  generatedAt: string
  summary: {
    controls: number
    mapped: number
    full: number
    partial: number
    states: Record<string, number>
  }
}

interface CoverageOpts extends ApiCommandOpts {
  format?: string
  out?: string
}

/** `intutic compliance coverage <framework_id>` */
export async function runComplianceCoverage(frameworkId: string, opts: CoverageOpts): Promise<void> {
  const format = opts.format ?? (opts.json ? 'json' : undefined)
  const path = `/api/v1/compliance/frameworks/${encodeURIComponent(frameworkId)}/coverage`

  if (format === undefined) {
    await runApiCommand(
      opts,
      `Failed to read ${frameworkId} coverage`,
      (client) => client.get<FrameworkCoverage>(path),
      (c) => {
        log.header(`Intutic — ${c.name} coverage`)
        log.field('Controls', `${c.summary.controls} (${c.summary.mapped} mapped: ${c.summary.full} full, ${c.summary.partial} partial)`)
        for (const [state, count] of Object.entries(c.summary.states)) log.field(state, String(count))
        log.field('Mapping version', c.mappingVersion)
        log.field('Generated', c.generatedAt)
        log.dim('  The full report: --format md|csv|pdf --out <file>.')
      },
    )
    return
  }

  if (!Object.keys(FORMATS).includes(format)) fail(`--format must be one of ${Object.keys(FORMATS).join(', ')}, got "${format}"`)
  // A PDF written to a terminal is noise and a lost report; a pipe or a file is fine.
  if (format === 'pdf' && !opts.out && process.stdout.isTTY) {
    fail('A PDF report needs --out <file>, or redirect the output to a file.')
  }

  await runApiCommand(
    // The output is the report itself; `--json` only chose the format.
    { dev: opts.dev },
    `Failed to export ${frameworkId} coverage`,
    (client) => client.getFile(`${path}?format=${FORMATS[format as Format]}`),
    (bytes) => writeOutput(bytes, opts.out, `${frameworkId} coverage (${format})`),
  )
}
