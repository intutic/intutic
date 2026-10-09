/**
 * cursorHooks.ts — Cursor hook injection.
 *
 * Registers the gate in Cursor's hooks.json (schema per cursor.com/docs/agent/
 * hooks: `{version: 1, hooks: {<event>: [{command, matcher?, failClosed?}]}}`)
 * for three events:
 *   - `beforeShellExecution` — every shell command;
 *   - `beforeMCPExecution`   — every MCP tool call;
 *   - `preToolUse` matching `Write|Delete` — file writes and deletions, which
 *     have no dedicated before-hook (`afterFileEdit` runs too late to refuse).
 *
 * The gate refuses with exit code 2 and allows by printing
 * `{"permission":"allow"}`: with `failClosed: true` Cursor blocks on a hook
 * that crashes, times out or prints nothing, so an allow must be explicit.
 *
 * Levels: project (`<workspaceRoot>/.cursor/hooks.json`) and user
 * (`~/.cursor/hooks.json`) on every sync; system level
 * (`/Library/Application Support/Cursor` on macOS, `/etc/cursor` elsewhere)
 * only through `intutic enterprise install`, which needs root. The project and
 * user files are merged — hooks the user registered are kept.
 *
 * LLD #14 — Phase 3 cross-harness defence
 * HLD §3.14 — Three-Tier Defense Cascade
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLogger } from '@intutic/logger'
import { keepOriginal } from '../disconnect/originals.js'
import { newIso } from '@intutic/id'
import { emitJsGate, emitJsFailClosedPrelude } from './gateBody.js'
import { readJsonObjectForMerge } from './jsonMergeTarget.js'

const log = createLogger('sync-cursor-hooks')

/** The Cursor events the gate is registered for, with each one's matcher. */
const HOOK_EVENTS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: 'beforeShellExecution' },
  { event: 'beforeMCPExecution' },
  { event: 'preToolUse', matcher: 'Write|Delete' },
]

/**
 * Where system-level hooks.json lives for a given platform. Exported (not
 * just inlined in `writeCursorHooks` below) so `mdmManifest.ts` can target
 * the SAME path this file actually writes to — otherwise the MDM manifest's
 * `target_path` and this file's real write path are two hand-typed copies
 * of the same fact, which is exactly how they drifted before (see the
 * `hookScriptPath` note below).
 */
export function systemHooksDirFor(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/Library/Application Support/Cursor' : '/etc/cursor'
}

/**
 * Build a Cursor hooks.json config object.
 *
 * Exported so `enterprise install` (`tools/cli/src/lib/mdmManifest.ts`) can
 * populate its generated MDM hooks manifest from the SAME shape this file
 * writes, rather than a hand-retyped literal — which is exactly how that
 * manifest drifted before (it named `pre-tool-check.js`, this file's real
 * script is `cursor-check.js`; see the note in `writeCursorHooks` below).
 *
 * @param hookScriptPath - Absolute path to the pre-tool-check script.
 */
export function buildHooksConfig(hookScriptPath: string): { version: number; hooks: Record<string, CursorHookEntry[]> } {
  return {
    version: 1,
    hooks: Object.fromEntries(
      HOOK_EVENTS.map(({ event, matcher }) => [
        event,
        [{ command: `node "${hookScriptPath}"`, ...(matcher ? { matcher } : {}), failClosed: true }],
      ]),
    ),
  }
}

/** One entry in a Cursor hooks.json event list. */
export interface CursorHookEntry {
  command: string
  matcher?: string
  failClosed?: boolean
}

/**
 * Merge the Intutic entries into an existing hooks.json object: the user's
 * entries for every event are kept, entries running this gate are replaced,
 * and the shape earlier versions wrote (an object per event, top-level
 * `failClosed`/`_comment`/`_lastSync`, the nonexistent `beforeFileEdit`
 * event) is dropped.
 */
export function mergeHooksConfig(existing: Record<string, unknown>, hookScriptPath: string): Record<string, unknown> {
  const ours = buildHooksConfig(hookScriptPath)
  const command = `node "${hookScriptPath}"`
  const current = typeof existing.hooks === 'object' && existing.hooks !== null && !Array.isArray(existing.hooks)
    ? { ...(existing.hooks as Record<string, unknown>) }
    : {}
  delete current.beforeFileEdit
  for (const [event, entries] of Object.entries(ours.hooks)) {
    const kept = Array.isArray(current[event])
      ? (current[event] as unknown[]).filter((e) => !(typeof e === 'object' && e !== null && (e as { command?: unknown }).command === command))
      : []
    current[event] = [...kept, ...entries]
  }
  const rest: Record<string, unknown> = { ...existing }
  delete rest.failClosed
  delete rest._comment
  delete rest._lastSync
  return { ...rest, version: typeof existing.version === 'number' ? existing.version : 1, hooks: current }
}

/**
 * The pre-tool-check.js script content — receives JSON context from Cursor
 * on stdin, exits 0 to allow or exits 2 to block.
 */
function buildHookScript(proxyUrl: string, workspaceRoot: string, workspaceId: string): string {
  const hookEventsLog = path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  return `#!/usr/bin/env node
/**
 * Intutic Cursor governance gate.
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 * Proxy: ${proxyUrl}
 * Generated: ${newIso()}
 */
${emitJsFailClosedPrelude({ harness: 'cursor', contract: 'exit2' })}
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// Runtime credentials
const _runtimeEnvPath = path.join(os.homedir(), '.intutic', 'env', 'runtime.env');
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

${emitJsGate({ harness: 'cursor', contract: 'exit2' })}

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
      harnessType: 'cursor',
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
    _intuticSessionId = ctx.session_id || ctx.sessionId || ctx.conversation_id || ctx.conversationId || ctx.task_id || ctx.taskId || '';
    // Cursor accepts FLAT payloads (fields at the top level, no tool_input
    // wrapper — that is what the \`|| ctx\` fallback below reads), so the
    // recognisable-envelope set is exactly the extractor's field set. Narrower
    // would refuse real traffic; an envelope with none of these extracts to
    // empty strings, matches no rule, and used to be allowed.
    intuticGuardEnvelope(ctx, ['tool_name', 'toolName', 'tool_input', 'toolInput', 'input', 'event', 'hook_event_name',
      'command', 'cmd', 'script', 'path', 'file_path', 'filePath', 'file', 'target', 'notebook_path'], logEvent);
    // Cursor's real field is \`hook_event_name\` (confirmed against Cursor's
    // hooks documentation and a live \`beforeMCPExecution\` payload example
    // from Cursor's own bug tracker, 2026-08 — \`ctx.event\` is not a field
    // Cursor actually sends). Both are read: the correct name, and the one
    // this file read alone before, so a future payload shape carrying \`event\`
    // instead is not silently dropped.
    const event = (ctx.hook_event_name || ctx.event || '').toLowerCase();
    const input = ctx.input || ctx.tool_input || ctx;

    // Every spelling any harness uses, matching the bash extractor. A field name
    // this list misses is a path guard that silently does not run — and the
    // caller controls which spelling it sends.
    const targetPath = input.path || input.file_path || input.filePath || input.file ||
      input.target || input.notebook_path || '';
    const command = input.command || input.cmd || input.script || '';
    let toolName = ctx.tool_name || ctx.toolName || event || 'tool';

    // M3: a \`beforeMCPExecution\` payload's \`tool_name\` is the BARE MCP tool
    // name (e.g. "create_issue"), never "beforeMCPExecution" itself — but it
    // was never composed into the \`mcp__<server>__<tool>\` shape every other
    // harness's MCP tool name already takes, so an allowlist rule or a
    // workspace's own \`mcp__github__.*\`-shaped SOP rule silently never fired
    // on a Cursor MCP call. The server is a TOP-LEVEL sibling field —
    // \`command\` for a stdio server, \`url\` for a remote one (per Cursor's
    // hooks documentation; verified live payload: \`{tool_name, command,
    // hook_event_name: "beforeMCPExecution", ...}\`) — composed in here, once,
    // before anything reads \`toolName\`.
    if (event === 'beforemcpexecution' && ctx.tool_name) {
      const mcpServer = ctx.mcp_server_name || ctx.command || ctx.url || ctx.server_name || ctx.serverName;
      if (mcpServer) toolName = 'mcp__' + mcpServer + '__' + ctx.tool_name;
    }

    // The protected-path check used to be gated on \`event === 'beforefileedit'
    // || input.path\`, so a shell command naming a protected path was only
    // caught if it also carried a path argument. The shared gate tests the
    // command and the target independently.
    intuticGate(toolName, targetPath, command, logEvent, _intuticWsId, input);

    // Allow — explicitly: with failClosed set, Cursor treats a hook that
    // prints nothing as a failure and blocks the call.
    logEvent('tool_allowed', toolName, '');
    process.stdout.write(JSON.stringify({ permission: 'allow' }));
    process.exit(0);
  } catch (err) {
    // Fail CLOSED
    const errMsg = String(err);
    process.stderr.write('[Intutic Governance] Hook error (fail-closed): ' + errMsg + '\\n');
    logEvent('tool_blocked', 'unknown', errMsg);
    process.exit(2);
  }
});
`
}

/**
 * Write Cursor hooks at user-level and project-level.
 * System-level (/etc/cursor) is handled by the corporate policy installer.
 *
 * @param workspaceRoot    - Absolute workspace root.
 * @param proxyUrl         - Intutic proxy URL.
 * @param workspaceId      - Workspace ID embedded in hook event payloads.
 * @param writeSystemLevel - If true, also attempt /etc/cursor (requires root).
 */
export async function writeCursorHooks(
  workspaceRoot: string,
  proxyUrl: string,
  workspaceId = '',
  writeSystemLevel = false,
): Promise<void> {
  const hookScriptDir = path.join(workspaceRoot, '.intutic', 'hooks')
  await fs.mkdir(hookScriptDir, { recursive: true })

  // Ensure hook events log directory exists
  await fs.mkdir(path.join(workspaceRoot, '.intutic', 'events'), { recursive: true })

  // Named after its writer — see the note in claudeCodeHooks.ts. Both emitted
  // `pre-tool-check.js` here and silently overwrote each other.
  const hookScriptPath = path.join(hookScriptDir, 'cursor-check.js')

  // Write the hook script
  const tmpScript = hookScriptPath + '.cursor-tmp'
  await fs.writeFile(tmpScript, buildHookScript(proxyUrl, workspaceRoot, workspaceId), 'utf-8')
  await fs.rename(tmpScript, hookScriptPath)
  await fs.chmod(hookScriptPath, 0o755)

  // 1. Project-level: .cursor/hooks.json
  const projectCursorDir = path.join(workspaceRoot, '.cursor')
  await keepOriginal(path.join(projectCursorDir, 'hooks.json'), workspaceRoot)
  await fs.mkdir(projectCursorDir, { recursive: true })
  await mergeHooksJsonFile(path.join(projectCursorDir, 'hooks.json'), hookScriptPath)
  log.info({ action: 'cursor_hooks_written', level: 'project', path: projectCursorDir }, 'Cursor project-level hooks written')

  // 2. User-level: ~/.cursor/hooks.json
  const userCursorDir = path.join(os.homedir(), '.cursor')
  await keepOriginal(path.join(userCursorDir, 'hooks.json'), workspaceRoot)
  await fs.mkdir(userCursorDir, { recursive: true })
  await mergeHooksJsonFile(path.join(userCursorDir, 'hooks.json'), hookScriptPath)
  log.info({ action: 'cursor_hooks_written', level: 'user', path: userCursorDir }, 'Cursor user-level hooks written')

  // 3. System-level (system administrator installation only). macOS has no
  // /etc/cursor convention Cursor itself reads — its own app-support
  // directory is the closest machine-wide location. This branch was missing
  // until now: the success log below always claimed "system-level hooks
  // written" for a write that, on macOS, went to a path Cursor never reads.
  if (writeSystemLevel) {
    const systemCursorDir = systemHooksDirFor(process.platform)
    try {
      await fs.mkdir(systemCursorDir, { recursive: true })
      await mergeHooksJsonFile(path.join(systemCursorDir, 'hooks.json'), hookScriptPath)
      log.info({ action: 'cursor_hooks_written', level: 'system', path: systemCursorDir }, 'Cursor system-level hooks written')
    } catch (err) {
      log.error({ action: 'cursor_system_hooks_failed', err }, 'System-level Cursor hooks require root — skipping')
    }
  }
}

/** Merge the gate into one hooks.json; a file that does not parse is left
 *  untouched (see jsonMergeTarget.ts). */
async function mergeHooksJsonFile(filePath: string, hookScriptPath: string): Promise<void> {
  const existing = await readJsonObjectForMerge(filePath)
  if (existing === null) return
  await atomicWriteJson(filePath, mergeHooksConfig(existing, hookScriptPath))
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + '.intutic-tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, filePath)
}
