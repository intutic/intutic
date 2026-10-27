import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { Command } from 'commander'
import { NO_CONTROL_PLANE_MESSAGE } from '@intutic/shared-types'
import {
  CONTROL_PLANE_COMMANDS,
  CONTROL_PLANE_PLUGIN,
  PLUGIN_API_VERSION,
  controlPlaneCommandIn,
  loadControlPlanePlugin,
  missingPluginMessage,
} from './controlPlanePlugin.js'

/** Whether the optional plugin can be found from here (the private checkout links it). */
const pluginInstalled = (() => {
  try {
    createRequire(import.meta.url).resolve(CONTROL_PLANE_PLUGIN)
    return true
  } catch {
    return false
  }
})()

describe('controlPlaneCommandIn', () => {
  it('names a top-level plugin command wherever its arguments go', () => {
    expect(controlPlaneCommandIn(['whoami'])).toBe('whoami')
    expect(controlPlaneCommandIn(['guardrails', 'sources', 'list', '--json'])).toBe('guardrails')
    expect(controlPlaneCommandIn(['login', '--api-key', 'vk_x'])).toBe('login')
  })

  it('names a plugin subcommand of an open command by both words', () => {
    expect(controlPlaneCommandIn(['budget', 'set', '--daily', '5'])).toBe('budget set')
    expect(controlPlaneCommandIn(['policy', 'snapshot'])).toBe('policy snapshot')
    expect(controlPlaneCommandIn(['enforce', 'report'])).toBe('enforce report')
  })

  it('answers a help request for a plugin command the same way', () => {
    expect(controlPlaneCommandIn(['help', 'whoami'])).toBe('whoami')
    expect(controlPlaneCommandIn(['help', 'budget', 'set'])).toBe('budget set')
  })

  it('leaves the open commands, and what is not a command, to commander', () => {
    for (const args of [[], ['--help'], ['budget'], ['budget', '--watch'], ['policy', 'compile'], ['enforce', 'apply'], ['help'], ['nonsense']]) {
      expect(controlPlaneCommandIn(args), args.join(' ')).toBeUndefined()
    }
  })

  it('does not take a command for an argument of another', () => {
    expect(controlPlaneCommandIn(['exec', '--', 'login'])).toBeUndefined()
    expect(controlPlaneCommandIn(['skill', 'whoami'])).toBeUndefined()
  })
})

describe('missingPluginMessage', () => {
  it('says what the command is, where it comes from, and how a control plane is named', () => {
    const message = missingPluginMessage('budget set')
    expect(message).toContain('`intutic budget set` is a control-plane command')
    expect(message).toContain(CONTROL_PLANE_PLUGIN)
    expect(message).toContain(NO_CONTROL_PLANE_MESSAGE)
  })
})

describe('CONTROL_PLANE_COMMANDS', () => {
  it('has no duplicates', () => {
    expect(new Set(CONTROL_PLANE_COMMANDS).size).toBe(CONTROL_PLANE_COMMANDS.length)
  })
})

describe('loadControlPlanePlugin', () => {
  function moduleNotFound(message: string): Error {
    return Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' })
  }

  const load = (importPlugin: () => Promise<unknown>) => loadControlPlanePlugin(new Command(), '1.0.0', importPlugin)

  it('registers the plugin with the program and the contract version, and says it did', async () => {
    const register = vi.fn()
    const program = new Command()
    expect(await loadControlPlanePlugin(program, '9.9.9', async () => ({ register }))).toBe(true)
    expect(register).toHaveBeenCalledWith(program, { apiVersion: PLUGIN_API_VERSION, cliVersion: '9.9.9' })
  })

  it('reports no plugin when the package is not installed', async () => {
    const notInstalled = async () => {
      throw moduleNotFound(`Cannot find package '${CONTROL_PLANE_PLUGIN}' imported from /somewhere/cli.js`)
    }
    expect(await load(notInstalled)).toBe(false)
  })

  it('reports no plugin in a single-file binary, where nothing can be imported at run time', async () => {
    const noImport = async () => {
      throw Object.assign(new TypeError('A dynamic import callback was not specified.'), { code: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' })
    }
    expect(await load(noImport)).toBe(false)
  })

  it('does not take a missing dependency of the plugin for a missing plugin', async () => {
    const missing = moduleNotFound(`Cannot find package 'ioredis' imported from /node_modules/${CONTROL_PLANE_PLUGIN}/dist/commands/connect.js`)
    await expect(load(async () => Promise.reject(missing))).rejects.toBe(missing)
  })

  it('does not take a plugin file that is gone for a missing plugin', async () => {
    const gone = moduleNotFound(`Cannot find module '/node_modules/${CONTROL_PLANE_PLUGIN}/dist/index.js' imported from /somewhere/cli.js`)
    await expect(load(async () => Promise.reject(gone))).rejects.toBe(gone)
  })

  it('does not take any other failure of the plugin for a missing plugin', async () => {
    const broken = new Error('boom while loading')
    await expect(load(async () => Promise.reject(broken))).rejects.toBe(broken)
  })

  it('refuses a package that is there but does not register', async () => {
    await expect(load(async () => ({ somethingElse: true }))).rejects.toThrow(/exports no register/)
  })

  // The real import, as cli.ts makes it: the specifier is unresolvable here unless the plugin is installed.
  it.skipIf(pluginInstalled)('finds no plugin by the real import when none is installed', async () => {
    expect(await loadControlPlanePlugin(new Command(), '1.0.0')).toBe(false)
  })
})
