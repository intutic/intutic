/**
 * windsurfHooks.ts — Windsurf Cascade hooks.json injection.
 *
 * Writes user-level (~/.codeium/windsurf/hooks.json) and workspace-level
 * (.windsurf/hooks.json) governance hooks using the Windsurf Cascade
 * hook system (exit code 2 = block).
 *
 * Also writes the proxy settings into ~/.codeium/windsurf/settings.json
 * so that Windsurf routes HTTP traffic through the Intutic TLS MITM proxy,
 * enabling governance of Cascade AI traffic that has no native base URL override.
 *
 * LLD #14 — Phase 3 cross-harness defence
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
 * What was NOT independently re-verified: whether every Windsurf channel/
 * build (Desktop vs JetBrains plugin, which docs.devin.ai documents a
 * different user-level path for — `~/.codeium/hooks.json`, no `windsurf`
 * subdirectory — but this file only targets Desktop's path) dispatches
 * hooks identically, and whether `post_mcp_tool_use`'s `mcp_result` field
 * would be useful for anything (it isn't used here — post-hooks can't
 * block, so there is nothing this file's threat model gains from it).
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
import { newIso } from '@intutic/id'
import { emitJsGate, emitJsFailClosedPrelude } from './gateBody.js'

const log = createLogger('sync-windsurf-hooks')

const WINDSURF_USER_DIR = path.join(os.homedir(), '.codeium', 'windsurf')


/** Cascade's real pre-hook event names (see module doc comment). Each maps
 *  to an ARRAY of hook entries in `hooks.json` — Windsurf's schema, unlike
 *  Cursor's, has no `failClosed` field; exit code 2 is the only block
 *  signal Cascade recognizes. */
const CASCADE_HOOK_EVENTS = ['pre_run_command', 'pre_write_code', 'pre_mcp_tool_use'] as const

function buildHooksConfig(hookScriptPath: string) {
  return {
    _comment: 'Intutic governance hooks — auto-generated. DO NOT EDIT.',
    _lastSync: newIso(),
    hooks: Object.fromEntries(
      CASCADE_HOOK_EVENTS.map((event) => [event, [{ command: `node "${hookScriptPath}"` }]]),
    ),
  }
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
    const entry = JSON.stringify({
      // Passed through, not collapsed to two values: the advisory tier emits
      // 'tool_flagged', and a ternary here silently recorded it as an allow.
      event: verdict,
      toolName, reason: reason || '',
      workspaceId: _intuticWsId,
      harnessType: 'windsurf',
      timestamp: ts,
      incidentId,
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
 * @param proxyPort     - Local port where the Intutic proxy is listening (for TLS MITM).
 * @param workspaceId   - Workspace ID embedded in hook event payloads.
 */
export async function writeWindsurfHooks(
  workspaceRoot: string,
  proxyUrl: string,
  proxyPort = 8877,
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

  const config = buildHooksConfig(hookScriptPath)

  // 1. User-level hooks
  await fs.mkdir(WINDSURF_USER_DIR, { recursive: true })
  await atomicWriteJson(path.join(WINDSURF_USER_DIR, 'hooks.json'), config)
  log.info({ action: 'windsurf_hooks_written', level: 'user' }, 'Windsurf user-level hooks written')

  // 2. Workspace-level hooks (.windsurf/hooks.json)
  const wsWindsurfDir = path.join(workspaceRoot, '.windsurf')
  await fs.mkdir(wsWindsurfDir, { recursive: true })
  await atomicWriteJson(path.join(wsWindsurfDir, 'hooks.json'), {
    ...config,
    _note: 'Workspace-level hooks — agent may be able to modify this file. User-level hooks take precedence.',
  })
  log.info({ action: 'windsurf_hooks_written', level: 'workspace' }, 'Windsurf workspace-level hooks written')

  // 3. HTTP proxy settings → routes Windsurf's Cascade AI traffic through Intutic TLS MITM
  const wsSettings = {
    _comment: 'Intutic proxy settings — auto-generated. DO NOT EDIT.',
    _lastSync: newIso(),
    'http.proxy': `http://127.0.0.1:${proxyPort}`,
    'http.proxyStrictSSL': false, // Our CA cert handles validation
    'codeium.proxy': `http://127.0.0.1:${proxyPort}`,
  }
  await atomicWriteJson(path.join(WINDSURF_USER_DIR, 'settings.json'), wsSettings)
  log.info(
    { action: 'windsurf_proxy_configured', port: proxyPort },
    'Windsurf HTTP proxy configured for TLS MITM interception',
  )
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + '.intutic-tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, filePath)
}
