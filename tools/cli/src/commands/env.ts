/**
 * env.ts — Persist or clear the proxy base-URL environment variables.
 *
 * `lib/envInjector.ts` implements system-level injection for macOS
 * (`launchctl setenv`), Linux (`~/.bashrc`) and Windows (`setx`). It shipped
 * under a ✅ RESOLVED marker with a full test file and **no caller anywhere** —
 * so the capability the entry described could not be invoked. This is the
 * route it never had (TD-041).
 *
 * Deliberately opt-in rather than a side effect of `intutic start` or
 * `intutic connect`: on macOS `launchctl setenv` reaches every GUI application
 * the user launches afterwards, and on Linux it appends to a shell profile.
 * Neither belongs in a command the user ran for another reason.
 *
 * @module
 */
import { log } from '../lib/logger.js'
import {
  injectBaseUrlEnvVars,
  removeBaseUrlEnvVars,
  PlatformNotSupportedError,
  ElevationRequiredError,
} from '../lib/envInjector.js'

/** Persist ANTHROPIC_BASE_URL / OPENAI_BASE_URL so they survive a restart. */
export async function runEnvPersist(opts: { proxyUrl?: string }): Promise<void> {
  const proxyUrl = opts.proxyUrl ?? 'http://localhost:4000'

  try {
    const result = await injectBaseUrlEnvVars(proxyUrl)
    log.success(`Persisted ${result.vars.join(', ')} → ${proxyUrl}`)
    log.field('Platform', result.platform)
    log.field('Scope', result.scope)
    log.field('Method', result.method)
    log.info('')
    log.info('Already-open terminals keep their old environment — restart them,')
    log.info('or re-source your shell profile, before the change is visible.')
    log.info('')
    log.info('Undo with: intutic env clear')
  } catch (err) {
    if (err instanceof PlatformNotSupportedError) {
      log.error(`${err.message}`)
      log.info('Set ANTHROPIC_BASE_URL and OPENAI_BASE_URL by hand, or use `intutic exec`,')
      log.info('which sets them for one child process without touching your system.')
      process.exit(1)
    }
    if (err instanceof ElevationRequiredError) {
      log.error(`${err.message}`)
      log.info('Re-run with the privileges that path needs, or use `intutic exec` instead.')
      process.exit(1)
    }
    throw err
  }
}

/** Remove whatever `intutic env persist` wrote. */
export async function runEnvClear(): Promise<void> {
  await removeBaseUrlEnvVars()
  log.success('Cleared the persisted base-URL environment variables.')
  log.info('Already-open terminals keep the old values until they are restarted.')
}
