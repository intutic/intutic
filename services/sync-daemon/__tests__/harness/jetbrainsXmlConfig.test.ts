/**
 * jetbrainsXmlConfig.test.ts — proves the merge-not-overwrite contract
 * `mergeXmlComponentOptions` exists for: an agent's OWN component's
 * options are added/updated, every OTHER component and every unrelated
 * option in the SAME component survive byte-for-byte.
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { mergeXmlComponentOptions } from '../../src/harness/jetbrainsXmlConfig.js'

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const readFile = async (path: string) => files.get(path) ?? null
  const writeFileAtomic = async (path: string, content: string) => {
    files.set(path, content)
  }
  return { files, readFile, writeFileAtomic }
}

describe('mergeXmlComponentOptions', () => {
  it('creates a fresh file with the target component when none existed', async () => {
    const { files, readFile, writeFileAtomic } = fakeFs()
    const ok = await mergeXmlComponentOptions(
      '/fake/proxy.settings.xml',
      'HttpConfigurable',
      { USE_HTTP_PROXY: true, PROXY_HOST: '127.0.0.1', PROXY_PORT: '8877' },
      readFile,
      writeFileAtomic,
    )
    expect(ok).toBe(true)
    const written = files.get('/fake/proxy.settings.xml')!
    expect(written).toContain('<application>')
    expect(written).toContain('<component name="HttpConfigurable">')
    expect(written).toContain('<option name="USE_HTTP_PROXY" value="true" />')
    expect(written).toContain('<option name="PROXY_HOST" value="127.0.0.1" />')
    expect(written).toContain('<option name="PROXY_PORT" value="8877" />')
  })

  it('matches the real proxy.settings.xml shape (verified fixture) and adds our keys without dropping the existing empty ones', async () => {
    // Real shape, taken verbatim from two independent public IntelliJ
    // dotfile repos — see windsurfHooks.ts's module doc comment for the
    // sourcing discipline this follows.
    const existing = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="HttpConfigurable">
    <option name="PROXY_HOST" value="" />
    <option name="PROXY_LOGIN" value="" />
    <option name="PROXY_EXCEPTIONS" value="somehost.internal" />
    <option name="PAC_URL" value="" />
  </component>
</application>
`
    const { files, readFile, writeFileAtomic } = fakeFs({ '/fake/proxy.settings.xml': existing })
    const ok = await mergeXmlComponentOptions(
      '/fake/proxy.settings.xml',
      'HttpConfigurable',
      { USE_HTTP_PROXY: true, PROXY_HOST: '127.0.0.1', PROXY_PORT: '8877' },
      readFile,
      writeFileAtomic,
    )
    expect(ok).toBe(true)
    const written = files.get('/fake/proxy.settings.xml')!
    // Our overwrite of PROXY_HOST wins...
    expect(written).toContain('<option name="PROXY_HOST" value="127.0.0.1" />')
    expect(written).not.toContain('<option name="PROXY_HOST" value="" />')
    // ...but PROXY_LOGIN, PAC_URL, and the user's own PROXY_EXCEPTIONS survive untouched.
    expect(written).toContain('<option name="PROXY_LOGIN" value="" />')
    expect(written).toContain('<option name="PAC_URL" value="" />')
    expect(written).toContain('<option name="PROXY_EXCEPTIONS" value="somehost.internal" />')
    expect(written).toContain('<option name="USE_HTTP_PROXY" value="true" />')
    expect(written).toContain('<option name="PROXY_PORT" value="8877" />')
  })

  it('preserves an unrelated component in the same file byte-for-byte', async () => {
    const existing = `<application>
  <component name="SomeOtherPlugin">
    <option name="unrelatedKey" value="unrelatedValue" />
  </component>
  <component name="HttpConfigurable">
    <option name="PROXY_HOST" value="old.proxy.example" />
  </component>
</application>
`
    const { files, readFile, writeFileAtomic } = fakeFs({ '/fake/proxy.settings.xml': existing })
    await mergeXmlComponentOptions(
      '/fake/proxy.settings.xml',
      'HttpConfigurable',
      { PROXY_HOST: '127.0.0.1' },
      readFile,
      writeFileAtomic,
    )
    const written = files.get('/fake/proxy.settings.xml')!
    expect(written).toContain('<component name="SomeOtherPlugin">')
    expect(written).toContain('<option name="unrelatedKey" value="unrelatedValue" />')
    expect(written).toContain('<option name="PROXY_HOST" value="127.0.0.1" />')
    expect(written).not.toContain('old.proxy.example')
  })

  it('is idempotent — re-merging the same options twice produces the same option set', async () => {
    const { files, readFile, writeFileAtomic } = fakeFs()
    await mergeXmlComponentOptions(
      '/fake/CodeiumSettings.xml',
      'com.codeium.intellij.settings.AppSettingsState',
      { detectProxy: true },
      readFile,
      writeFileAtomic,
    )
    const first = files.get('/fake/CodeiumSettings.xml')!
    await mergeXmlComponentOptions(
      '/fake/CodeiumSettings.xml',
      'com.codeium.intellij.settings.AppSettingsState',
      { detectProxy: true },
      readFile,
      writeFileAtomic,
    )
    const second = files.get('/fake/CodeiumSettings.xml')!
    expect(second).toBe(first)
  })

  it('preserves a nested (non-self-closing) option like customTrackedWorkspaces alongside merged simple options — the real CodeiumSettings.xml shape', async () => {
    const existing = `<application>
  <component name="com.codeium.intellij.settings.AppSettingsState">
    <option name="autoUpdateWindsurf" value="true" />
    <option name="chatZoomLevel" value="100" />
    <option name="customTrackedWorkspaces">
      <list>
        <option value="/Users/dev/project" />
      </list>
    </option>
  </component>
</application>
`
    const { files, readFile, writeFileAtomic } = fakeFs({ '/fake/CodeiumSettings.xml': existing })
    const ok = await mergeXmlComponentOptions(
      '/fake/CodeiumSettings.xml',
      'com.codeium.intellij.settings.AppSettingsState',
      { detectProxy: true },
      readFile,
      writeFileAtomic,
    )
    expect(ok).toBe(true)
    const written = files.get('/fake/CodeiumSettings.xml')!
    // Simple options survive and our key is added.
    expect(written).toContain('<option name="autoUpdateWindsurf" value="true" />')
    expect(written).toContain('<option name="chatZoomLevel" value="100" />')
    expect(written).toContain('<option name="detectProxy" value="true" />')
    // The nested, non-self-closing structure is preserved verbatim.
    expect(written).toContain('<option name="customTrackedWorkspaces">')
    expect(written).toContain('<list>')
    expect(written).toContain('<option value="/Users/dev/project" />')
    expect(written).toContain('</list>')
  })

  it('stays idempotent across repeated merges even with preserved nested content — no whitespace growth', async () => {
    const existing = `<application>
  <component name="com.codeium.intellij.settings.AppSettingsState">
    <option name="customTrackedWorkspaces">
      <list>
        <option value="/Users/dev/project" />
      </list>
    </option>
  </component>
</application>
`
    const { files, readFile, writeFileAtomic } = fakeFs({ '/fake/CodeiumSettings.xml': existing })
    await mergeXmlComponentOptions(
      '/fake/CodeiumSettings.xml',
      'com.codeium.intellij.settings.AppSettingsState',
      { detectProxy: true },
      readFile,
      writeFileAtomic,
    )
    const first = files.get('/fake/CodeiumSettings.xml')!
    await mergeXmlComponentOptions(
      '/fake/CodeiumSettings.xml',
      'com.codeium.intellij.settings.AppSettingsState',
      { detectProxy: true },
      readFile,
      writeFileAtomic,
    )
    const second = files.get('/fake/CodeiumSettings.xml')!
    expect(second).toBe(first)
  })

  it('refuses (does not write) content that does not match the <application> shape', async () => {
    const { files, readFile, writeFileAtomic } = fakeFs({
      '/fake/weird.xml': '<not-application><thing/></not-application>',
    })
    const ok = await mergeXmlComponentOptions(
      '/fake/weird.xml',
      'HttpConfigurable',
      { USE_HTTP_PROXY: true },
      readFile,
      writeFileAtomic,
    )
    expect(ok).toBe(false)
    expect(files.get('/fake/weird.xml')).toBe('<not-application><thing/></not-application>')
  })
})
