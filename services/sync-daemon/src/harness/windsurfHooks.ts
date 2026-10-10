/**
 * windsurfHooks.ts — Windsurf Cascade hooks.json injection.
 *
 * Writes user-level (~/.codeium/windsurf/hooks.json) and workspace-level
 * (.windsurf/hooks.json) governance hooks using the Windsurf Cascade
 * hook system (exit code 2 = block).
 *
 * Also writes the proxy settings into Windsurf's user settings.json (see
 * `windsurfSettingsPath`) so that Windsurf routes HTTP traffic through the
 * Intutic TLS MITM proxy,
 * enabling governance of Cascade AI traffic that has no native base URL override.
 *
 * HLD §3.14 — Three-Tier Defense Cascade
 *
 * # Correction (2026-08-18): this file's hook event names and payload
 * # extraction were WRONG from the day this file was written, not a case of
 * # Windsurf changing later
 *
 * The original implementation (2026-06-18) registered
 * `beforeShellExecution`/`beforeMCPExecution`/`beforeFileEdit` — Cursor's
 * event names — under the stated assumption that Windsurf's hook system
 * "registers the same event names Cursor's does." That assumption was never
 * independently verified, and it was wrong: Windsurf/Cascade's REAL hook
 * system (confirmed against docs.devin.ai/desktop/cascade/hooks — the
 * current authoritative source; docs.windsurf.com/windsurf/cascade/hooks
 * redirects there post-Cognition/Devin acquisition — 2026-08-18) uses
 * entirely different event names and a differently-shaped payload, and this
 * naming was ALREADY the live one when this file was first written — a
 * March-2026 third-party integration guide already documents
 * `pre_run_command`/`tool_info.command_line`, predating this file's own
 * 2026-06-18 commit date. This was a copy-without-verifying mistake at
 * authoring time, not a later drift.
 *
 * Confirmed real facts, all from docs.devin.ai/desktop/cascade/hooks:
 * - Event names (the `hooks.json` top-level keys) are `pre_run_command`,
 *   `pre_write_code`, `pre_mcp_tool_use` (plus `post_*` variants this file
 *   has no use for — only pre-hooks can block, via exit code 2; any other
 *   non-zero exit is treated as a hook ERROR and the action proceeds, i.e.
 *   Cascade fails OPEN if this script itself cannot run — same as every
 *   other harness in this codebase, not a Windsurf-specific gap).
 * - Each event's value in `hooks.json` is an ARRAY of `{command, ...}`
 *   objects, not a single object — `[{command: "..."}]`, not
 *   `{command: "..."}`. There is no `failClosed` field in Windsurf's schema
 *   (that was Cursor's field, also copied without verification); dropped
 *   from the config this file writes.
 * - The payload delivered on stdin has `agent_action_name` as its event-name
 *   field (not `hook_event_name`/`event`, which are Cursor's field names),
 *   and nests event-specific data under `tool_info`:
 *   `tool_info.command_line`/`tool_info.cwd` for `pre_run_command`,
 *   `tool_info.file_path`/`tool_info.edits[]` for `pre_write_code`,
 *   `tool_info.mcp_server_name`/`tool_info.mcp_tool_name`/
 *   `tool_info.mcp_tool_arguments` for `pre_mcp_tool_use`. `trajectory_id`
 *   is Cascade's real conversation-identifier field.
 *
 * # Follow-up (2026-08-18): JetBrains plugin coverage
 *
 * The JetBrains plugin reads user-level hooks.json from a DIFFERENT path —
 * `~/.codeium/hooks.json`, no `windsurf` subdirectory — which this file now
 * also writes (same config content). Its own changelog (v2.12.4) naming
 * `post_setup_worktree`, one of Cascade's documented event names, as a hook
 * it added is corroborating evidence the JetBrains plugin dispatches the
 * SAME event/payload system as Desktop, not a guess. Workspace-level
 * `.windsurf/hooks.json` needed no change — that path is workspace-root-
 * relative, not app-specific, so the existing write already covers both
 * clients. Still not independently verified: whether `post_mcp_tool_use`'s
 * `mcp_result` field would be useful for anything (it isn't used here —
 * post-hooks can't block, so there is nothing this file's threat model
 * gains from it).
 *
 * # Follow-up 2 (2026-08-18): JetBrains proxy configuration
 *
 * The JetBrains plugin's proxy-config surface — the thing that decides
 * whether its OWN AI traffic (not just hook dispatch) routes through
 * Intutic's TLS MITM proxy — is now also configured, via
 * `windsurfJetBrainsProxy.ts`. See that module's doc comment for the full
 * research record: the plugin has no manual-proxy field of its own (only
 * a `detectProxy` boolean that opts into the IDE PLATFORM's proxy
 * setting), confirmed by decompiling the actual published plugin JAR, not
 * guessed.
 *
 * The Cursor-shaped field names this file previously relied on exclusively
 * are kept as a SECOND, lower-priority fallback in the extraction below —
 * not because they are believed to be real for Windsurf, but because they
 * cost nothing to keep checking and this file has already been wrong about
 * a Windsurf-specific assumption once.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLogger } from '@intutic/logger'
import { keepOriginal, noteProxyUrl } from '../disconnect/originals.js'
import { newIso } from '@intutic/id'
import { readJsonObjectForMerge } from './jsonMergeTarget.js'
import { emitJsGate, emitJsFailClosedPrelude } from './gateBody.js'
import { configureJetBrainsWindsurfProxy } from './windsurfJetBrainsProxy.js'

const log = createLogger('sync-windsurf-hooks')

/** Desktop's user-level directory, resolved at call time so tests that move
 *  HOME are honoured. */
function windsurfUserDir(): string {
  return path.join(os.homedir(), '.codeium', 'windsurf')
}

/**
 * Windsurf Desktop's user `settings.json`, the file `http.proxy` is read from.
 * Windsurf is a VS Code fork, so it keeps user settings where VS Code does,
 * under its own product name (`nameShort: "Windsurf"` in the app's
 * product.json): `User/settings.json` in the platform's application-data
 * directory. Checked against a Windsurf 1.9600.41 install on macOS, whose
 * user settings live in ~/Library/Application Support/Windsurf/User/; the
 * Linux and
 * Windows directories are VS Code's
 * (https://code.visualstudio.com/docs/configure/settings#_settings-file-locations).
 * `~/.codeium/windsurf/` holds Cascade's hooks.json and mcp_config.json, not
 * editor settings; earlier versions wrote the proxy keys there, where Windsurf
 * never read them.
 */
export function windsurfSettingsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const user = ['Windsurf', 'User', 'settings.json']
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...user)
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), ...user)
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), ...user)
}

/** The JetBrains plugin's user-level hooks.json lives directly under
 *  `~/.codeium` — no `windsurf` subdirectory — confirmed against
 *  docs.devin.ai/desktop/cascade/hooks (see module doc comment). Only
 *  hooks.json goes here: this writer's `settings.json` proxy-config write
 *  targets Desktop's known path specifically; the JetBrains plugin's proxy
 *  is configured through the IDE platform instead (windsurfJetBrainsProxy.ts). */
function windsurfJetBrainsUserDir(): string {
  return path.join(os.homedir(), '.codeium')
}

/** Cascade's real pre-hook event names (see module doc comment). Each maps
 *  to an ARRAY of hook entries in `hooks.json` — Windsurf's schema, unlike
 *  Cursor's, has no `failClosed` field; exit code 2 is the only block
 *  signal Cascade recognizes. */
const CASCADE_HOOK_EVENTS = ['pre_run_command', 'pre_write_code', 'pre_mcp_tool_use'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Register the gate for every Cascade pre-hook event in `filePath`, keeping
 * every hook the user registered there. The Intutic entry is recognised by
 * its command, so repeated syncs replace it rather than stacking copies. A
 * file that is not a plain JSON object is left alone (see jsonMergeTarget.ts).
 */
async function mergeCascadeHooksJson(filePath: string, hookScriptPath: string, workspaceRoot: string): Promise<void> {
  await keepOriginal(filePath, workspaceRoot)
  const existing = await readJsonObjectForMerge(filePath)
  if (existing === null) return
  const command = `node "${hookScriptPath}"`
  const hooks: Record<string, unknown> = isRecord(existing.hooks) ? { ...existing.hooks } : {}
  for (const event of CASCADE_HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    hooks[event] = [...current.filter((e) => !(isRecord(e) && e.command === command)), { command }]
  }
  // Provenance fields earlier versions stamped when they owned the whole file.
  delete existing._comment
  delete existing._lastSync
  delete existing._note
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await atomicWriteJson(filePath, { ...existing, hooks })
}

function buildHookScript(proxyUrl: string, workspaceRoot: string, workspaceId: string): string {
  const hookEventsLog = path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  return `#!/usr/bin/env node
/**
 * Intutic Windsurf governance gate.
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 * Proxy: ${proxyUrl}
 * Generated: ${newIso()}
 */
${emitJsFailClosedPrelude({ harness: 'windsurf', contract: 'exit2' })}
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// Runtime credentials
const _runtimeEnvPath = require('path').join(require('os').homedir(), '.intutic', 'env', 'runtime.env');
let _intuticHost = 'https://api.intutic.ai', _intuticKey = '', _intuticWsId = ${JSON.stringify(workspaceId)};
try {
  fs.readFileSync(_runtimeEnvPath, 'utf-8').split('\\n').forEach(line => {
    const eq = line.indexOf('='); if (eq < 0) return;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k === 'INTUTIC_HOST' && v) _intuticHost = v;
    if (k === 'INTUTIC_API_KEY' && v) _intuticKey = v;
    if (k === 'INTUTIC_WORKSPACE_ID' && v) _intuticWsId = v;
  });
} catch {}

${emitJsGate({ harness: "windsurf", contract: 'exit2' })}

let _intuticSessionId = '';
function logEvent(verdict, toolName, reason) {
  try {
    const ts = new Date().toISOString();
    const incidentId = crypto.createHash('sha1').update(ts + toolName + _intuticWsId).digest('hex').slice(0, 16);
    // The event's id: random, made once here, and resent with the line it is
    // written into, so the control plane processes the event once.
    const eventId = crypto.randomBytes(16).toString('hex');
    const entry = JSON.stringify({
      // Passed through, not collapsed to two values: the advisory tier emits
      // 'tool_flagged', and a ternary here silently recorded it as an allow.
      event: verdict,
      toolName, reason: reason || '',
      workspaceId: _intuticWsId,
      harnessType: 'windsurf',
      timestamp: ts,
      incidentId,
      eventId,
      ...(_intuticSessionId ? { sessionId: _intuticSessionId } : {}),
    }) + '\\n';
    fs.appendFileSync(${JSON.stringify(hookEventsLog)}, entry, { flag: 'a' });
    if (_intuticKey) {
      try {
        const body = JSON.stringify({ events: [JSON.parse(entry)] });
        const urlObj = new URL('/api/v1/hook-events', _intuticHost);
        const mod = urlObj.protocol === 'https:' ? https : require('http');
        const req = mod.request({ hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + _intuticKey } });
        req.on('error', () => { /* fire-and-forget */ });
        req.write(body); req.end();
      } catch { /* never crash the hook */ }
    }
  } catch { /* never crash the hook */ }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const ctx = JSON.parse(raw);
    _intuticSessionId = ctx.trajectory_id || ctx.trajectoryId || ctx.session_id || ctx.sessionId ||
      ctx.conversation_id || ctx.conversationId || ctx.task_id || ctx.taskId || '';
    // 'agent_action_name' and 'tool_info' are Cascade's REAL top-level
    // fields (docs.devin.ai/desktop/cascade/hooks; see this file's module
    // doc comment for the correction record). The rest of this list is the
    // Claude-Code-shaped envelope this repo's own generic gate-behaviour
    // test suite drives every harness writer with uniformly, plus the
    // Cursor-shaped fields this file incorrectly targeted before — kept so
    // neither that test coverage nor an unconfirmed Windsurf variant loses
    // recognition.
    intuticGuardEnvelope(ctx, ['agent_action_name', 'tool_info', 'tool_name', 'toolName', 'tool_input', 'toolInput',
      'input', 'event', 'hook_event_name', 'command', 'cmd', 'script', 'path', 'file_path', 'filePath', 'file',
      'target', 'notebook_path'], logEvent);
    // Cascade's real event field is 'agent_action_name' (values like
    // 'pre_run_command'/'pre_write_code'/'pre_mcp_tool_use'), checked
    // first. 'hook_event_name'/'event' are Cursor's field names, kept as a
    // fallback this file no longer trusts as primary.
    const event = (ctx.agent_action_name || ctx.hook_event_name || ctx.event || '').toLowerCase();
    // Cascade nests event-specific data under 'tool_info' — NOT 'input' or
    // 'tool_input', which are the Claude-Code/Cursor-shaped fields this file
    // previously read exclusively. Prefer 'tool_info' when present; fall
    // back to the others for the generic test envelope / an unconfirmed
    // variant.
    const toolInfo = ctx.tool_info || {};
    const input = ctx.input || ctx.tool_input || ctx.toolInput || toolInfo || ctx;

    const targetPath = toolInfo.file_path || input.path || input.file_path || input.filePath || input.file ||
      input.target || input.notebook_path || '';
    const command = toolInfo.command_line || input.command || input.cmd || input.script || '';
    let toolName = ctx.tool_name || ctx.toolName || event || 'tool';

    // M3: compose \`mcp__<server>__<tool>\` for an MCP tool call. Cascade's
    // CONFIRMED real shape is event 'pre_mcp_tool_use' with
    // tool_info.mcp_server_name/tool_info.mcp_tool_name (see module doc
    // comment). The 'beforemcpexecution'/ctx.command-or-url branch below is
    // Cursor's shape, which this file previously assumed without
    // verification and which never matched anything Cascade actually
    // sends — kept only as a fallback, now second priority.
    if (event === 'pre_mcp_tool_use' && toolInfo.mcp_tool_name) {
      toolName = 'mcp__' + toolInfo.mcp_server_name + '__' + toolInfo.mcp_tool_name;
    } else if (event === 'beforemcpexecution' && ctx.tool_name) {
      const mcpServer = ctx.command || ctx.url || ctx.server_name || ctx.serverName;
      if (mcpServer) toolName = 'mcp__' + mcpServer + '__' + ctx.tool_name;
    }

    // The block reason now comes from the shared gate and always contains
    // "governance rule". hookEvents.resolveSeverity keys CRITICAL off the
    // "governance-protected" substring, and this was the one harness of twelve
    // that omitted it — so a Windsurf agent caught tampering was filed MEDIUM.
    intuticGate(toolName, targetPath, command, logEvent, _intuticWsId, input);

    logEvent('tool_allowed', toolName, '');
    process.exit(0);
  } catch (err) {
    const errMsg = String(err);
    process.stderr.write('[Intutic Governance] Hook error (fail-closed): ' + errMsg + '\\n');
    logEvent('tool_blocked', 'unknown', errMsg);
    process.exit(2);
  }
});
`
}

/**
 * Write Windsurf hooks at user-level and workspace-level.
 * Also configures the HTTP proxy to route through Intutic's TLS MITM layer.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param proxyUrl      - Intutic proxy URL (used in the hook script comment).
 * @param proxyPort     - Local port the Intutic proxy listens on; it serves
 *                        HTTP CONNECT (TLS MITM) on the same listener as its
 *                        API routes.
 * @param workspaceId   - Workspace ID embedded in hook event payloads.
 */
export async function writeWindsurfHooks(
  workspaceRoot: string,
  proxyUrl: string,
  proxyPort = 4000,
  workspaceId = '',
): Promise<void> {
  const hookScriptDir = path.join(workspaceRoot, '.intutic', 'hooks')
  await fs.mkdir(hookScriptDir, { recursive: true })

  // Ensure hook events log directory exists
  await fs.mkdir(path.join(workspaceRoot, '.intutic', 'events'), { recursive: true })

  const hookScriptPath = path.join(hookScriptDir, 'windsurf-check.js')

  const tmpScript = hookScriptPath + '.ws-tmp'
  await fs.writeFile(tmpScript, buildHookScript(proxyUrl, workspaceRoot, workspaceId), 'utf-8')
  await fs.rename(tmpScript, hookScriptPath)
  await fs.chmod(hookScriptPath, 0o755)

  // 1. User-level hooks — Desktop's path.
  await mergeCascadeHooksJson(path.join(windsurfUserDir(), 'hooks.json'), hookScriptPath, workspaceRoot)
  log.info({ action: 'windsurf_hooks_written', level: 'user' }, 'Windsurf user-level hooks written')

  // 1b. User-level hooks — the JetBrains plugin's SEPARATE path. Same entries:
  // the JetBrains plugin's own changelog (v2.12.4) names
  // `post_setup_worktree` — one of Cascade's documented event names — as a
  // hook it added, which is corroborating evidence (not a guess) that it
  // dispatches the same Cascade hook event/payload system as Desktop, just
  // reads its user-level config from this different file.
  await mergeCascadeHooksJson(path.join(windsurfJetBrainsUserDir(), 'hooks.json'), hookScriptPath, workspaceRoot)
  log.info(
    { action: 'windsurf_hooks_written', level: 'user-jetbrains' },
    'Windsurf JetBrains plugin user-level hooks written',
  )

  // 2. Workspace-level hooks (.windsurf/hooks.json) — the SAME relative path
  // for both Desktop and the JetBrains plugin (workspace-root-relative, not
  // app-specific), so this one write already covers both. Hooks configured
  // at multiple levels are NOT one-wins: Cascade runs every level's hooks
  // for a matching event, in order system → user → workspace (confirmed
  // against docs.devin.ai/desktop/cascade/hooks), so this file being edited
  // by an agent does not disable the user-level registration above.
  await mergeCascadeHooksJson(path.join(workspaceRoot, '.windsurf', 'hooks.json'), hookScriptPath, workspaceRoot)
  log.info({ action: 'windsurf_hooks_written', level: 'workspace' }, 'Windsurf workspace-level hooks written')

  // 3. HTTP proxy settings — Desktop's own settings.json. Merged: the keys
  // below are the only ones Intutic owns, and a file that is not a plain JSON
  // object is left alone (see jsonMergeTarget.ts).
  const settingsPath = windsurfSettingsPath()
  await keepOriginal(settingsPath, workspaceRoot)
  // The local listener, not the configured proxy URL: disconnect recognises
  // the proxy settings below, and the JetBrains ones, by it.
  await noteProxyUrl(`http://127.0.0.1:${proxyPort}`)
  const existingSettings = await readJsonObjectForMerge(settingsPath)
  if (existingSettings !== null) {
    // Provenance fields earlier versions stamped when they owned the whole file.
    delete existingSettings._comment
    delete existingSettings._lastSync
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await atomicWriteJson(settingsPath, {
      ...existingSettings,
      'http.proxy': `http://127.0.0.1:${proxyPort}`,
      'http.proxyStrictSSL': false, // Our CA cert handles validation
      'codeium.proxy': `http://127.0.0.1:${proxyPort}`,
    })
    log.info(
      { action: 'windsurf_proxy_configured', port: proxyPort },
      'Windsurf HTTP proxy configured for TLS MITM interception',
    )
  }

  // 4. HTTP proxy settings — every installed JetBrains product. See
  // windsurfJetBrainsProxy.ts's module doc comment for what this
  // configures and why it needs two merge-writes per product rather than
  // one owned file the way Desktop's settings.json is.
  await configureJetBrainsWindsurfProxy(proxyPort)
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + '.intutic-tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, filePath)
}
