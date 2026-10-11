/**
 * Reading a chaos experiment file: YAML, checked against `ExperimentSchema`.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { ExperimentSchema, type Experiment } from '@intutic/shared-types'

export type ExperimentResult = { ok: true; experiment: Experiment } | { ok: false; errors: string[] }

/** Validate an experiment's text. Errors carry the path of the offending field. */
export function parseExperiment(text: string): ExperimentResult {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { ok: false, errors: [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const parsed = ExperimentSchema.safeParse(raw)
  if (parsed.success) return { ok: true, experiment: parsed.data }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const where = issue.path.length ? issue.path.map(String).join('.') : '(top level)'
      return `${where}: ${issue.message}`
    }),
  }
}

/** Read and validate an experiment file. */
export async function loadExperiment(file: string): Promise<ExperimentResult> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch (err) {
    return { ok: false, errors: [`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`] }
  }
  return parseExperiment(text)
}
