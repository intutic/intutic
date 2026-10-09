/**
 * clineHooks.ts — Cline PreToolUse governance hook.
 *
 * Cline runs file hooks: an executable named exactly `PreToolUse` (no
 * extension on macOS/Linux) in a hooks directory, fed the pending tool call as
 * JSON on stdin. It refuses the call when the hook prints `{"cancel": true}`
 * on stdout; the exit code does not decide anything. Confirmed against
 * Cline's source (apps/vscode/src/core/hooks, sdk/packages/core/src/hooks):
 *
 * - The VS Code extension reads `<workspace>/.clinerules/hooks/PreToolUse` and
 *   runs it only when "Enable Hooks" is on in Cline's feature settings and the
 *   file is executable. Its payload is
 *   `{hookName, preToolUse: {toolName, parameters}}`, each parameter value
 *   JSON-encoded as a string.
 * - The Cline CLI/SDK searches the same `.clinerules/hooks` directory (plus
 *   `.cline/hooks` and two user-level directories). Its payload is
 *   `{hookName, tool_call: {id, name, input}}`.
 *
 * So one file, `.clinerules/hooks/PreToolUse`, covers both, and the gate
 * accepts both payload shapes. There is no `hooks.json` and no matcher: the
 * hook runs for every tool call, MCP calls (`use_mcp_tool`) included, and the
 * gate decides from the arguments.
 *
 * `.clinerules` must therefore be a directory. Earlier versions wrote it as a
 * flat rules file (and registered the gate in a `.cline/hooks/hooks.json`
 * Cline never reads); `ensureClinerulesDirectory` converts the flat file this
 * product wrote, and leaves a flat `.clinerules` the user wrote alone — in
 * that case no gate can be installed and a warning says why.
 *
 * LLD #14 — Phase 3 cross-harness defence
 * HLD §3.14 — Three-Tier Defense Cascade
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from '@intutic/logger'
import { keepOriginal, noteWritten } from '../disconnect/originals.js'
import { newIso } from '@intutic/id'
import { emitJsGate, emitJsFailClosedPrelude, REVIEW_REQUESTS_BASENAME } from './gateBody.js'

const log = createLogger('sync-cline-hooks')

/** First line of every rules file this product writes. */
const RULES_HEADER = '# Intutic Governance Rules (auto-generated)'

/** Marker line in the generated hook, used to recognise our own file. */
const GATE_MARKER = 'Intutic Cline PreToolUse governance gate.'

/**
 * Make `<workspace>/.clinerules` a directory, converting the flat rules file
 * earlier versions of this product wrote there.
 *
 * @returns `true` when `.clinerules` is (now) a directory; `false` when it is a
 *          file the user wrote, which is left alone (a warning is logged).
 */
export async function ensureClinerulesDirectory(workspaceRoot: string): Promise<boolean> {
  const rulesPath = path.join(workspaceRoot, '.clinerules')
  let stat
  try {
    stat = await fs.stat(rulesPath)
  } catch {
    await fs.mkdir(rulesPath, { recursive: true })
    return true
  }
  if (stat.isDirectory()) return true

  const content = await fs.readFile(rulesPath, 'utf-8')
  if (!content.startsWith(RULES_HEADER)) {
    log.warn(
      { action: 'cline_rules_file_kept', path: rulesPath },
      '.clinerules is a rules file you wrote, so Intutic cannot create .clinerules/hooks/ — move its content into ' +
        '.clinerules/<name>.md to enable the Intutic gate',
    )
    return false
  }
  await fs.unlink(rulesPath)
  await fs.mkdir(rulesPath, { recursive: true })
  return true
}

/** Remove the `.cline/hooks` registration earlier versions wrote — Cline never
 *  read it. Only files carrying this product's names or marker are removed. */
async function removeLegacyRegistration(workspaceRoot: string): Promise<void> {
  const legacyDir = path.join(workspaceRoot, '.cline', 'hooks')
  await fs.rm(path.join(legacyDir, 'intutic-check.js'), { force: true })
  const legacyJson = path.join(legacyDir, 'hooks.json')
  try {
    const parsed = JSON.parse(await fs.readFile(legacyJson, 'utf-8')) as { _comment?: unknown }
    if (typeof parsed._comment === 'string' && parsed._comment.startsWith('Intutic governance hooks')) {
      await fs.unlink(legacyJson)
    }
  } catch {
    // Absent, or not ours to judge — left alone.
  }
}

/**
 * Write the Intutic gate to `<workspace>/.clinerules/hooks/PreToolUse`.
 *
 * @param workspaceRoot - Absolute workspace root path.
 * @param proxyUrl - Intutic proxy URL for inclusion in the gate header.
 * @param workspaceId - Workspace ID embedded in every hook event payload.
 * @returns the gate path, or `null` when it could not be installed without
 *          overwriting a file the user owns (a warning is logged).
 */
export async function writeClineHooks(
  workspaceRoot: string,
  proxyUrl: string,
  workspaceId = '',
): Promise<string | null> {
  await removeLegacyRegistration(workspaceRoot)
  const hooksDir = path.join(workspaceRoot, '.clinerules', 'hooks')
  const checkScriptPath = path.join(hooksDir, 'PreToolUse')
  // Kept before `.clinerules` is created, so disconnect knows it made the
  // directory: the gate is installed before any rules file is written.
  await keepOriginal(checkScriptPath, workspaceRoot)
  if (!(await ensureClinerulesDirectory(workspaceRoot))) return null
  await fs.mkdir(hooksDir, { recursive: true })

  try {
    const existing = await fs.readFile(checkScriptPath, 'utf-8')
    if (!existing.includes(GATE_MARKER)) {
      log.warn(
        { action: 'cline_hook_kept', path: checkScriptPath },
        'A PreToolUse hook you wrote already exists — left untouched, so the Intutic gate is not installed for Cline',
      )
      return null
    }
  } catch {
    // No hook yet.
  }

  // ── pre-tool-check script ────────────────────────────────────────────
  // Return {"cancel": false} to allow, {"cancel": true, "errorMessage": "..."} to block.
  const checkScript = `#!/usr/bin/env node
/**
 * ${GATE_MARKER}
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 * Proxy: ${proxyUrl}
 * Generated: ${newIso()}
 */
${emitJsFailClosedPrelude({ harness: 'cline', contract: 'stdout-cancel' })}
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

const HOOK_EVENTS_LOG = path.join(os.homedir(), '.intutic', 'events', 'cline-hook-events.jsonl');

let _intuticSessionId = '';
function logEvent(verdict, toolName, reason) {
  try {
    const ts = new Date().toISOString();
    const incidentId = crypto.createHash('sha1').update(ts + toolName + _intuticWsId).digest('hex').slice(0, 16);
    // The event's id: random, made once here, and resent with the line it is
    // written into, so the control plane processes the event once.
    const eventId = crypto.randomBytes(16).toString('hex');
    const entry = JSON.stringify({ // Passed through, not collapsed to two values: the advisory tier emits
      // 'tool_flagged', and a ternary here silently recorded it as an allow.
      event: verdict, toolName, reason: reason || '', workspaceId: _intuticWsId, harnessType: 'cline', timestamp: ts, incidentId, eventId, ...(_intuticSessionId ? { sessionId: _intuticSessionId } : {}) }) + '\\n';
    // mkdir first. This was a bare appendFileSync inside a swallowing catch, so
    // on any machine where nothing else had created ~/.intutic/events the append
    // threw ENOENT and was discarded — every Cline audit line, including blocks,
    // silently dropped. The other writers create this directory from the
    // TypeScript side; Cline's writer only creates its hooks directory, so its log
    // existed only by luck.
    try {
      const _dir = path.dirname(HOOK_EVENTS_LOG);
      if (!fs.existsSync(_dir)) fs.mkdirSync(_dir, { recursive: true });
      fs.appendFileSync(HOOK_EVENTS_LOG, entry, { flag: 'a' });
    } catch {}
    if (_intuticKey) {
      try {
        const body = JSON.stringify({ events: [JSON.parse(entry)] });
        const urlObj = new URL('/api/v1/hook-events', _intuticHost);
        const mod = urlObj.protocol === 'https:' ? https : require('http');
        const req = mod.request({ hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + _intuticKey } });
        req.on('error', () => {});
        req.write(body); req.end();
      } catch {}
    }
  } catch {}
}

${emitJsGate({ harness: 'cline', contract: 'stdout-cancel', reviewRequestFile: path.join(workspaceRoot, '.intutic', 'events', REVIEW_REQUESTS_BASENAME) })}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const ctx = JSON.parse(raw);
    _intuticSessionId = ctx.taskId || ctx.task_id || ctx.session_id || ctx.sessionId || ctx.conversation_id || ctx.conversationId || '';
    // An envelope carrying none of the tool fields extracts to empty strings,
    // which match no rule — an allow. Refused instead, and the refusal CANCELS
    // (this harness ignores exit codes); see intuticGuardEnvelope.
    intuticGuardEnvelope(ctx, ['tool_call', 'preToolUse', 'tool_name', 'toolName', 'tool_input', 'toolInput'], logEvent);

    // Cline sends one of two shapes (see clineHooks.ts): the CLI/SDK's
    // tool_call {name, input}, or the VS Code extension's preToolUse
    // {toolName, parameters} with every parameter value JSON-encoded as a
    // string. tool_name/tool_input is the generic shape the shared gate tests
    // drive. Case is preserved for the gate: a BLOCK: SOP compiles to a
    // tool-name pattern the operator wrote as they see it.
    const dejson = (v) => {
      if (typeof v !== 'string') return v;
      try { const p = JSON.parse(v); return (p !== null && typeof p === 'object') ? p : v; } catch { return v; }
    };
    let rawToolName = '';
    let input = {};
    if (ctx.tool_call && typeof ctx.tool_call === 'object') {
      rawToolName = ctx.tool_call.name || '';
      input = ctx.tool_call.input;
    } else if (ctx.preToolUse && typeof ctx.preToolUse === 'object') {
      rawToolName = ctx.preToolUse.toolName || '';
      const params = ctx.preToolUse.parameters || {};
      input = {};
      for (const k of Object.keys(params)) input[k] = dejson(params[k]);
    } else {
      rawToolName = ctx.tool_name || ctx.toolName || '';
      input = ctx.tool_input || ctx.toolInput || {};
    }
    if (input === null || typeof input !== 'object') input = { input: input };
    const tool = rawToolName.toLowerCase();

    // The CLI's file and shell tools take lists (read_files {files}, run_commands
    // {commands}); the extension's take single values. Both are read.
    const firstFile = Array.isArray(input.files) && input.files.length > 0
      ? (typeof input.files[0] === 'string' ? input.files[0] : (input.files[0] && input.files[0].path) || '')
      : '';
    const commands = Array.isArray(input.commands)
      ? input.commands.map((c) => (typeof c === 'string' ? c : (c && c.command) || '')).join('\\n')
      : '';
    const targetPath = input.path || input.file_path || input.filePath ||
      input.target || input.source || input.notebook_path || firstFile || '';
    const command = input.command || input.cmd || input.script || commands || '';
    intuticGate(rawToolName, targetPath, command, logEvent, _intuticWsId, input);

    // Allow all other tool calls
    logEvent('tool_allowed', tool || 'unknown', '');
    process.stdout.write(JSON.stringify({ cancel: false }));
    process.exit(0);
  } catch (err) {
    // Fail CLOSED — hook parse error blocks the tool call
    logEvent('tool_blocked', 'unknown', String(err));
    process.stdout.write(JSON.stringify({
      cancel: true,
      errorMessage: '[Intutic Governance] Hook error (fail-closed): ' + String(err),
    }));
    process.exit(0);
  }
});
`

  const tmpScript = checkScriptPath + '.intutic-tmp'
  await fs.writeFile(tmpScript, checkScript, 'utf-8')
  await fs.rename(tmpScript, checkScriptPath)
  // Executable is what enables the hook: Cline creates new hook files 0644,
  // i.e. toggled off.
  await fs.chmod(checkScriptPath, 0o755)
  await noteWritten(checkScriptPath, workspaceRoot, checkScript)

  log.info({ action: 'cline_hooks_written', path: checkScriptPath }, 'Cline PreToolUse governance hook written')
  return checkScriptPath
}
