/**
 * MDM rollout artifact generators — CA-trust `.mobileconfig`, and the
 * Cursor, Gemini CLI and Antigravity hook manifests handed to Jamf/Intune.
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
import { ANTIGRAVITY_HOOK_NAME, buildAntigravityHookEntry, buildGeminiBeforeToolEntry } from '@intutic/sync-daemon'

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

export type MdmFlavor = 'jamf' | 'intune'

const DEPLOY_VIA: Record<MdmFlavor, string> = {
  jamf: 'Deploy via Configuration Profile > Files & Processes (custom script)',
  intune: 'Deploy via a Custom Configuration Profile (macOS: Files) or a Win32 app install script',
}

/**
 * Gemini CLI's system settings file (`getSystemSettingsPath` in Gemini CLI's
 * packages/cli/src/config/settings.ts). Gemini CLI applies it last, over the
 * user's and the workspace's settings.
 */
export function geminiSystemSettingsPathFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json'
  if (platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json'
  return '/etc/gemini-cli/settings.json'
}

export interface GeminiManifestParams {
  /** Absolute path to `antigravity-check.sh` on the TARGET machine. */
  hookScriptPath: string
  /** Platform the system settings path is resolved for. Defaults to this process's own platform. */
  platform?: NodeJS.Platform
}

/**
 * Gemini CLI's `BeforeTool` gate in the machine-wide system settings file,
 * built by the same function `intutic connect` uses for the user file.
 */
export function generateGeminiManifest(flavor: MdmFlavor, params: GeminiManifestParams): string {
  return JSON.stringify(
    {
      _comment: `Intutic Governance — Gemini CLI system settings hook for ${flavor === 'jamf' ? 'Jamf' : 'Intune'} deployment`,
      _generated: new Date().toISOString(),
      target_path: geminiSystemSettingsPathFor(params.platform ?? process.platform),
      content: { hooks: { BeforeTool: [buildGeminiBeforeToolEntry(params.hookScriptPath)] } },
      deployment: {
        [flavor]: `${DEPLOY_VIA[flavor]}, merging \`content\` into the file at target_path (keep any system settings already there). Gemini CLI applies this file over user and workspace settings.`,
      },
    },
    null,
    2,
  ) + '\n'
}

export interface AntigravityManifestParams {
  /** Absolute path to `antigravity-cli-check.js` on the TARGET machine. */
  hookScriptPath: string
}

/**
 * Antigravity's `PreToolUse` gate. Antigravity documents no machine-wide
 * hooks file, only the per-user `~/.gemini/config/hooks.json` and a
 * workspace's `.agents/hooks.json`, so this one is deployed per user.
 */
export function generateAntigravityManifest(flavor: MdmFlavor, params: AntigravityManifestParams): string {
  return JSON.stringify(
    {
      _comment: `Intutic Governance — Google Antigravity hooks for ${flavor === 'jamf' ? 'Jamf' : 'Intune'} deployment`,
      _generated: new Date().toISOString(),
      target_path: '~/.gemini/config/hooks.json',
      content: { [ANTIGRAVITY_HOOK_NAME]: buildAntigravityHookEntry(params.hookScriptPath) },
      deployment: {
        [flavor]: `${DEPLOY_VIA[flavor]}, run as each signed-in user, setting the \`${ANTIGRAVITY_HOOK_NAME}\` key of the user's target_path to the one in \`content\` and keeping the user's other hooks. Antigravity has no machine-wide hooks file.`,
      },
    },
    null,
    2,
  ) + '\n'
}

export interface FirewallDeploymentParams {
  /** Absolute path to the intutic CLI binary on the TARGET machine, e.g. `/usr/local/bin/intutic`. */
  cliBinaryPath: string
  /** Optional label folded into descriptions. */
  workspaceName?: string
}

/**
 * Shared body for the two firewall-deployment manifests below — same
 * `content`/`schedule`/`prerequisites`/`honesty` fields, only the
 * `_comment` and `deployment` note differ per MDM flavor.
 */
function buildFirewallManifestBody(params: FirewallDeploymentParams) {
  const suffix = params.workspaceName ? ` (${params.workspaceName})` : ''
  return {
    suffix,
    content: `${params.cliBinaryPath} enforce apply`,
    prerequisites: [
      `intutic CLI installed at ${params.cliBinaryPath} on the target machine`,
      'MDM agent executes the script with root (macOS/Linux) or administrator (Windows) privilege — `enforce apply` needs that to write firewall rules',
    ],
    honesty:
      'This re-asserts the firewall on the configured cadence; a user with root/administrator access can still run `intutic enforce remove` and stay unenforced until the next check-in. It is not tamper-proof, it is tamper-resistant on a schedule.',
  }
}

/**
 * Jamf-flavored managed-script deployment manifest for the egress firewall.
 * Wraps `intutic enforce apply` as a recurring managed script — recurrence is
 * what survives a local `intutic enforce remove`, not a static rules file.
 * Deliberately does NOT embed generated pf/nftables/iptables rule content:
 * the target machine's own `enforce apply` generates platform-correct rules
 * at run time (see firewall.rs) — a snapshot here would drift exactly like
 * the hand-retyped hooks.json this module already fixed once (see header).
 */
export function generateJamfFirewallManifest(params: FirewallDeploymentParams): string {
  const body = buildFirewallManifestBody(params)
  return JSON.stringify(
    {
      _comment: `Intutic Governance — egress firewall re-assertion for Jamf deployment${body.suffix}`,
      _generated: new Date().toISOString(),
      content: body.content,
      schedule:
        "Every 15 minutes via a Jamf policy with a Recurring Check-in trigger (or a Custom Trigger fired by a launchd job at the desired interval). Frequent re-assertion is the point — it's what survives a local `intutic enforce remove` between runs.",
      prerequisites: body.prerequisites,
      deployment: {
        jamf: 'Deploy via Configuration Profile > Files & Processes, or a Jamf Policy with a Script payload and a recurring trigger (recommend \'Recurring Check-in\' or a Custom Trigger fired by a launchd job at the desired interval).',
      },
      honesty: body.honesty,
    },
    null,
    2,
  ) + '\n'
}

/** Same content as {@link generateJamfFirewallManifest}, Intune-flavored deployment notes. */
export function generateIntuneFirewallManifest(params: FirewallDeploymentParams): string {
  const body = buildFirewallManifestBody(params)
  return JSON.stringify(
    {
      _comment: `Intutic Governance — egress firewall re-assertion for Intune deployment${body.suffix}`,
      _generated: new Date().toISOString(),
      content: body.content,
      schedule:
        'Daily platform script schedule, or trigger-on-checkin if the Intune script policy configuration supports it. Daily is the practical floor for a scripted policy run; tighten it if the Intune tenant supports more frequent check-ins.',
      prerequisites: body.prerequisites,
      deployment: {
        intune:
          "Deploy via a macOS Shell script (Devices > Scripts) with 'Run script using signed-in credentials' as needed for root context, and a policy schedule; on Windows this would need an equivalent scheduled task — note this manifest's shell command is macOS/Linux-oriented since `enforce apply` is a Rust CLI subcommand available cross-platform but the recurring-execution mechanism differs by OS, and Windows Task Scheduler wiring is left to the operator.",
      },
      honesty: body.honesty,
    },
    null,
    2,
  ) + '\n'
}
