/**
 * windsurfJetBrainsProxy.test.ts — discovery and end-to-end config-write
 * coverage for JetBrains IDE Windsurf proxy configuration.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

describe('windsurfJetBrainsProxy', () => {
  let home: string
  let jetbrainsRoot: string
  const prevHome = process.env.HOME
  const prevPlatform = process.platform

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-jb-home-'))
    process.env.HOME = home
    // Pin darwin for a deterministic root across CI runners (Linux CI
    // would otherwise resolve a different path — see
    // claudeDesktopHooks.test.ts for the same pitfall/fix pattern).
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    jetbrainsRoot = path.join(home, 'Library', 'Application Support', 'JetBrains')
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    Object.defineProperty(process, 'platform', { value: prevPlatform, configurable: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  it('jetbrainsConfigRoot resolves the darwin path', async () => {
    const { jetbrainsConfigRoot } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    expect(jetbrainsConfigRoot()).toBe(jetbrainsRoot)
  })

  it('discoverJetBrainsOptionsDirs returns [] when the JetBrains root does not exist', async () => {
    const { discoverJetBrainsOptionsDirs } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    expect(await discoverJetBrainsOptionsDirs()).toEqual([])
  })

  it('discoverJetBrainsOptionsDirs only picks up product dirs that already have an options/ subdirectory', async () => {
    // A real, already-initialized IDE install.
    await fs.mkdir(path.join(jetbrainsRoot, 'IntelliJIdea2026.2', 'options'), { recursive: true })
    // A directory that exists (e.g. leftover cache) but was never actually
    // initialized as an IDE config dir — must NOT be treated as one.
    await fs.mkdir(path.join(jetbrainsRoot, 'SomeOtherStuff'), { recursive: true })

    const { discoverJetBrainsOptionsDirs } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    const dirs = await discoverJetBrainsOptionsDirs()
    expect(dirs).toEqual([path.join(jetbrainsRoot, 'IntelliJIdea2026.2', 'options')])
  })

  it('discoverJetBrainsOptionsDirs finds every installed product', async () => {
    await fs.mkdir(path.join(jetbrainsRoot, 'IntelliJIdea2026.2', 'options'), { recursive: true })
    await fs.mkdir(path.join(jetbrainsRoot, 'PyCharm2026.1', 'options'), { recursive: true })
    await fs.mkdir(path.join(jetbrainsRoot, 'WebStorm2026.2', 'options'), { recursive: true })

    const { discoverJetBrainsOptionsDirs } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    const dirs = (await discoverJetBrainsOptionsDirs()).sort()
    expect(dirs).toEqual(
      [
        path.join(jetbrainsRoot, 'IntelliJIdea2026.2', 'options'),
        path.join(jetbrainsRoot, 'PyCharm2026.1', 'options'),
        path.join(jetbrainsRoot, 'WebStorm2026.2', 'options'),
      ].sort(),
    )
  })

  it('configureJetBrainsWindsurfProxy is a silent no-op when no JetBrains product is installed', async () => {
    const { configureJetBrainsWindsurfProxy } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    await expect(configureJetBrainsWindsurfProxy(8877)).resolves.toBeUndefined()
  })

  it('configureJetBrainsWindsurfProxy writes both proxy.settings.xml and CodeiumSettings.xml for a discovered IDE, preserving pre-existing content', async () => {
    const optionsDir = path.join(jetbrainsRoot, 'PyCharm2026.1', 'options')
    await fs.mkdir(optionsDir, { recursive: true })
    // Pre-existing, user-set proxy exception the merge must not drop.
    await fs.writeFile(
      path.join(optionsDir, 'proxy.settings.xml'),
      '<application>\n  <component name="HttpConfigurable">\n' +
        '    <option name="PROXY_EXCEPTIONS" value="internal.example.com" />\n' +
        '  </component>\n</application>\n',
      'utf-8',
    )

    const { configureJetBrainsWindsurfProxy } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    await configureJetBrainsWindsurfProxy(8877)

    const proxyXml = await fs.readFile(path.join(optionsDir, 'proxy.settings.xml'), 'utf-8')
    expect(proxyXml).toContain('<option name="USE_HTTP_PROXY" value="true" />')
    expect(proxyXml).toContain('<option name="PROXY_HOST" value="127.0.0.1" />')
    expect(proxyXml).toContain('<option name="PROXY_PORT" value="8877" />')
    expect(proxyXml).toContain('<option name="PROXY_EXCEPTIONS" value="internal.example.com" />')

    const codeiumXml = await fs.readFile(path.join(optionsDir, 'CodeiumSettings.xml'), 'utf-8')
    expect(codeiumXml).toContain('<component name="com.codeium.intellij.settings.AppSettingsState">')
    expect(codeiumXml).toContain('<option name="detectProxy" value="true" />')
  })

  it('configureJetBrainsWindsurfProxy configures every discovered product independently', async () => {
    const ideaOptions = path.join(jetbrainsRoot, 'IntelliJIdea2026.2', 'options')
    const pycharmOptions = path.join(jetbrainsRoot, 'PyCharm2026.1', 'options')
    await fs.mkdir(ideaOptions, { recursive: true })
    await fs.mkdir(pycharmOptions, { recursive: true })

    const { configureJetBrainsWindsurfProxy } = await import('../../src/harness/windsurfJetBrainsProxy.js')
    await configureJetBrainsWindsurfProxy(8877)

    for (const dir of [ideaOptions, pycharmOptions]) {
      const codeiumXml = await fs.readFile(path.join(dir, 'CodeiumSettings.xml'), 'utf-8')
      expect(codeiumXml).toContain('<option name="detectProxy" value="true" />')
    }
  })
})
