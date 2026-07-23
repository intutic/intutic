import { describe, it, expect } from 'vitest'
import {
  buildPlist,
  buildMcpPlist,
  buildUnit,
  buildMcpUnit,
  getPaths,
  checkRootPrivileges,
  ElevationRequiredError
} from './install-daemon.js'

describe('Daemon Installer Configuration Builder', () => {
  const opts = {
    workspaceId: 'ws_test',
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
