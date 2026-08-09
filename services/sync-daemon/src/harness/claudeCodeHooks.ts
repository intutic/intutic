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
import { emitJsGate, emitJsFailClosedPrelude } from './gateBody.js'
import { emitRedactor } from './holdRedaction.js'

const log = createLogger('sync-claude-hooks')

/**
 * Coerces an unvalidated settings value to a string array, dropping anything else.
 *
 * `settings.json` is a file the user edits by hand, so `permissions.deny` being
 * an array of strings is a convention, not a guarantee. Spreading a bare string
 * would splice it into the deny list one character at a time.
 */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}


/** Path to the local hook event log file appended by generated hook scripts. */
export const HOOK_EVENTS_LOG = '.intutic/events/hook-events.jsonl'

/** Basename of the review-hold log. One record per line, appended. */
export const REVIEW_REQUESTS_BASENAME = 'review-requests.jsonl'

/** Path to the review-hold log, relative to the workspace root. */
export const REVIEW_REQUESTS_LOG = `.intutic/events/${REVIEW_REQUESTS_BASENAME}`

/**
 * Record version written by the hook and expected by the drain.
 *
 * Bumped when the shape changes. The drain rejects anything it does not
 * recognise rather than guessing, because a half-understood hold produces a
 * decision row that looks complete and is not.
 */
export const REVIEW_REQUEST_VERSION = 1

// Zod schema to parse SOP evaluation criteria and tool restrictions
/**
 * Keeps the strings and drops everything else, instead of rejecting the array.
 *
 * `z.array(z.string())` fails the WHOLE object on one bad element, and
 * `safeParse` failing here discards the entire block — every valid pattern and
 * every valid hold along with the one bad entry. That is TD-310's shape one
 * layer down: a batch rejected as a unit because of a single member, with the
 * loss silent.
 *
 * A malformed entry is dropped and the rest of the policy still compiles.
 */
const stringList = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : v),
  z.array(z.string()).default([]),
)

export const SopHookConstraintsSchema = z.object({
  highRiskTools: stringList,
  patterns: stringList,
  /**
   * Actions that must not run until a human has approved the run.
   *
   * Distinct from `patterns`, which is a permanent denial. This is a *hold*: the
   * action is legitimate, and someone wants to see it before it happens.
   *
   * This is the half of the review gate that is genuinely pre-execution. The
   * proxy can only refuse the request *after* a harness has already run the tool
   * — it sees the call in the next message. The hook runs before, so declaring
   * `action:deploy` here stops the push itself, not merely everything after it.
   */
  reviewBefore: stringList,
})

export type SopHookConstraints = z.infer<typeof SopHookConstraintsSchema>

/**
 * Extracts constraints from SOP registry entries.
 * Looks inside SOP markdown content for structured JSON/YAML blocks or parses settings.
 */
/**
 * The front-matter key this harness re-parses, lowercased once.
 *
 * The Rust side owns this directive; the TS side reads it a second time because
 * the two gates run in different runtimes with no shared parser, and a fixture
 * test pins them together.
 */
const REVIEW_BEFORE_KEY = 'review_before:'

/**
 * Strip surrounding quotes and brackets in one linear pass.
 *
 * Replaces `/^["'[]+|["'\]]+$/g`, which CodeQL flagged as polynomial: the
 * trailing alternative is `+` anchored to end-of-string, so a token that is a
 * long run of quote characters and never reaches the end makes the engine
 * retry from every position. `content` is SOP text, and an agent that can write
 * a SOP file chooses it — so that was a denial of service against the daemon
 * doing the governing.
 *
 * Mirrors Rust's `trim_matches(['"', '\'', '[', ']'])` in `sops.rs`, which is
 * what this parser is pinned against, and which was never a regex.
 */
function trimQuotesAndBrackets(value: string): string {
  const isTrimmable = (c: string): boolean =>
    c === '"' || c === "'" || c === '[' || c === ']'
  let start = 0
  let end = value.length
  while (start < end && isTrimmable(value[start]!)) start++
  while (end > start && isTrimmable(value[end - 1]!)) end--
  return value.slice(start, end)
}

export function parseSopConstraints(
  sops: SyncSopEntry[],
  settings?: Record<string, unknown> | import('@intutic/shared-types').WorkspaceSettings,
): SopHookConstraints {
  const highRiskToolsSet = new Set<string>()
  const patternsSet = new Set<string>()
  const reviewBeforeSet = new Set<string>()

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
    // Same omission, second delivery path. Settings and the SOP block are both
    // ways the control plane hands down a constraint; dropping it in one of them
    // makes the behaviour depend on which route happened to carry it.
    if (Array.isArray(s['reviewBefore'])) {
      (s['reviewBefore'] as unknown[]).forEach((r) => typeof r === 'string' && reviewBeforeSet.add(r))
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
            // `reviewBefore` was declared on the schema, validated here, and
            // then not copied — so a hold delivered through this block parsed
            // clean and reached nothing. Only the front-matter `review_before:`
            // line ever populated the set.
            //
            // This block is the seam the learning loop writes through, so the
            // omission was the difference between a learned rule enforcing and
            // a learned rule being reported as installed while doing nothing.
            validated.data.reviewBefore.forEach((r) => reviewBeforeSet.add(r))
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

    // `review_before:` front matter.
    //
    // The same directive the proxy reads from `.intutic/sops/*.md`, parsed a
    // second time here because the two gates live in different runtimes and
    // there is no shared parser. Kept deliberately simple — one comma-separated
    // line — and pinned against the Rust side by a fixture test, because two
    // parsers for one directive is exactly how a rule ends up enforced at one
    // gate and silently ignored at the other.
    //
    // Scanned line by line rather than with `/^\s*review_before:\s*(.+)$/gim`,
    // and trimmed with a linear pass rather than `/^["'[]+|["'\]]+$/g`. Both
    // regexes were polynomial on input this function does not control: `content`
    // is SOP file text, and an agent that can write a SOP file chooses it. A run
    // of whitespace that never reaches `review_before:` makes the first
    // backtrack from every start position, and a run of quotes that never
    // reaches end-of-string does the same to the second — so a crafted SOP could
    // hang the sync daemon, which is the process enforcing governance.
    //
    // The replacement is also closer to the Rust side it is pinned against:
    // `sops.rs` uses `trim()` and `trim_matches(['"', '\'', '[', ']'])`, neither
    // of which is a regex.
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trimStart()
      if (!line.toLowerCase().startsWith(REVIEW_BEFORE_KEY)) continue
      for (const token of line.slice(REVIEW_BEFORE_KEY.length).split(',')) {
        const cleaned = trimQuotesAndBrackets(token.trim())
        if (cleaned) reviewBeforeSet.add(cleaned)
      }
    }
  }

  return {
    highRiskTools: Array.from(highRiskToolsSet),
    patterns: Array.from(patternsSet),
    reviewBefore: Array.from(reviewBeforeSet),
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
        command: `node ${node_path.join(workspaceRoot, '.intutic', 'hooks', 'claude-code-check.js')}`,
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
  // Where the hook records a review hold. The daemon watches this directory
  // already, so no new watcher is needed to notice one.
  //
  // Append-only JSONL, not a single `.json`. It was one file written with
  // `writeFileSync`, so a second hold in the same drain window silently
  // destroyed the first — and holds cluster, because an agent that trips one
  // review rule usually trips it again on the next step.
  const reviewRequestFile = node_path.join(hookEventsDir, REVIEW_REQUESTS_BASENAME)

  const hookScriptContent = `
/**
 * Intutic PreToolUse execution gate.
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 *
 * Governance events are appended to .intutic/events/hook-events.jsonl
 * and drained to the control plane by the sync-daemon on each cycle.
 * Control plane: ${controlPlaneUrl ?? 'https://api.intutic.ai'}
 */
${emitJsFailClosedPrelude({ harness: 'claude-code', contract: 'exit2' })}
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

// Governance-sensitive paths and command shapes that no agent may reach.
//
// This block used to be hand-built here, and it read \`...UNIVERSAL_PROTECTED_PATHS,\`
// with no \${} — so the identifier was emitted as literal source text into a
// script that never imports it. Node threw ReferenceError on line 30 of the
// generated file, before the gate did anything: the protected-path check, the
// shell-bypass check and the review_before hold were all dead for Claude Code,
// the harness most people run. A PreToolUse hook exiting 1 is a hook error, not
// a block, so tool calls proceeded ungoverned and nothing said so.
//
// It is emitted from harness/gateBody.ts now. That does not make the escaping
// easier; it makes there be one of it, with one set of tests.
${emitJsGate({ harness: 'claude-code', contract: 'exit2' })}
${emitRedactor()}

/**
 * Appends a governance event to the local hook-events log.
 * Uses synchronous append (O_APPEND is atomic for single-write < PIPE_BUF).
 * The sync-daemon drains this file on each cycle and POSTs to the control plane.
 */
function logEvent(verdict, toolName, reason, sessionId) {
  try {
    const ts = new Date().toISOString();
    const incidentId = crypto.createHash('sha1').update(ts + toolName + _intuticWsId).digest('hex').slice(0, 16);
    const entry = JSON.stringify({
      // Passed through, not collapsed to two values: the advisory tier emits
      // 'tool_flagged', and a ternary here silently recorded it as an allow.
      event: verdict,
      toolName,
      reason: reason || '',
      workspaceId: _intuticWsId,
      harnessType: ${JSON.stringify(harnessType)},
      timestamp: ts,
      incidentId,
      // TD-209: Claude Code's PreToolUse contract puts session_id on stdin;
      // it was parsed and dropped, so trust decay and enforcement logging fell
      // back to the synthetic per-workspace session and could never attribute
      // a block to the person whose agent made it.
      ...(sessionId ? { sessionId } : {}),
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

// Where a hold is recorded for the daemon to pick up. Local file, not a network
// call: this runs before every tool invocation, and a hook that waits on HTTP is
// a hook that makes every agent slower.
const REVIEW_REQUEST_FILE = ${JSON.stringify(reviewRequestFile)};

// Read stdin containing Claude's tool context
let inputData = '';
process.stdin.on('data', (chunk) => { inputData += chunk; });
process.stdin.on('end', () => {
  try {
    const ctx = JSON.parse(inputData);
    // An envelope carrying none of the tool fields extracts to empty strings,
    // which match no rule — an allow. Refused instead; see the guard itself.
    intuticGuardEnvelope(ctx, ['tool_name', 'toolName', 'tool_input', 'toolInput'],
      (v, t, r) => logEvent(v, t, r, String(ctx.session_id || ctx.sessionId || '')));
    const toolName = (ctx.tool_name || ctx.toolName || '').toLowerCase();
    // Case preserved for review matching: an operator writes \`review_before: Write\`,
    // and the harness calls the tool \`Write\`.
    const rawToolName = ctx.tool_name || ctx.toolName || '';
    const sessionId = ctx.session_id || ctx.sessionId || '';
    const toolInput = ctx.tool_input || ctx.toolInput || {};
    const toolInputStr = JSON.stringify(toolInput);

    // Protected paths and shell-bypass patterns, from the shared gate.
    //
    // Both checks used to be gated on the tool name: paths only for
    // edit/write/multiedit, commands only for a fixed list of five shell tool
    // names. Any tool outside those lists walked past both. The shared gate keys
    // on the *arguments* instead, so a tool name nobody anticipated is no longer
    // a way through.
    const targetPath = toolInput.path || toolInput.file_path || toolInput.filePath ||
      toolInput.new_path || toolInput.target || toolInput.notebook_path || '';
    const shellCmd = String(toolInput.command || toolInput.cmd || toolInput.script || '');
    intuticGate(rawToolName, targetPath, shellCmd,
      (v, t, r) => logEvent(v, t, r, sessionId), _intuticWsId, toolInput);

    // 2. Review holds — the pre-execution half of \`review_before:\`.
    //
    // Unlike the pattern blacklist below, this is not a permanent denial. The
    // action is legitimate; someone asked to see it first. Blocking here is what
    // makes the review genuinely *pre*-acceptance: the proxy only ever learns of
    // a tool call after the harness ran it, so its own hold stops everything
    // *after* the push rather than the push.
    //
    // Entirely local — a file write and an exit code, no network call on the
    // tool path. The daemon picks the request up and tells the control plane.
    const reviewBefore = ${JSON.stringify(constraints.reviewBefore)};
    if (reviewBefore.length > 0) {
      // The same coarse mapping the proxy's classifier uses, kept minimal on
      // purpose: a hook that tries to be clever about shell commands is a hook
      // that blocks real work. Anything it cannot classify falls through to the
      // proxy's own gate — but only as an *observation*: this hook is what runs
      // before the tool executes, while the proxy sees the call in the next
      // request's history, after it happened. So a needle missing here is a
      // review_before SOP that watches instead of holding.
      //
      // These lists mirror the proxy's actions.rs, and hookActionParity.test.ts
      // fails if they diverge in either direction: a needle only the hook knows
      // would hold a call the proxy then allows, which reads as a spurious hold.
      const actions = [];
      if (['bash', 'shell', 'run_command', 'terminal', 'execute'].includes(toolName)) {
        const cmd = String(toolInput.command || toolInput.cmd || toolInput.script || '').toLowerCase();
        const map = [
          ['action:deploy', ['git push', 'kubectl apply', 'kubectl rollout', 'helm upgrade', 'helm install', 'terraform apply', 'docker push', 'serverless deploy', 'fly deploy', 'vercel deploy', 'gcloud run deploy', 'aws deploy', 'aws s3 sync', 'eb deploy']],
          ['action:publish', ['npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'twine upload', 'poetry publish', 'gem push', 'docker manifest push']],
          ['action:release', ['gh release create', 'git tag', 'npm version', 'cargo release', 'goreleaser release', 'semantic-release']],
          ['action:db_write', ['insert into', 'update ', 'delete from', 'drop table', 'truncate ', 'alter table']],
        ];
        for (const [action, needles] of map) {
          if (needles.some((n) => cmd.includes(n))) actions.push(action);
        }
      }
      // Raw tool names count too: "review_before: Write" is the natural thing to
      // write, and the eight action tokens do not cover the edit tools.
      const candidates = [...actions, toolName, rawToolName];
      const hit = reviewBefore.find((r) =>
        candidates.some((c) => String(c).toLowerCase() === String(r).toLowerCase()),
      );
      if (hit) {
        try {
          // \`fs\` and \`path\`, not the daemon's \`node_fs\` / \`node_path\` aliases.
          // Those are this module's import names; the emitted script binds
          // \`const fs = require('fs')\`. The original write used the daemon's
          // names, so every hold threw ReferenceError into the catch below and
          // the request file was never created at all — the reason it had no
          // reader is that it had no writer either.
          fs.mkdirSync(path.dirname(REVIEW_REQUEST_FILE), { recursive: true });
          // Appended, never overwritten. This wrote a single .json with
          // writeFileSync, so two holds inside one drain window left only the
          // second — and holds cluster, because an agent that trips a review
          // rule usually trips it again on its next step.
          //
          // The snapshot is redacted here rather than in the daemon. Doing it
          // on the way out would mean the plaintext had already been written to
          // .intutic/events/, and a file that exists is a file that ends up in
          // a bug report.
          fs.appendFileSync(
            REVIEW_REQUEST_FILE,
            JSON.stringify({
              v: ${REVIEW_REQUEST_VERSION},
              holdId: 'hold_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
              reason: hit,
              tool: rawToolName,
              sessionId: sessionId,
              workspaceId: _intuticWsId,
              at: new Date().toISOString(),
              context: __intuticSnapshot({
                tool: rawToolName,
                toolInput: toolInput,
                cwd: process.cwd(),
                reason: hit,
              }),
            }) + '\\n',
          );
        } catch (e) {
          // The hold still blocks even if the record cannot be written — the
          // exit code below is what stops the tool. But say so: a hold that
          // blocks and is never recorded is a developer stopped for a reason
          // nobody can review, which is the worst of both outcomes.
          console.error('[Intutic Guardrail] could not record the hold: ' + (e && e.message ? e.message : e));
        }
        const reason = \`Held for human review: \${hit} — declared in review_before:\`;
        console.error(\`[Intutic Guardrail] HELD: \${reason} Approve with: intutic loop review <id> --approve\`);
        logEvent('tool_blocked', toolName, reason, sessionId);
        process.exit(2);
      }
    }

    // 3. SOP-compiled pattern blacklist
    const patterns = ${JSON.stringify(constraints.patterns)};
    for (const pattern of patterns) {
      if (toolInputStr.includes(pattern)) {
        const reason = \`Policy violation matching pattern: "\${pattern}"\`;
        console.error(\`[Intutic Guardrail] Blocked execution of tool "\${toolName}" due to \${reason}\`);
        logEvent('tool_blocked', toolName, reason, sessionId);
        process.exit(2);
      }
    }

    logEvent('tool_allowed', toolName, '', sessionId);
    process.exit(0);
  } catch (err) {
    // Fail CLOSED — any hook execution error blocks the tool call.
    // The sync daemon will rewrite this hook on the next sync cycle.
    console.error('[Intutic Guardrail] Hook error (blocking for safety):', err);
    logEvent('tool_blocked', 'unknown', String(err), '');
    process.exit(2);
  }
});
`.trim()

  // Named after its writer. This and cursorHooks both emitted
  // `pre-tool-check.js` into `<root>/.intutic/hooks/`, so on any machine running
  // both harnesses the second writer silently overwrote the first and one
  // harness ran the other's gate. `generatedGateBehaviour.test.ts` asserts the
  // artifact set is a partition, so the collision cannot come back unnoticed.
  await node_fs.writeFile(node_path.join(hookScriptDir, 'claude-code-check.js'), hookScriptContent, 'utf-8')

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
  //
  // GUARD (bugfix): never touch the user's real global settings from a test
  // run. Vitest sets VITEST=1; without this guard, every run of
  // __tests__/harness/claudeCodeHooks.test.ts merged the MOCK SOP denies
  // (Bash/Write/rm -rf/…) into the developer's real ~/.claude/settings.json
  // and pointed global hooks at a mkdtemp dir the test then deleted —
  // leaving dead fail-closed hooks and a denied Bash/Write toolset.
  // INTUTIC_SKIP_GLOBAL_HOOKS=1 is an explicit opt-out for dev machines.
  if (process.env['VITEST'] || process.env['INTUTIC_SKIP_GLOBAL_HOOKS']) {
    log.info(
      { action: 'global_hooks_skipped' },
      'Skipping global ~/.claude settings write (test or opt-out environment)',
    )
    return
  }

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
      // `permissions` comes from the user's settings.json, so its shape is a
      // claim rather than a guarantee — narrow instead of asserting. A `deny`
      // that is not an array (someone hand-edited it to a string) would
      // otherwise spread character by character into the deny list.
      deny: Array.from(
        new Set([...toStringArray((existingGlobal.permissions as Record<string, unknown> | undefined)?.['deny']), ...denyRules]),
      ),
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
/**
 * Drains one append-only JSONL log to a control-plane endpoint.
 *
 * Extracted because there are two of these now — hook events and review holds —
 * and the delivery semantics below are the part that must not diverge. TD-310
 * was exactly that: a batch the control plane could never accept was retained
 * and re-sent every cycle, so the log never drained again and every later event
 * behind it was lost, silently. A second hand-written copy of this logic is a
 * second chance to get that wrong.
 *
 * @returns the number of records delivered; 0 on any failure.
 */
async function drainJsonlLog(opts: {
  logPath: string
  endpoint: string
  apiKey: string
  /** Wraps the parsed records into the request body the endpoint expects. */
  bodyFor: (records: unknown[]) => unknown
  /** Noun used in log lines, e.g. "hook events". */
  label: string
}): Promise<number> {
  let raw: string
  try {
    raw = await node_fs.readFile(opts.logPath, 'utf-8')
  } catch {
    return 0 // File doesn't exist yet — nothing to drain
  }

  const lines = raw.trim().split('\n').filter(Boolean)
  if (lines.length === 0) return 0

  const records: unknown[] = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      log.warn({ line, label: opts.label }, 'Skipping malformed log line')
    }
  }

  if (records.length === 0) {
    await node_fs.writeFile(opts.logPath, '', 'utf-8')
    return 0
  }

  try {
    // Use native fetch (Node 18+ — required minimum for this monorepo)
    const response = await fetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(opts.bodyFor(records)),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      // Truncate the log — records successfully delivered
      await node_fs.writeFile(opts.logPath, '', 'utf-8')
      log.info({ count: records.length, label: opts.label }, 'Drained to control plane')
      return records.length
    }

    // A 4xx will never succeed on retry, and retaining the log means re-sending
    // the identical rejected batch on every cycle from now on. That does not
    // delay delivery of these records — it stops delivery of *all* later ones,
    // silently, because the log never drains again.
    //
    // This was live: adding an event type to the gates without adding it to the
    // control plane's enum made one ordinary advisory event poison every batch
    // behind it. The control plane now drops unknown events instead of
    // rejecting the batch, so this path should be unreachable for that cause —
    // but "should be unreachable" is exactly what was believed before, and the
    // cost of being wrong is the whole pipeline.
    //
    // So: move the batch aside rather than dropping or retrying it. Nothing is
    // lost, a human can inspect it, and the live log drains.
    if (response.status >= 400 && response.status < 500) {
      const rejectedPath = opts.logPath.replace(/\.jsonl$/, '.rejected.jsonl')
      let body = ''
      try {
        body = (await response.text()).slice(0, 500)
      } catch {
        // The status is the part that matters; a missing body must not throw here.
      }
      try {
        await node_fs.appendFile(rejectedPath, lines.join('\n') + '\n', 'utf-8')
        await node_fs.writeFile(opts.logPath, '', 'utf-8')
      } catch (err) {
        // If we cannot set it aside, retaining is better than losing it.
        log.error(
          { err, status: response.status, label: opts.label },
          'Could not quarantine rejected batch — retaining log',
        )
        return 0
      }
      log.error(
        { status: response.status, count: records.length, rejectedPath, body, label: opts.label },
        'Control plane rejected the batch with a client error — quarantined so the log can ' +
          'keep draining. These records were NOT delivered.',
      )
      return 0
    }

    // 5xx or anything else: transient. Retain and retry, which is what the
    // retention behaviour was actually designed for.
    log.warn(
      { status: response.status, count: records.length, label: opts.label },
      'Control plane rejected the batch — retaining log for next cycle',
    )
    return 0
  } catch (err) {
    // Network failure — retain log for retry on next cycle
    log.warn(
      { err, count: records.length, label: opts.label },
      'Failed to drain — will retry on next sync cycle',
    )
    return 0
  }
}

/**
 * Drains the local hook-events log file and POSTs all accumulated governance
 * events to the control plane in a single batch request.
 *
 * Called by the sync-daemon's main loop (syncLoop.ts) on every cycle, after
 * the main sync operations. On success, the log file is truncated to prevent
 * unbounded growth. On network failure, events remain in the log and will be
 * retried on the next cycle.
 */
export async function drainHookEvents(
  workspaceRoot: string,
  controlPlaneUrl: string,
  apiKey: string,
): Promise<number> {
  return drainJsonlLog({
    logPath: node_path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl'),
    endpoint: `${controlPlaneUrl}/api/v1/hook-events`,
    apiKey,
    bodyFor: (events) => ({ events }),
    label: 'hook events',
  })
}

/**
 * Drains review holds — the pre-execution half of `review_before:`.
 *
 * The hook writes a hold and exits 2, which stops the tool before it runs. That
 * file had no reader: the comment beside the write claimed "the daemon picks the
 * request up and tells the control plane", and no daemon code opened it. So the
 * hold blocked the action and the decision behind it went nowhere — which is
 * also why the decision-mining queue had four route readers and no writer.
 *
 * This is the writer. It is observe-only: a delivered hold becomes a row and a
 * review card, and nothing about it changes what any harness blocks.
 */
export async function drainReviewRequests(
  workspaceRoot: string,
  controlPlaneUrl: string,
  apiKey: string,
): Promise<number> {
  return drainJsonlLog({
    logPath: node_path.join(workspaceRoot, '.intutic', 'events', REVIEW_REQUESTS_BASENAME),
    endpoint: `${controlPlaneUrl}/api/v1/decisions`,
    apiKey,
    bodyFor: (holds) => ({ holds }),
    label: 'review holds',
  })
}

