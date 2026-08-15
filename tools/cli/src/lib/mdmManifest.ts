/**
 * MDM rollout artifact generators — CA-trust `.mobileconfig` and the
 * Cursor system-hooks manifests handed to Jamf/Intune.
 *
 * Pure `params -> string` generators, same shape as
 * `apps/dashboard/src/lib/gatewayManifest.ts` — no I/O here. `enterprise.ts`
 * (`commands/enterprise.ts`) reads `~/.intutic/ca.crt` and calls these.
 *
 * Fixes over both the deleted `enterprise-install.ts` and the three static
 * files that used to be checked into `resources/mdm/`: the `.mobileconfig`
 * now actually embeds the CA certificate bytes (the old payload had no
 * `PayloadContent` data key at all, so profiles installed but trusted
 * nothing), UUIDs are fresh per call instead of baked in from one past
 * invocation, and the non-functional `com.apple.proxy.http` payload is
 * dropped rather than shipped as if it did something on an unsupervised
 * device.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { buildHooksConfig, systemHooksDirFor } from '@intutic/sync-daemon/harness/cursorHooks'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * A PEM certificate's body IS base64(DER) — stripping the armor lines and
 * whitespace is the entire transform, no decode/re-encode required.
 */
export function pemToBase64Der(pem: string): string {
  return pem
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .join('')
    .replace(/\s+/g, '')
}

function wrapBase64(b64: string, lineLength = 76): string {
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += lineLength) {
    lines.push(b64.slice(i, i + lineLength))
  }
  return lines.join('\n')
}

export interface MobileconfigParams {
  /** PEM-armored CA certificate, e.g. read from `~/.intutic/ca.crt`. */
  caCertPem: string
  /** Optional label folded into the payload display names — XML-escaped. */
  workspaceName?: string
}

/**
 * CA-trust-only configuration profile. Deliberately does not include an
 * `com.apple.proxy.http` payload — that mechanism only takes effect on a
 * supervised device, so shipping it as if it configures the system proxy on
 * an ordinary Mac would be silently misleading.
 */
export function generateMobileconfig(params: MobileconfigParams): string {
  const caPayloadUuid = randomUUID().toUpperCase()
  const topLevelUuid = randomUUID().toUpperCase()
  const derBase64 = wrapBase64(pemToBase64Der(params.caCertPem))
  const suffix = params.workspaceName ? ` (${escapeXml(params.workspaceName)})` : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Intutic Governance Proxy CA Trust Profile -->
<!-- Deploy via Jamf, Apple Business Manager, or \`profiles install\` -->
<!-- Generated: ${new Date().toISOString()} -->
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadIdentifier</key>
      <string>ai.intutic.governance.ca</string>
      <key>PayloadDisplayName</key>
      <string>Intutic Governance Proxy CA${suffix}</string>
      <key>PayloadDescription</key>
      <string>Trusts the Intutic local CA for AI traffic governance</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadUUID</key>
      <string>${caPayloadUuid}</string>
      <key>PayloadContent</key>
      <data>
${derBase64}
      </data>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Intutic AI Governance Proxy Configuration${suffix}</string>
  <key>PayloadIdentifier</key>
  <string>ai.intutic.governance</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadUUID</key>
  <string>${topLevelUuid}</string>
</dict>
</plist>
`
}

export interface HooksManifestParams {
  /** Absolute path to the governance hook script on the TARGET machine, e.g. `/opt/intutic/hooks/cursor-check.js`. */
  hookScriptPath: string
  /** Where the MDM tool should place the generated hooks.json. Defaults to the real system-hooks path for `platform` — see `systemHooksDirFor`. */
  targetPath?: string
  /** Platform the default `targetPath` is resolved for. Defaults to this process's own platform. */
  platform?: NodeJS.Platform
}

function resolveTargetPath(params: HooksManifestParams): string {
  if (params.targetPath) return params.targetPath
  return `${systemHooksDirFor(params.platform ?? process.platform)}/hooks.json`
}

/**
 * Jamf-flavored deployment manifest wrapping the real `buildHooksConfig()`
 * shape — not a hand-retyped literal, which is exactly how the deleted
 * version drifted (it named `pre-tool-check.js`; the real script this repo
 * writes is `cursor-check.js`).
 */
export function generateJamfManifest(params: HooksManifestParams): string {
  return JSON.stringify(
    {
      _comment: 'Intutic Governance — Cursor system-level hooks.json for Jamf deployment',
      _generated: new Date().toISOString(),
      target_path: resolveTargetPath(params),
      content: buildHooksConfig(params.hookScriptPath),
      deployment: {
        jamf: 'Deploy via Configuration Profile > Files & Processes (custom script), writing `content` to target_path.',
      },
    },
    null,
    2,
  ) + '\n'
}

/** Same content as {@link generateJamfManifest}, Intune-flavored deployment notes. */
export function generateIntuneManifest(params: HooksManifestParams): string {
  return JSON.stringify(
    {
      _comment: 'Intutic Governance — Cursor system-level hooks.json for Intune deployment',
      _generated: new Date().toISOString(),
      target_path: resolveTargetPath(params),
      content: buildHooksConfig(params.hookScriptPath),
      deployment: {
        intune: 'Deploy via a Custom Configuration Profile (macOS: Files) or a Win32 app install script, writing `content` to target_path.',
      },
    },
    null,
    2,
  ) + '\n'
}
