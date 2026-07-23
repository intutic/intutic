/**
 * Environment Variable Injector (TD-041 graduation)
 *
 * Injects ANTHROPIC_BASE_URL and OPENAI_BASE_URL as persistent
 * system-level environment variables that survive terminal restarts.
 *
 * Platform support:
 *   macOS:   launchctl setenv <KEY> <VALUE>
 *   Linux:   ~/.bashrc append (user-level; system /etc/environment requires sudo)
 *   Windows: setx <KEY> <VALUE> (user-level, no /M)
 *
 * LLD #30: Multi-Region Preparation, WS-5MR (TD-041)
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

export class PlatformNotSupportedError extends Error {
  constructor(platform: string) {
    super(`Platform not supported for env injection: ${platform}`)
    this.name = 'PlatformNotSupportedError'
  }
}

export class ElevationRequiredError extends Error {
  constructor(path: string) {
    super(`System-level write requires root access to ${path}. Falling back to user-level.`)
    this.name = 'ElevationRequiredError'
  }
}

function sanitizeShellValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}

function macosInject(key: string, value: string): void {
  execSync(`launchctl setenv ${key} "${sanitizeShellValue(value)}"`, { stdio: 'pipe' })
}

function macosRemove(key: string): void {
  try { execSync(`launchctl unsetenv ${key}`, { stdio: 'pipe' }) } catch {}
}

function linuxInjectUser(key: string, value: string): void {
  const rcFile = path.join(os.homedir(), '.bashrc')
  const marker = `# intutic-env-${key}`
  const line   = `export ${key}="${sanitizeShellValue(value)}" ${marker}`

  let content = ''
  try { content = fs.readFileSync(rcFile, 'utf8') } catch {}

  // Remove existing entry for this key
  const lines = content.split('\n').filter(l => !l.includes(marker))
  lines.push(line)
  fs.writeFileSync(rcFile, lines.join('\n') + '\n', { mode: 0o644 })
}

function linuxRemoveUser(key: string): void {
  const rcFile = path.join(os.homedir(), '.bashrc')
  const marker = `# intutic-env-${key}`
  try {
    const content = fs.readFileSync(rcFile, 'utf8')
    const filtered = content.split('\n').filter(l => !l.includes(marker)).join('\n')
    fs.writeFileSync(rcFile, filtered + '\n', { mode: 0o644 })
  } catch {}
}

function windowsInject(key: string, value: string): void {
  execSync(`setx ${key} "${sanitizeShellValue(value)}"`, { stdio: 'pipe' })
}

function windowsRemove(key: string): void {
  try { execSync(`reg delete HKCU\\Environment /v ${key} /f`, { stdio: 'pipe' }) } catch {}
}

/**
 * Injects ANTHROPIC_BASE_URL and OPENAI_BASE_URL as persistent env vars.
 *
 * @param proxyUrl - The Intutic proxy URL (e.g. https://proxy.acme.intutic.ai)
 * @returns InjectionResult describing what was done
 */
export async function injectBaseUrlEnvVars(proxyUrl: string): Promise<InjectionResult> {
  const platform = os.platform()
  logger.info({ platform, proxyUrl }, 'envInjector.inject_start')

  if (platform === 'darwin') {
    for (const key of ENV_VARS) macosInject(key, proxyUrl)
    logger.info({ platform, vars: ENV_VARS }, 'envInjector.macos_launchctl_set')
    return { platform, scope: 'system', vars: [...ENV_VARS], method: 'launchctl setenv' }
  }

  if (platform === 'linux') {
    // Attempt system-level first; fall back to user-level
    let scope: 'system' | 'user' = 'user'
    try {
      const etcEnv = '/etc/environment'
      // Only attempt if writable (i.e., running as root)
      fs.accessSync(etcEnv, fs.constants.W_OK)
      for (const key of ENV_VARS) {
        let content = fs.readFileSync(etcEnv, 'utf8')
        content = content.split('\n').filter(l => !l.startsWith(`${key}=`)).join('\n')
        content += `\n${key}="${sanitizeShellValue(proxyUrl)}"`
        fs.writeFileSync(etcEnv, content.trim() + '\n', { mode: 0o644 })
      }
      scope = 'system'
      logger.info({ platform, vars: ENV_VARS }, 'envInjector.linux_etc_environment_set')
    } catch {
      // Not root \u2014 user-level fallback
      for (const key of ENV_VARS) linuxInjectUser(key, proxyUrl)
      logger.info({ platform, vars: ENV_VARS }, 'envInjector.linux_bashrc_set')
    }
    return { platform, scope, vars: [...ENV_VARS], method: scope === 'system' ? '/etc/environment' : '~/.bashrc' }
  }

  if (platform === 'win32') {
    for (const key of ENV_VARS) windowsInject(key, proxyUrl)
    logger.info({ platform, vars: ENV_VARS }, 'envInjector.windows_setx_set')
    return { platform, scope: 'user', vars: [...ENV_VARS], method: 'setx' }
  }

  throw new PlatformNotSupportedError(platform)
}

/**
 * Removes the injected base URL env vars.
 */
export async function removeBaseUrlEnvVars(): Promise<void> {
  const platform = os.platform()
  logger.info({ platform }, 'envInjector.remove_start')

  if (platform === 'darwin') {
    for (const key of ENV_VARS) macosRemove(key)
    return
  }
  if (platform === 'linux') {
    for (const key of ENV_VARS) linuxRemoveUser(key)
    return
  }
  if (platform === 'win32') {
    for (const key of ENV_VARS) windowsRemove(key)
    return
  }
  throw new PlatformNotSupportedError(platform)
}
