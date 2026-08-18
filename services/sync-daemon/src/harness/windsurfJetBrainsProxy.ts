/**
 * windsurfJetBrainsProxy.ts — routes the Windsurf JetBrains plugin's
 * Cascade AI traffic through Intutic's TLS MITM proxy, for every installed
 * JetBrains product.
 *
 * # What this configures, and why it takes two files per IDE
 *
 * Unlike Desktop (one fixed `~/.codeium/windsurf/settings.json`), the
 * JetBrains plugin has no config surface of its own for a manual proxy
 * endpoint — confirmed by extracting the plugin's own compiled settings
 * class (`com.codeium.intellij.settings.AppSettingsState`, decompiled from
 * the real `codeium-2.12.27.jar` published on the JetBrains Marketplace,
 * 2026-08-18): its only proxy-related field is `detectProxy` (boolean —
 * exactly the "Detect proxy" toggle
 * docs.devin.ai/desktop/troubleshooting/plugins-enterprise/jetbrains-proxy
 * describes), persisted via `@State(name =
 * "com.codeium.intellij.settings.AppSettingsState", storages =
 * @Storage("CodeiumSettings.xml"))`. There is no `customProxyUrl`-shaped
 * field alongside the plugin's OTHER custom-endpoint fields
 * (`customApiServerUrl`/`customInferenceApiServerUrl`/`customWebsiteUrl`)
 * — those exist, but redirecting to a custom API server is a materially
 * different mechanism (a different backend, not transparent interception
 * of the same traffic) than the TLS-MITM-via-system-proxy model this
 * codebase already uses for every other harness, so this module does not
 * use them.
 *
 * "Detect proxy" makes the plugin use the IDE PLATFORM's own HTTP proxy
 * setting — a SEPARATE file, `proxy.settings.xml`, backing JetBrains
 * Platform's `HttpConfigurable` state (`@Storage("proxy.settings.xml")`,
 * still live in current `intellij-community` source despite being
 * `@Deprecated(forRemoval = true)` in favor of a newer `ProxySettings`
 * API — the deprecated class still persists to this same file today; see
 * the module doc comment in `jetbrainsXmlConfig.ts` for why this module
 * merges rather than overwrites it). So configuring the plugin needs
 * BOTH: `detectProxy=true` in `CodeiumSettings.xml`, and a manual HTTP
 * proxy pointed at Intutic's local port in `proxy.settings.xml`.
 *
 * # Discovery: no fixed path, unlike Desktop
 *
 * The JetBrains plugin ships for every JetBrains product (IntelliJ IDEA,
 * PyCharm, WebStorm, GoLand, CLion, RubyMine, PhpStorm, RustRover,
 * DataSpell, Rider, DataGrip, Android Studio, ...), each with its own
 * `<Product><Version>` config directory under a shared JetBrains root
 * (`~/Library/Application Support/JetBrains` on macOS, `~/.config/
 * JetBrains` on Linux, `%APPDATA%\JetBrains` on Windows — confirmed
 * against JetBrains' own support KB). This module does not enumerate
 * product names; it lists that root's subdirectories and configures ONLY
 * ones that already have an `options/` directory — the signal that this
 * is a real, already-initialized IDE install, not a guess at a product
 * name or version number this codebase should never invent.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLogger } from '@intutic/logger'
import { mergeXmlComponentOptions } from './jetbrainsXmlConfig.js'

const log = createLogger('sync-windsurf-jetbrains-proxy')

/** The Windsurf plugin's own settings component — see module doc comment. */
const CODEIUM_SETTINGS_COMPONENT = 'com.codeium.intellij.settings.AppSettingsState'
const CODEIUM_SETTINGS_FILE = 'CodeiumSettings.xml'

/** JetBrains Platform's own HTTP proxy state — see module doc comment. */
const HTTP_CONFIGURABLE_COMPONENT = 'HttpConfigurable'
const PROXY_SETTINGS_FILE = 'proxy.settings.xml'

/** The shared JetBrains config root for this OS, or `null` on a platform
 *  this module has no confirmed path for (anything but darwin/linux/
 *  win32) — callers treat `null` as "nothing to configure," never guess a
 *  path. */
export function jetbrainsConfigRoot(): string | null {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'JetBrains')
    case 'linux':
      return path.join(os.homedir(), '.config', 'JetBrains')
    case 'win32':
      return process.env.APPDATA ? path.join(process.env.APPDATA, 'JetBrains') : null
    default:
      return null
  }
}

/**
 * Every `<Product><Version>/options` directory under the JetBrains config
 * root that ALREADY EXISTS — never a guessed or newly-created product/
 * version directory. Returns `[]` when the root itself is absent (no
 * JetBrains product ever installed for this user) rather than treating
 * that as an error.
 */
export async function discoverJetBrainsOptionsDirs(): Promise<string[]> {
  const root = jetbrainsConfigRoot()
  if (!root) return []
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const entry of entries) {
    const optionsDir = path.join(root, entry, 'options')
    try {
      const stat = await fs.stat(optionsDir)
      if (stat.isDirectory()) dirs.push(optionsDir)
    } catch {
      // Not a real IDE install (no options/ dir yet) — skip, don't create it.
    }
  }
  return dirs
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = filePath + '.intutic-tmp'
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, filePath)
}

/**
 * Configures every installed JetBrains product's HTTP proxy + the
 * Windsurf plugin's `detectProxy` toggle to route through Intutic's local
 * TLS MITM proxy. Never throws: a product whose settings files don't
 * match the shape `jetbrainsXmlConfig.ts` understands is skipped and
 * logged, not corrupted; a system with no JetBrains products installed at
 * all is a normal, silent no-op (this integration is opt-in by
 * installation, the same way the Cisco skill-scanner integration degrades
 * when its binary is absent).
 */
export async function configureJetBrainsWindsurfProxy(proxyPort: number): Promise<void> {
  const optionsDirs = await discoverJetBrainsOptionsDirs()
  if (optionsDirs.length === 0) return

  for (const optionsDir of optionsDirs) {
    const product = path.basename(path.dirname(optionsDir))

    const proxyOk = await mergeXmlComponentOptions(
      path.join(optionsDir, PROXY_SETTINGS_FILE),
      HTTP_CONFIGURABLE_COMPONENT,
      {
        USE_HTTP_PROXY: true,
        USE_PROXY_PAC: false,
        PROXY_TYPE_IS_SOCKS: false,
        PROXY_HOST: '127.0.0.1',
        PROXY_PORT: String(proxyPort),
      },
      readFileOrNull,
      writeFileAtomic,
    )

    const settingsOk = await mergeXmlComponentOptions(
      path.join(optionsDir, CODEIUM_SETTINGS_FILE),
      CODEIUM_SETTINGS_COMPONENT,
      { detectProxy: true },
      readFileOrNull,
      writeFileAtomic,
    )

    if (proxyOk && settingsOk) {
      log.info(
        { action: 'jetbrains_windsurf_proxy_configured', product, port: proxyPort },
        'Configured JetBrains platform proxy + Windsurf plugin detectProxy',
      )
    } else {
      log.warn(
        { action: 'jetbrains_windsurf_proxy_skipped', product, proxyOk, settingsOk },
        'One or both JetBrains settings files did not match the expected shape — left untouched',
      )
    }
  }
}
