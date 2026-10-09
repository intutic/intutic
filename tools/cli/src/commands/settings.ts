/**
 * `intutic settings` — read and change workspace settings.
 *
 * Subcommands:
 *   - `intutic settings get [key] [--json]`
 *   - `intutic settings set <key> [value] [--file <path>] [--json]`
 *
 * Server side: `GET` / `PUT /api/v1/workspace/settings`
 * (services/control-plane/src/routes/workspace.ts). One generic pair rather
 * than a command per setting: the route's strict schema is the authority on
 * which keys exist and what each accepts, and refuses an unknown key or a bad
 * value with a 400 naming it, so the CLI stays correct as settings are added.
 * The MCP policy (`mcpDefaultPolicy`, `mcpHighRiskToolChange`, `mcpBudgets`,
 * `mcpInjectionAction`, `mcpAnomalyMode`, …), the group policy
 * (`sso_group_policy`), the PII detector actions (`piiDetectors`) and
 * `configBodyUpload` are all set this way.
 *
 * The structured settings with a schema in `@intutic/shared-types` are
 * checked here first, so a mistake in a budgets, group-policy or detector
 * file is reported with the path of the field at fault rather than only the
 * top-level key the server's 400 names.
 *
 * @module
 */

import { McpBudgetSettingsSchema, PiiDetectorSettingsSchema, SsoGroupPolicySchema } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { fail, readJsonFile, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

interface SettingsResponse {
  workspaceId: string
  settings: Record<string, unknown>
}

/**
 * What is wrong with `value` for `key`, by field path, for the settings with
 * a schema in `@intutic/shared-types`; empty for every other key, which the
 * server checks.
 */
export function localProblems(key: string, value: unknown): string[] {
  const schema =
    key === 'mcpBudgets' ? McpBudgetSettingsSchema
    // `null` clears the policy.
    : key === 'sso_group_policy' ? SsoGroupPolicySchema.nullable()
    : key === 'piiDetectors' ? PiiDetectorSettingsSchema.nullable()
    : null
  if (!schema) return []
  const checked = schema.safeParse(value)
  if (checked.success) return []
  return checked.error.issues.map((i) => `${[key, ...i.path.map(String)].join('.')}: ${i.message}`)
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/**
 * A value given on the command line: JSON when it parses as JSON (`true`,
 * `30`, `null`, `["a","b"]`), the plain string otherwise (`deny`).
 */
export function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** `intutic settings get [key]` */
export async function runSettingsGet(key: string | undefined, opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    // Not `opts`: with a key, `--json` prints that value, not the whole response.
    { dev: opts.dev },
    'Failed to read workspace settings',
    (client) => client.get<SettingsResponse>('/api/v1/workspace/settings'),
    (res) => {
      if (key !== undefined) {
        const value = res.settings[key]
        if (opts.json) {
          console.log(JSON.stringify(value ?? null, null, 2))
        } else if (value === undefined) {
          log.dim(`${key} is not set.`)
        } else {
          console.log(formatValue(value))
        }
        return
      }
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2))
        return
      }
      log.header('Intutic — Workspace Settings')
      log.field('Workspace', res.workspaceId)
      for (const [name, value] of Object.entries(res.settings)) {
        log.field(name, typeof value === 'string' ? value : JSON.stringify(value))
      }
    },
  )
}

/** `intutic settings set <key> [value] [--file <path>]` */
export async function runSettingsSet(
  key: string,
  raw: string | undefined,
  opts: ApiCommandOpts & { file?: string },
): Promise<void> {
  if ((raw === undefined) === (opts.file === undefined)) {
    fail('Give the value either as an argument or with --file <path>, not both.')
  }
  const value = opts.file !== undefined ? readJsonFile(opts.file) : parseSettingValue(raw as string)

  const problems = localProblems(key, value)
  if (problems.length > 0) fail(`${key} is not valid:\n${problems.map((p) => `  ${p}`).join('\n')}`)

  await runApiCommand(
    opts,
    `Failed to update ${key}`,
    (client) => client.put<SettingsResponse & { updated: boolean }>('/api/v1/workspace/settings', { [key]: value }),
    (res) => {
      log.success(`${key} updated.`)
      const now = res.settings[key]
      if (now === undefined) log.dim(`  ${key} is now unset.`)
      else console.log(formatValue(now))
    },
  )
}
