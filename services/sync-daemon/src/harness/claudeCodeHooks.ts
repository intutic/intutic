/**
 * claudeCodeHooks.ts — Claude Code PreToolUse hook generator.
 *
 * Compiles SOP evaluation criteria and high risk tools into native Claude Code
 * settings.json configurations (both permissions.deny rules and PreToolUse hooks).
 * Writes configurations locally to the workspace and globally to ~/.claude/.
 *
 * LLD #14 — claudeCodeHooks.ts
 * HLD §3.14 — Three-Tier Defense Cascade (Tier 1 Native Gating)
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { z } from 'zod'
import type { SyncSopEntry } from '@intutic/shared-types'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-claude-hooks')

/** Path to the local hook event log file appended by generated hook scripts. */
export const HOOK_EVENTS_LOG = '.intutic/events/hook-events.jsonl'

// Zod schema to parse SOP evaluation criteria and tool restrictions
export const SopHookConstraintsSchema = z.object({
  highRiskTools: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
})

export type SopHookConstraints = z.infer<typeof SopHookConstraintsSchema>

/**
 * Extracts constraints from SOP registry entries.
 * Looks inside SOP markdown content for structured JSON/YAML blocks or parses settings.
 */
export function parseSopConstraints(
  sops: SyncSopEntry[],
  settings?: Record<string, unknown> | import('@intutic/shared-types').WorkspaceSettings,
): SopHookConstraints {
  const highRiskToolsSet = new Set<string>()
  const patternsSet = new Set<string>()

  // 1. Parse from workspace settings if present
  // Treat settings as Record<string, unknown> for legacy field access (highRiskTools, patterns)
  if (settings) {
    const s = settings as Record<string, unknown>
    if (Array.isArray(s['highRiskTools'])) {
      (s['highRiskTools'] as unknown[]).forEach((t) => typeof t === 'string' && highRiskToolsSet.add(t))
    }
    if (Array.isArray(s['patterns'])) {
      (s['patterns'] as unknown[]).forEach((p) => typeof p === 'string' && patternsSet.add(p))
    }
  }

  // 2. Parse from SOP content
  for (const sop of sops) {
    const content = sop.content

    const startIdx = content.indexOf('```json')
    if (startIdx !== -1) {
      const jsonStart = content.indexOf('\n', startIdx)
      const endIdx = content.indexOf('```', jsonStart !== -1 ? jsonStart : startIdx + 7)
      if (jsonStart !== -1 && endIdx !== -1 && endIdx > jsonStart) {
        const jsonText = content.slice(jsonStart + 1, endIdx).trim()
        try {
          const parsed = JSON.parse(jsonText)
          const validated = SopHookConstraintsSchema.safeParse(parsed)
          if (validated.success) {
            validated.data.highRiskTools.forEach((t) => highRiskToolsSet.add(t))
            validated.data.patterns.forEach((p) => patternsSet.add(p))
          }
        } catch {
          // Ignore parsing failures
        }
      }
    }

    // Also look for inline patterns
    // e.g., "Blacklist Pattern: rm -rf"
    const patternRegexes = [/Blacklist Pattern:\s*`?([^`\n]+)`?/gi, /Deny Pattern:\s*`?([^`\n]+)`?/gi]
    for (const regex of patternRegexes) {
      let match
      while ((match = regex.exec(content)) !== null) {
        if (match[1]) {
          patternsSet.add(match[1].trim())
        }
      }
    }

    // e.g., "High Risk Tool: Bash"
    const toolRegex = /High Risk Tool:\s*`?([^`\n]+)`?/gi
    let toolMatch
    while ((toolMatch = toolRegex.exec(content)) !== null) {
      if (toolMatch[1]) {
        highRiskToolsSet.add(toolMatch[1].trim())
      }
    }
  }

  return {
    highRiskTools: Array.from(highRiskToolsSet),
    patterns: Array.from(patternsSet),
  }
}

/**
 * Compiles constraints into Claude Code settings.json format and writes it.
 *
 * @param workspaceRoot    - Workspace root path.
 * @param sops             - The sync SOP list.
 * @param settings         - Passthrough settings.
 * @param controlPlaneUrl  - Control plane base URL embedded into the hook events log path comment.
 * @param workspaceId      - Workspace ID embedded into hook event payloads.
 * @param harnessType      - Harness type tag written into each hook event.
 */
export async function updatePreToolUseHooks(
  workspaceRoot: string,
  sops: SyncSopEntry[],
  settings?: Record<string, unknown> | import('@intutic/shared-types').WorkspaceSettings,
  controlPlaneUrl?: string,
  workspaceId?: string,
  harnessType = 'claude-code',
): Promise<void> {
  const constraints = parseSopConstraints(sops, settings)

  log.info(
    { action: 'update_hooks', toolCount: constraints.highRiskTools.length, patternCount: constraints.patterns.length },
    'Compiling PreToolUse hook configurations for Claude Code'
  )

  // Build the permissions.deny rules and hooks structure
  const denyRules: string[] = []

  // High risk tools deny rules
  for (const tool of constraints.highRiskTools) {
    denyRules.push(tool)
  }

  // Pattern-based deny rules (e.g. Bash(rm -rf *))
  for (const pattern of constraints.patterns) {
    denyRules.push(`Bash(*${pattern}*)`)
  }

  // Build settings object matching Claude Code schema.
  // We hook Bash, Edit, Write, and MultiEdit so that the policy gate
  // covers file-modification tools in addition to shell execution.
  const hookEntry = (matcher: string) => ({
    matcher,
    hooks: [
      {
        type: 'command',
        command: `node ${node_path.join(workspaceRoot, '.intutic', 'hooks', 'pre-tool-check.js')}`,
        timeout: 10,
        statusMessage: 'Verifying tool execution against Intutic SOP policy...',
      },
    ],
  })

  const newSettings = {
    permissions: {
      deny: denyRules,
    },
    hooks: {
      PreToolUse: [
        hookEntry('Bash'),
        hookEntry('Edit'),
        hookEntry('Write'),
        hookEntry('MultiEdit'),
      ],
    },
  }

  // Create hook script locally in workspace root (.intutic/hooks/pre-tool-check.js)
  const hookScriptDir = node_path.join(workspaceRoot, '.intutic', 'hooks')
  await node_fs.mkdir(hookScriptDir, { recursive: true })

  // Ensure hook events log directory exists
  const hookEventsDir = node_path.join(workspaceRoot, '.intutic', 'events')
  await node_fs.mkdir(hookEventsDir, { recursive: true })
  const hookEventsLog = node_path.join(hookEventsDir, 'hook-events.jsonl')

  const hookScriptContent = `
/**
 * Intutic PreToolUse execution gate.
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 *
 * Governance events are appended to .intutic/events/hook-events.jsonl
 * and drained to the control plane by the sync-daemon on each cycle.
 * Control plane: ${controlPlaneUrl ?? 'https://api.intutic.ai'}
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// ── Runtime credentials (sourced from ~/.intutic/env/runtime.env at invocation time) ──
const _runtimeEnvPath = path.join(os.homedir(), '.intutic', 'env', 'runtime.env');
let _intuticHost = 'https://api.intutic.ai', _intuticKey = '', _intuticWsId = ${JSON.stringify(workspaceId ?? '')};
try {
  fs.readFileSync(_runtimeEnvPath, 'utf-8').split('\\n').forEach(line => {
    const eq = line.indexOf('='); if (eq < 0) return;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k === 'INTUTIC_HOST' && v) _intuticHost = v;
    if (k === 'INTUTIC_API_KEY' && v) _intuticKey = v;
    if (k === 'INTUTIC_WORKSPACE_ID' && v) _intuticWsId = v;
  });
} catch { /* runtime.env not yet written — use defaults */ }

// Governance-sensitive paths that no agent may modify.
// Editing these files is how privilege escalation occurs.
const PROTECTED_PATHS = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(os.homedir(), '.claude', 'settings.local.json'),
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.intutic/hooks',
  '.intutic/integrity.json',
  '.intutic/context_integrity.json',
];

/**
 * Appends a governance event to the local hook-events log.
 * Uses synchronous append (O_APPEND is atomic for single-write < PIPE_BUF).
 * The sync-daemon drains this file on each cycle and POSTs to the control plane.
 */
function logEvent(verdict, toolName, reason) {
  try {
    const ts = new Date().toISOString();
    const incidentId = crypto.createHash('sha1').update(ts + toolName + _intuticWsId).digest('hex').slice(0, 16);
    const entry = JSON.stringify({
      event: verdict === 'blocked' ? 'tool_blocked' : 'tool_allowed',
      toolName,
      reason: reason || '',
      workspaceId: _intuticWsId,
      harnessType: ${JSON.stringify(harnessType)},
      timestamp: ts,
      incidentId,
    }) + '\\n';
    // Path B: reliable file append (sync-daemon drains on FSEvents change)
    fs.appendFileSync(${JSON.stringify(hookEventsLog)}, entry, { flag: 'a' });
    // Path A: fire-and-forget HTTP POST (near-real-time dashboard, non-blocking)
    if (_intuticKey) {
      try {
        const body = JSON.stringify({ events: [JSON.parse(entry)] });
        const urlObj = new URL('/api/v1/hook-events', _intuticHost);
        const isHttps = urlObj.protocol === 'https:';
        const mod = isHttps ? https : require('http');
        const req = mod.request({
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Authorization': 'Bearer ' + _intuticKey,
          },
        });
        req.on('error', () => { /* fire-and-forget — ignore errors */ });
        req.write(body);
        req.end();
      } catch { /* never crash the hook */ }
    }
  } catch { /* never crash the hook */ }
}

// Read stdin containing Claude's tool context
let inputData = '';
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', () => {
  try {
    const ctx = JSON.parse(inputData);
    const toolName = (ctx.tool_name || ctx.toolName || '').toLowerCase();
    const toolInput = ctx.tool_input || ctx.toolInput || {};
    const toolInputStr = JSON.stringify(toolInput);

    // 1. Protected-path guard — block any file-modification tool targeting
    //    governance-sensitive paths regardless of SOP pattern list.
    if (['edit', 'write', 'multiedit'].includes(toolName)) {
      const targetPath = toolInput.path || toolInput.file_path ||
        toolInput.new_path || toolInput.target || '';
      for (const p of PROTECTED_PATHS) {
        if (targetPath.includes(p) || String(targetPath).startsWith(p)) {
          const reason = \`Attempt to modify governance-protected path: "\${targetPath}". \` +
            'To change governance policy, update your SOP via the Intutic control plane.';
          console.error(\`[Intutic Guardrail] BLOCKED: \${reason}\`);
          logEvent('blocked', toolName, reason);
          process.exit(2);
        }
      }
    }

    // 2. SOP-compiled pattern blacklist
    const patterns = ${JSON.stringify(constraints.patterns)};
    for (const pattern of patterns) {
      if (toolInputStr.includes(pattern)) {
        const reason = \`Policy violation matching pattern: "\${pattern}"\`;
        console.error(\`[Intutic Guardrail] Blocked execution of tool "\${toolName}" due to \${reason}\`);
        logEvent('blocked', toolName, reason);
        process.exit(2);
      }
    }

    logEvent('allowed', toolName, '');
    process.exit(0);
  } catch (err) {
    // Fail CLOSED — any hook execution error blocks the tool call.
    // The sync daemon will rewrite this hook on the next sync cycle.
    console.error('[Intutic Guardrail] Hook error (blocking for safety):', err);
    logEvent('blocked', 'unknown', String(err));
    process.exit(2);
  }
});
`.trim()

  await node_fs.writeFile(node_path.join(hookScriptDir, 'pre-tool-check.js'), hookScriptContent, 'utf-8')

  // Write local settings config
  const localClaudeDir = node_path.join(workspaceRoot, '.claude')
  await node_fs.mkdir(localClaudeDir, { recursive: true })
  const localSettingsPath = node_path.join(localClaudeDir, 'settings.json')

  let existingLocal: Record<string, unknown> = {}
  try {
    const raw = await node_fs.readFile(localSettingsPath, 'utf-8')
    existingLocal = JSON.parse(raw)
  } catch {
    // Ignore
  }

  const mergedLocal = {
    ...existingLocal,
    permissions: {
      ...(existingLocal.permissions as Record<string, unknown>),
      deny: denyRules,
    },
    hooks: {
      ...(existingLocal.hooks as Record<string, unknown>),
      PreToolUse: newSettings.hooks.PreToolUse,
    },
  }

  await node_fs.writeFile(localSettingsPath, JSON.stringify(mergedLocal, null, 2) + '\n', 'utf-8')

  // Write global settings config ~/.claude/settings.json
  const globalClaudeDir = node_path.join(node_os.homedir(), '.claude')
  await node_fs.mkdir(globalClaudeDir, { recursive: true })
  const globalSettingsPath = node_path.join(globalClaudeDir, 'settings.json')

  let existingGlobal: Record<string, unknown> = {}
  try {
    const raw = await node_fs.readFile(globalSettingsPath, 'utf-8')
    existingGlobal = JSON.parse(raw)
  } catch {
    // Ignore
  }

  // Merge, prioritizing global user settings but updating permissions/hooks
  const mergedGlobal = {
    ...existingGlobal,
    permissions: {
      ...(existingGlobal.permissions as Record<string, unknown>),
      deny: Array.from(new Set([...((existingGlobal.permissions as any)?.deny || []), ...denyRules])),
    },
    hooks: {
      ...(existingGlobal.hooks as Record<string, unknown>),
      PreToolUse: newSettings.hooks.PreToolUse,
    },
  }

  await node_fs.writeFile(globalSettingsPath, JSON.stringify(mergedGlobal, null, 2) + '\n', 'utf-8')
  log.info({ action: 'hooks_written' }, 'Successfully updated settings.json hooks globally and locally')
}

// ─── Event Drain Helper ──────────────────────────────────────────────────────

/**
 * Drains the local hook-events log file and POSTs all accumulated governance
 * events to the control plane in a single batch request.
 *
 * Called by the sync-daemon's main loop (syncLoop.ts) on every cycle, after
 * the main sync operations. On success, the log file is truncated to prevent
 * unbounded growth. On network failure, events remain in the log and will be
 * retried on the next cycle.
 *
 * @param workspaceRoot    - Workspace root (log file is at workspaceRoot/.intutic/events/hook-events.jsonl)
 * @param controlPlaneUrl  - Control plane base URL
 * @param apiKey           - Workspace API key (Bearer token)
 * @returns number of events drained (0 if log was empty or network failed)
 */
export async function drainHookEvents(
  workspaceRoot: string,
  controlPlaneUrl: string,
  apiKey: string,
): Promise<number> {
  const logPath = node_path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')

  let raw: string
  try {
    raw = await node_fs.readFile(logPath, 'utf-8')
  } catch {
    return 0 // File doesn't exist yet — nothing to drain
  }

  const lines = raw.trim().split('\n').filter(Boolean)
  if (lines.length === 0) return 0

  const events: unknown[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      log.warn({ line }, 'Skipping malformed hook event log line')
    }
  }

  if (events.length === 0) {
    await node_fs.writeFile(logPath, '', 'utf-8')
    return 0
  }

  try {
    // Use native fetch (Node 18+ — required minimum for this monorepo)
    const response = await fetch(`${controlPlaneUrl}/api/v1/hook-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      // Truncate the log — events successfully delivered
      await node_fs.writeFile(logPath, '', 'utf-8')
      log.info({ count: events.length }, 'Hook events drained to control plane')
      return events.length
    } else {
      log.warn(
        { status: response.status, count: events.length },
        'Control plane rejected hook events — retaining log for next cycle',
      )
      return 0
    }
  } catch (err) {
    // Network failure — retain log for retry on next cycle
    log.warn({ err, count: events.length }, 'Failed to drain hook events — will retry on next sync cycle')
    return 0
  }
}

