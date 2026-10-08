/**
 * Environment Variable Injector
 *
 * Injects ANTHROPIC_BASE_URL and OPENAI_BASE_URL as persistent
 * environment variables that new terminals and applications pick up, and
 * removes them again.
 *
 * Platform support:
 *   macOS:   launchctl setenv <KEY> <VALUE> (until logout)
 *   Linux:   /etc/environment when writable (root), else ~/.bashrc
 *   Windows: setx <KEY> <VALUE> (user-level, no /M)
 *
 * @module
 */
import { execSync } from 'node:child_process'
import fs   from 'node:fs'
import path from 'node:path'
import os   from 'node:os'
import { createLogger } from '@intutic/logger'

const logger = createLogger('envInjector')

const ENV_VARS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'] as const

export interface InjectionResult {
  platform:  NodeJS.Platform
  scope:     'system' | 'user'
  vars:      string[]
  method:    string
}

/**
 * Where the injector reads and writes. Defaults to the real machine; tests
 * pass temporary paths and a recording `exec` so they never touch it.
 */
export interface EnvInjectorTarget {
  platform?: NodeJS.Platform
  /** The user's `~/.bashrc`. */
  bashrc?: string
  /** The system-wide file used on Linux when it is writable. */
  etcEnvironment?: string
  exec?: (command: string) => void
}

function resolveTarget(t: EnvInjectorTarget = {}): Required<EnvInjectorTarget> {
  return {
    platform: t.platform ?? os.platform(),
    bashrc: t.bashrc ?? path.join(os.homedir(), '.bashrc'),
    etcEnvironment: t.etcEnvironment ?? '/etc/environment',
    exec: t.exec ?? ((command) => { execSync(command, { stdio: 'pipe' }) }),
  }
}

export class PlatformNotSupportedError extends Error {
  constructor(platform: string) {
    super(`Platform not supported for env injection: ${platform}`)
    this.name = 'PlatformNotSupportedError'
  }
}

function sanitizeShellValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}

function bashrcMarker(key: string): string {
  return `# intutic-env-${key}`
}

/** `text` without the lines `drop` matches, and otherwise byte for byte. */
function withoutLines(text: string, drop: (line: string) => boolean): string {
  return text.split('\n').filter((l) => !drop(l)).join('\n')
}

function isWritable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function linuxInjectUser(bashrc: string, value: string): void {
  let content = ''
  try {
    content = fs.readFileSync(bashrc, 'utf8')
  } catch (err) {
    // A missing ~/.bashrc is the normal first-run case; the write below
    // creates it. Any other read failure must not end in the file being
    // replaced by our two lines.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  let next = withoutLines(content, (l) => ENV_VARS.some((key) => l.includes(bashrcMarker(key))))
  if (next !== '' && !next.endsWith('\n')) next += '\n'
  for (const key of ENV_VARS) next += `export ${key}="${sanitizeShellValue(value)}" ${bashrcMarker(key)}\n`
  fs.writeFileSync(bashrc, next, { mode: 0o644 })
}

/** Removes exactly the marked lines `linuxInjectUser` added. */
function linuxRemoveUser(bashrc: string): void {
  let content: string
  try {
    content = fs.readFileSync(bashrc, 'utf8')
  } catch {
    return // Nothing to remove.
  }
  const next = withoutLines(content, (l) => ENV_VARS.some((key) => l.includes(bashrcMarker(key))))
  if (next !== content) fs.writeFileSync(bashrc, next)
}

/**
 * pam_env reads /etc/environment and has no trailing comments, so these
 * lines carry no marker: `KEY=` lines for the two variables are ours to
 * replace and to remove, the same as on the way in.
 */
function linuxSetSystem(etcEnvironment: string, value: string | null): void {
  const content = fs.readFileSync(etcEnvironment, 'utf8')
  let next = withoutLines(content, (l) => ENV_VARS.some((key) => l.startsWith(`${key}=`)))
  if (value !== null) {
    if (next !== '' && !next.endsWith('\n')) next += '\n'
    for (const key of ENV_VARS) next += `${key}="${sanitizeShellValue(value)}"\n`
  }
  if (next !== content) fs.writeFileSync(etcEnvironment, next)
}

/**
 * Injects ANTHROPIC_BASE_URL and OPENAI_BASE_URL as persistent env vars.
 *
 * @param proxyUrl - The Intutic proxy URL (e.g. https://proxy.acme.intutic.ai)
 * @returns InjectionResult describing what was done
 */
export async function injectBaseUrlEnvVars(proxyUrl: string, target?: EnvInjectorTarget): Promise<InjectionResult> {
  const t = resolveTarget(target)
  const platform = t.platform
  logger.info({ platform, proxyUrl }, 'envInjector.inject_start')

  if (platform === 'darwin') {
    for (const key of ENV_VARS) t.exec(`launchctl setenv ${key} "${sanitizeShellValue(proxyUrl)}"`)
    logger.info({ platform, vars: ENV_VARS }, 'envInjector.macos_launchctl_set')
    return { platform, scope: 'system', vars: [...ENV_VARS], method: 'launchctl setenv' }
  }

  if (platform === 'linux') {
    if (isWritable(t.etcEnvironment)) {
      linuxSetSystem(t.etcEnvironment, proxyUrl)
      logger.info({ platform, vars: ENV_VARS }, 'envInjector.linux_etc_environment_set')
      return { platform, scope: 'system', vars: [...ENV_VARS], method: '/etc/environment' }
    }
    linuxInjectUser(t.bashrc, proxyUrl)
    logger.info({ platform, vars: ENV_VARS }, 'envInjector.linux_bashrc_set')
    return { platform, scope: 'user', vars: [...ENV_VARS], method: '~/.bashrc' }
  }

  if (platform === 'win32') {
    for (const key of ENV_VARS) t.exec(`setx ${key} "${sanitizeShellValue(proxyUrl)}"`)
    logger.info({ platform, vars: ENV_VARS }, 'envInjector.windows_setx_set')
    return { platform, scope: 'user', vars: [...ENV_VARS], method: 'setx' }
  }

  throw new PlatformNotSupportedError(platform)
}

/**
 * Removes the injected base URL env vars: from wherever `injectBaseUrlEnvVars`
 * can have put them, so a removal is idempotent and complete.
 */
export async function removeBaseUrlEnvVars(target?: EnvInjectorTarget): Promise<void> {
  const t = resolveTarget(target)
  const platform = t.platform
  logger.info({ platform }, 'envInjector.remove_start')

  if (platform === 'darwin') {
    for (const key of ENV_VARS) {
      try {
        t.exec(`launchctl unsetenv ${key}`)
      } catch {
        // `launchctl unsetenv` exits non-zero when the key was never set (or the
        // session has no launchd domain, e.g. over ssh): already absent.
      }
    }
    return
  }
  if (platform === 'linux') {
    linuxRemoveUser(t.bashrc)
    // Persist wrote here instead when it ran as root.
    if (isWritable(t.etcEnvironment)) linuxSetSystem(t.etcEnvironment, null)
    return
  }
  if (platform === 'win32') {
    for (const key of ENV_VARS) {
      try {
        t.exec(`reg delete HKCU\\Environment /v ${key} /f`)
      } catch {
        // `reg delete` exits 1 when the value is already gone: absence is success.
      }
    }
    return
  }
  throw new PlatformNotSupportedError(platform)
}
