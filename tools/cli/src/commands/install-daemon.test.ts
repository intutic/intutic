import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPlist,
  buildMcpPlist,
  buildUnit,
  buildMcpUnit,
  buildProxyPlist,
  buildProxyUnit,
  proxyServiceEnv,
  resolveProxyServiceBinary,
  getPaths,
  getServicePaths,
  checkRootPrivileges,
  ElevationRequiredError
} from './install-daemon.js'

describe('Daemon Installer Configuration Builder', () => {
  const opts = {
    workspaceId: 'wk_test',
    apiKey: 'vk_test',
    binaryPath: '/usr/local/bin/intutic',
    controlPlaneUrl: 'https://api.intutic.ai'
  }

  describe('getPaths', () => {
    it('returns correct user-level paths on macOS', () => {
      const paths = getPaths(false, false, 'darwin')
      expect(paths.targetDir).toContain('Library/LaunchAgents')
      expect(paths.targetPath).toContain('ai.intutic.sync-daemon.plist')
      expect(paths.logPath).toContain('.intutic/logs/sync-daemon.log')
    })

    it('returns correct system-level paths on macOS', () => {
      const paths = getPaths(true, false, 'darwin')
      expect(paths.targetDir).toBe('/Library/LaunchDaemons')
      expect(paths.targetPath).toBe('/Library/LaunchDaemons/ai.intutic.sync-daemon.plist')
      expect(paths.logPath).toBe('/Library/Logs/Intutic/sync-daemon.log')
    })

    it('returns correct user-level paths on Linux', () => {
      const paths = getPaths(false, false, 'linux')
      expect(paths.targetDir).toContain('.config/systemd/user')
      expect(paths.targetPath).toContain('intutic-sync-daemon.service')
      expect(paths.logPath).toContain('.intutic/logs/sync-daemon.log')
    })

    it('returns correct system-level paths on Linux', () => {
      const paths = getPaths(true, false, 'linux')
      expect(paths.targetDir).toBe('/etc/systemd/system')
      expect(paths.targetPath).toBe('/etc/systemd/system/intutic-sync-daemon.service')
      expect(paths.logPath).toBe('/var/log/intutic/sync-daemon.log')
    })
  })

  describe('buildPlist & buildMcpPlist', () => {
    it('omits RunAtLoad in system mode and sets correct log locations', () => {
      const userPlist = buildPlist(opts, false)
      expect(userPlist).toContain('<key>RunAtLoad</key>')
      expect(userPlist).toContain('.intutic/logs/sync-daemon.log')

      const systemPlist = buildPlist(opts, true)
      expect(systemPlist).not.toContain('<key>RunAtLoad</key>')
      expect(systemPlist).toContain('/Library/Logs/Intutic/sync-daemon.log')
    })

    it('builds valid MCP plist with correct pathing', () => {
      const mcpOpts = {
        workspaceId: opts.workspaceId,
        apiKey: opts.apiKey,
        controlPlaneUrl: opts.controlPlaneUrl
      }
      const userMcp = buildMcpPlist(mcpOpts, false)
      expect(userMcp).toContain('<key>RunAtLoad</key>')
      expect(userMcp).toContain('.intutic/logs/mcp-daemon.log')

      const systemMcp = buildMcpPlist(mcpOpts, true)
      expect(systemMcp).not.toContain('<key>RunAtLoad</key>')
      expect(systemMcp).toContain('/Library/Logs/Intutic/mcp-daemon.log')
    })
  })

  describe('buildUnit & buildMcpUnit', () => {
    it('sets correct WantedBy target and logs for Linux systemd sync daemon', () => {
      const userUnit = buildUnit(opts, false)
      expect(userUnit).toContain('WantedBy=default.target')
      expect(userUnit).toContain('.intutic/logs/sync-daemon.log')

      const systemUnit = buildUnit(opts, true)
      expect(systemUnit).toContain('WantedBy=multi-user.target')
      expect(systemUnit).toContain('/var/log/intutic/sync-daemon.log')
    })

    it('sets correct WantedBy target and logs for Linux systemd MCP daemon', () => {
      const mcpOpts = {
        workspaceId: opts.workspaceId,
        apiKey: opts.apiKey,
        controlPlaneUrl: opts.controlPlaneUrl
      }
      const userUnit = buildMcpUnit(mcpOpts, false)
      expect(userUnit).toContain('WantedBy=default.target')
      expect(userUnit).toContain('.intutic/logs/mcp-daemon.log')

      const systemUnit = buildMcpUnit(mcpOpts, true)
      expect(systemUnit).toContain('WantedBy=multi-user.target')
      expect(systemUnit).toContain('/var/log/intutic/mcp-daemon.log')
    })
  })

  // ── Standalone proxy (TD-465) ────────────────────────────────────────
  //
  // The proxy is a third process with a config shape nothing like the two
  // daemons': no workspace, no key, no control plane — just the environment
  // `intutic start` sets. These pin that the unit carries exactly that.
  describe('proxy service (TD-465)', () => {
    const proxyOpts = { binaryPath: '/usr/local/bin/intutic-proxy', port: '4000' }

    it('getServicePaths names the proxy service and its logs on both platforms', () => {
      const mac = getServicePaths(false, 'proxy', 'darwin')
      expect(mac.targetPath).toContain('Library/LaunchAgents/ai.intutic.proxy.plist')
      expect(mac.logPath).toContain('.intutic/logs/proxy.log')

      const linux = getServicePaths(true, 'proxy', 'linux')
      expect(linux.targetPath).toBe('/etc/systemd/system/intutic-proxy.service')
      expect(linux.unitName).toBe('intutic-proxy.service')
      expect(linux.logPath).toBe('/var/log/intutic/proxy.log')

      // The two-daemon accessor still resolves through the same table.
      expect(getPaths(false, true, 'linux')).toEqual(getServicePaths(false, 'mcp', 'linux'))
    })

    it('with no Valkey the environment is PORT + INTUTIC_STANDALONE=1, exactly as `intutic start` sets it', () => {
      expect(proxyServiceEnv(proxyOpts)).toEqual({ PORT: '4000', INTUTIC_STANDALONE: '1' })
    })

    it('naming a Valkey sets VALKEY_URL and drops INTUTIC_STANDALONE; an upstream adds UPSTREAM_URL', () => {
      const env = proxyServiceEnv({
        ...proxyOpts,
        valkeyUrl: 'redis://127.0.0.1:6379',
        upstreamUrl: 'https://api.anthropic.com',
      })
      expect(env).toEqual({
        PORT: '4000',
        VALKEY_URL: 'redis://127.0.0.1:6379',
        UPSTREAM_URL: 'https://api.anthropic.com',
      })
      expect(env).not.toHaveProperty('INTUTIC_STANDALONE')
    })

    it('the plist runs the absolute binary with that environment and follows the RunAtLoad/log rules', () => {
      const userPlist = buildProxyPlist(proxyOpts, false)
      expect(userPlist).toContain('<string>ai.intutic.proxy</string>')
      expect(userPlist).toContain('<string>/usr/local/bin/intutic-proxy</string>')
      expect(userPlist).toContain('<key>PORT</key>\n    <string>4000</string>')
      expect(userPlist).toContain('<key>INTUTIC_STANDALONE</key>\n    <string>1</string>')
      expect(userPlist).not.toContain('VALKEY_URL')
      expect(userPlist).toContain('<key>RunAtLoad</key>')
      expect(userPlist).toContain('.intutic/logs/proxy.log')
      // No daemon arguments leak into the proxy's ProgramArguments.
      expect(userPlist).not.toContain('<string>connect</string>')

      const systemPlist = buildProxyPlist({ ...proxyOpts, valkeyUrl: 'redis://127.0.0.1:6379' }, true)
      expect(systemPlist).not.toContain('<key>RunAtLoad</key>')
      expect(systemPlist).toContain('/Library/Logs/Intutic/proxy.log')
      expect(systemPlist).toContain('<key>VALKEY_URL</key>\n    <string>redis://127.0.0.1:6379</string>')
      expect(systemPlist).not.toContain('INTUTIC_STANDALONE')
    })

    it('the systemd unit execs the absolute binary with Environment= lines and the right WantedBy', () => {
      const userUnit = buildProxyUnit(proxyOpts, false)
      expect(userUnit).toContain('ExecStart=/usr/local/bin/intutic-proxy\n')
      expect(userUnit).toContain('Environment=PORT=4000')
      expect(userUnit).toContain('Environment=INTUTIC_STANDALONE=1')
      expect(userUnit).toContain('Restart=always')
      expect(userUnit).toContain('WantedBy=default.target')
      expect(userUnit).toContain('.intutic/logs/proxy.log')

      const systemUnit = buildProxyUnit({ ...proxyOpts, upstreamUrl: 'https://api.openai.com' }, true)
      expect(systemUnit).toContain('Environment=UPSTREAM_URL=https://api.openai.com')
      expect(systemUnit).toContain('WantedBy=multi-user.target')
      expect(systemUnit).toContain('/var/log/intutic/proxy.log')
    })

    it('an explicit binary path is taken as given only when absolute', () => {
      // launchd needs an absolute ProgramArguments[0] and systemd refuses a
      // relative ExecStart, so a relative path must fail at install time, not
      // at the service's first start.
      expect(resolveProxyServiceBinary('/opt/intutic/bin/intutic-proxy')).toBe('/opt/intutic/bin/intutic-proxy')
      expect(() => resolveProxyServiceBinary('bin/intutic-proxy')).toThrow(/must be absolute/)
    })
  })

  describe('checkRootPrivileges', () => {
    it('does not throw when system level flag is false', () => {
      expect(() => checkRootPrivileges(false)).not.toThrow()
    })

    it('throws ElevationRequiredError when system is true and user is not root', () => {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        expect(() => checkRootPrivileges(true)).toThrow(ElevationRequiredError)
      }
    })
  })
})

describe('every daemon entry point is reachable from the CLI', () => {
  // `installMcpDaemon` and `uninstallMcpDaemon` were written, exported and
  // covered by the builder tests above, and no command ever called them: every
  // route through `daemon install` / `install-daemon` landed on the sync-daemon
  // function, so the MCP proxy daemon could not be installed at all (TD-153).
  // The builder tests could not catch it — they test the plist string, not
  // whether anything asks for one.
  //
  // Both sides of this are read from source at runtime. Nothing is hardcoded,
  // so a fifth entry point added later is covered without editing this test.
  const here = dirname(fileURLToPath(import.meta.url))
  const moduleSrc = readFileSync(join(here, 'install-daemon.ts'), 'utf8')
  // Comments stripped before matching. The first version of this test passed
  // for `installMcpDaemon` while the wiring was neutralised, because a comment
  // in cli.ts named the function — prose about a call is not a call.
  const cliSrc = readFileSync(join(here, '..', 'cli.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // Install/uninstall for every target, plus the status/stop/start verbs —
  // `proxyServiceStatus/Stop/Start` were the Wave 6 gap this closes.
  const entryPoints = [...moduleSrc.matchAll(/export async function ((?:un)?install\w*|\w+(?:Status|Stop|Start))\(/g)].map((m) => m[1]!)

  it('finds the install/uninstall entry points to check', () => {
    // Guard against the regex silently matching nothing, which would make
    // every assertion below vacuous.
    expect(entryPoints.length).toBeGreaterThanOrEqual(4)
  })

  for (const name of entryPoints) {
    it(`cli.ts can reach ${name}`, () => {
      // Word-boundary matched, not `toContain`: "uninstallMcpDaemon" contains
      // "installMcpDaemon", so a substring check reported the install route as
      // wired whenever the uninstall route was — which it did on the first run
      // of this test.
      const referenced = new RegExp(`\\b${name}\\b`).test(cliSrc)
      expect(referenced, `${name} is exported but no CLI command calls it`).toBe(true)
    })
  }
})
