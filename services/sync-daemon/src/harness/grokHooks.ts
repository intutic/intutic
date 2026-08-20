/**
 * grokHooks.ts — xAI Grok Build (`grok`, GA 2026-05, open-sourced 2026-07-15)
 * governance hook injection.
 *
 * Writes the Intutic PreToolUse gate script and registers it at project and
 * user level:
 *   - `<workspaceRoot>/.grok/hooks/intutic-governance.json`
 *   - `~/.grok/hooks/intutic-governance.json`
 *
 * Also merges the Intutic proxy `base_url` into `config.toml`'s `[model.*]`
 * tables at both `<workspaceRoot>/.grok/config.toml` and
 * `~/.grok/config.toml` — the LLM-egress half of coverage, same split every
 * other harness in this file uses (the gate refuses tool calls; the config
 * merge routes the model traffic itself).
 *
 * # Blocking contract — CONFIRMED, not assumed
 *
 * Grok Build's `PreToolUse` hook carries no `matcher` (it fires for every
 * tool call), has a default `timeout` of 5s (ample for a local
 * policy-snapshot evaluation), and — this is the part that is independently
 * confirmed, unlike Muse Code's — signals a block by writing
 * `{"decision":"deny","reason":"..."}` as JSON on **stdout** and exiting 0.
 * That is a *different* stdout shape from Cline/Roo Code's `{"cancel":true}`
 * — Grok Build does not recognise `cancel`, and Cline/Roo Code do not
 * recognise `decision` — so this writer uses its own `BlockContract` value,
 * `'stdout-decision-deny'` (see gateBody.ts's module doc for why the two
 * stdout shapes are not folded into one contract), rather than reusing
 * `'stdout-cancel'` and silently going inert.
 *
 * # Double-gating with the Claude Code / Cursor compat paths
 *
 * Grok Build ALSO natively reads and executes `.claude/settings.json` hooks
 * and `.cursor/hooks.json` hooks if present (a compatibility feature) — so
 * if a workspace already has Intutic's Claude Code or Cursor gate installed,
 * BOTH that gate and this native one fire for the same Grok Build tool call.
 * This is the same "both layers firing is expected, not a bug" posture this
 * codebase already documents for the mcp-proxy + PreToolUse gate combination
 * (see apps/docs/guide/mcp-governance.md, "Both layers firing on the same
 * blocked call is expected, not a bug"): a block wins if EITHER gate blocks,
 * neither gate knows about the other's decision, and an operator may see a
 * `tool_blocked` event recorded twice for what was, from the developer's
 * point of view, one refused action. That is redundancy, not a discrepancy
 * to reconcile — see `grokHooks.test.ts` for a test pinning that a
 * double-fired block does not corrupt the audit log or the exit/stdout
 * contract of either gate.
 *
 * # `[model.*]` table naming — CONFIRMED against the real open-sourced parser
 *
 * The shape is `[model."<id>"]` with a per-model `base_url` (and many other
 * override fields — `xai_grok_shell::agent::config::ConfigModelOverride`),
 * keyed by model id and consulted only for the model whose id equals `<id>`;
 * it does not fall back to any other key. `xai-grok-models/default_models.json`
 * (embedded at compile time) pins the operative default id, CONFIRMED live by
 * cloning `github.com/xai-org/grok-build` (open-sourced 2026-07-15) and
 * reading it directly: `"default": "grok-4.6"` — NOT the literal string
 * `"default"`. This writer therefore overrides `base_url` on every EXISTING
 * `[model.*]` table (never invents one if the user already configured
 * models), and — only when no `[model.*]` table exists at all — seeds
 * `[model."grok-4.6"]`, the confirmed compiled-in default id, not a guess.
 * A future Grok Build release that changes its compiled default would make
 * this seeded table inert again until re-synced against a newer clone —
 * the same residual risk `windsurfHooks.ts`'s "confirmed, not evergreen"
 * caveat already documents for a versioned upstream default.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { createLogger } from '@intutic/logger'
import { newIso } from '@intutic/id'
import { emitJsGate, emitJsFailClosedPrelude } from './gateBody.js'

const log = createLogger('sync-grok-hooks')

const GROK_USER_DIR = path.join(os.homedir(), '.grok')

/** The single self-contained hook file this writer owns. Grok Build's hook
 *  directory is a glob of independent files (`.grok/hooks/*.json`), unlike
 *  Codex/Windsurf's one shared `hooks.json` — so, unlike those writers, this
 *  one never needs to merge into or preserve anything else in the
 *  directory: dropping its own uniquely-named file cannot clobber a hook the
 *  user registered themselves. */
const HOOK_FILENAME = 'intutic-governance.json'

/**
 * Builds the per-file registration this writer drops at
 * `.grok/hooks/intutic-governance.json` (project) and `~/.grok/hooks/intutic-governance.json`
 * (user).
 *
 * **Shape CONFIRMED against the real, now-open-source parser** (xAI open-sourced
 * `grok-build` 2026-07-15 — `github.com/xai-org/grok-build`, `crates/codegen/xai-grok-hooks`):
 * `xai_grok_hooks::config::parse_hook_file` (called identically for both a
 * settings-file source and a `.grok/hooks/*.json` directory entry — the SAME
 * function, see `discovery.rs`'s `load_hooks_from_settings_file`/
 * `load_hooks_from_directory`) requires a TOP-LEVEL `"hooks"` key; a file
 * without one returns an EMPTY spec set, silently — no error, no warning. The
 * value under `"hooks"` is keyed by event name to an ARRAY of `MatcherGroup`s
 * (`{matcher?: string, hooks: [{type, command, timeout?, ...}]}`), each entry
 * of which becomes one `HookSpec` — the exact shape Claude Code's own
 * `settings.json` `hooks` block uses, not the flat `{event, command, timeout}`
 * record this writer emitted before this fix (which the real parser silently
 * ignored — ZERO hooks ever registered, confirmed by having no top-level
 * `"hooks"` key at all). No `matcher` field on the group means "fires for
 * every tool call" (`MatcherGroup.matcher: Option<String>`, `#[serde(default)]`).
 */
function buildHookRegistration(hookScriptPath: string) {
  return {
    _comment: 'Intutic governance hook — auto-generated. DO NOT EDIT.',
    _lastSync: newIso(),
    hooks: {
      // No matcher — CONFIRMED to apply to every tool call.
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}"`,
              // Grok Build's documented default; stated explicitly rather than
              // left to fall back, since a local policy-snapshot evaluation is
              // cheap but a future default change upstream should not silently
              // starve this hook.
              timeout: 5,
            },
          ],
        },
      ],
    },
  }
}

function buildHookScript(proxyUrl: string, workspaceRoot: string, workspaceId: string): string {
  const hookEventsLog = path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  return `#!/usr/bin/env node
/**
 * Intutic Grok Build governance gate.
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 * Proxy: ${proxyUrl}
 * Generated: ${newIso()}
 */
${emitJsFailClosedPrelude({ harness: 'grok', contract: 'stdout-decision-deny' })}
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

${emitJsGate({ harness: 'grok', contract: 'stdout-decision-deny' })}

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
      harnessType: 'grok',
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
    _intuticSessionId = ctx.session_id || ctx.sessionId || '';
    intuticGuardEnvelope(ctx, ['tool_name', 'toolName', 'tool_input', 'toolInput'], logEvent);
    const input = ctx.tool_input || ctx.toolInput || {};
    const toolName = ctx.tool_name || ctx.toolName || 'tool';

    const targetPath = input.path || input.file_path || input.filePath || input.file ||
      input.target || input.notebook_path || '';
    const command = input.command || input.cmd || input.script || '';

    intuticGate(toolName, targetPath, command, logEvent, _intuticWsId, input);

    // Allow — no stdout object at all, which Grok Build reads as "not denied".
    logEvent('tool_allowed', toolName, '');
    process.exit(0);
  } catch (err) {
    // Fail CLOSED — the stdout-decision-deny contract, even on a crash inside
    // this handler (the module-level prelude above covers crashes outside it).
    const errMsg = String(err);
    process.stderr.write('[Intutic Governance] Hook error (fail-closed): ' + errMsg + '\\n');
    logEvent('tool_blocked', 'unknown', errMsg);
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: '[Intutic Governance] Hook error (fail-closed): ' + errMsg }) + '\\n');
    process.exit(0);
  }
});
`
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + '.intutic-tmp'
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, filePath)
}

// ─── config.toml model base_url merge ─────────────────────────────────────

/** Structural TOML shape this writer cares about; anything else round-trips
 *  through smol-toml untouched. */
interface GrokTomlDoc {
  model?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

/**
 * Grok Build's compiled-in default model id — CONFIRMED live (2026-08-20)
 * against `github.com/xai-org/grok-build`'s `crates/codegen/xai-grok-models/default_models.json`
 * `"default"` key, NOT a guess. See this module's `[model.*]` doc comment.
 * A future upstream release may change this; re-verify against a fresh
 * clone if this writer's seeded table stops being honoured.
 */
const GROK_DEFAULT_MODEL_ID = 'grok-4.6'

/**
 * The pre-parser fallback: append a `[model."<default id>"]` block only,
 * never touching (or even parsing) anything else in the file — mirroring
 * `injectGooseAppendOnly`'s reasoning exactly: a parser that cannot safely
 * represent a malformed file cannot safely round-trip it either, so the safe
 * degrade is "never touch anything but the block we control".
 */
async function mergeGrokConfigTomlAppendOnly(
  configPath: string,
  existingRaw: string,
  proxyUrl: string,
): Promise<void> {
  let text = existingRaw
  const tableHeader = `[model."${GROK_DEFAULT_MODEL_ID}"]`
  if (!text.includes(tableHeader) && !text.includes(`[model.${GROK_DEFAULT_MODEL_ID}]`)) {
    text = text.trimEnd() + `\n\n${tableHeader}\nbase_url = ${JSON.stringify(proxyUrl)}\n`
  }
  if (text === existingRaw) return

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmp = configPath + '.intutic-tmp'
  await fs.writeFile(tmp, text, 'utf-8')
  await fs.rename(tmp, configPath)
  log.info(
    { action: 'grok_config_written', path: configPath, mode: 'append_only_fallback' },
    'Grok config.toml updated (append-only fallback — did not parse as TOML)',
  )
}

/**
 * Structurally merges the Intutic proxy `base_url` into every `[model.*]`
 * table in `config.toml`, via `smol-toml` — the same "parse structurally,
 * write-if-changed, fall back to append-only on a parse failure" shape
 * `injectGoose` established for YAML, applied to TOML since no TOML-parsing
 * dependency existed anywhere in this monorepo before this writer (checked:
 * `openhandsHooks.ts`'s own `config.toml` edits are regex text-surgery, not
 * a real parse — the OpenHands precedent that predates this one).
 *
 * Never invents a model id if the user already configured one or more —
 * only overrides `base_url` on each existing `[model.*]` table. Only when
 * NO `[model.*]` table exists at all does it seed a `[model."<default id>"]`
 * table (`GROK_DEFAULT_MODEL_ID` below) — see this module's doc comment for
 * why that id is CONFIRMED against the real open-sourced default, not a guess.
 */
async function mergeGrokConfigToml(configPath: string, proxyUrl: string): Promise<void> {
  let existing = ''
  try {
    existing = await fs.readFile(configPath, 'utf-8')
  } catch {
    // Deliberate fail-open: no config.toml yet (first run) or unreadable.
    // Falls through with `existing` at '' so a fresh file is written below.
  }

  let doc: GrokTomlDoc
  try {
    doc = existing.trim() ? (parseToml(existing) as GrokTomlDoc) : {}
  } catch (err) {
    log.warn(
      { action: 'grok_toml_unparseable', path: configPath, err: (err as Error).message },
      'Grok config.toml did not parse as TOML — falling back to append-only text injection',
    )
    await mergeGrokConfigTomlAppendOnly(configPath, existing, proxyUrl)
    return
  }

  const model: Record<string, Record<string, unknown>> =
    doc.model && typeof doc.model === 'object' ? doc.model : {}
  const modelNames = Object.keys(model)
  let changed = false

  if (modelNames.length === 0) {
    // No [model.*] table exists yet — GROK_DEFAULT_MODEL_ID is CONFIRMED
    // against the real open-sourced compiled default (see module doc), not
    // a guess.
    model[GROK_DEFAULT_MODEL_ID] = { ...(model[GROK_DEFAULT_MODEL_ID] ?? {}), base_url: proxyUrl }
    changed = true
  } else {
    for (const name of modelNames) {
      const entry = model[name] && typeof model[name] === 'object' ? model[name] : {}
      if (entry.base_url !== proxyUrl) {
        model[name] = { ...entry, base_url: proxyUrl }
        changed = true
      }
    }
  }

  if (!changed) {
    // Already present and unchanged — write-if-changed, same reasoning
    // mcpAutoWrite.ts's writeJsonFile/injectGoose document: this runs every
    // sync cycle, so a no-op merge must not churn the file's mtime.
    return
  }

  doc.model = model
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmp = configPath + '.intutic-tmp'
  await fs.writeFile(tmp, stringifyToml(doc), 'utf-8')
  await fs.rename(tmp, configPath)
  log.info({ action: 'grok_config_written', path: configPath, mode: 'toml' }, 'Grok config.toml updated (structural TOML edit)')
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Write Grok Build hooks at project and user level, and merge the Intutic
 * proxy into `config.toml`'s `[model.*]` tables at both levels.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param proxyUrl      - Intutic proxy URL (also merged into config.toml).
 * @param workspaceId   - Workspace ID embedded in hook event payloads.
 */
export async function writeGrokHooks(
  workspaceRoot: string,
  proxyUrl: string,
  workspaceId = '',
): Promise<void> {
  const hookScriptDir = path.join(workspaceRoot, '.intutic', 'hooks')
  await fs.mkdir(hookScriptDir, { recursive: true })
  await fs.mkdir(path.join(workspaceRoot, '.intutic', 'events'), { recursive: true })

  const hookScriptPath = path.join(hookScriptDir, 'grok-check.js')
  const tmpScript = hookScriptPath + '.intutic-tmp'
  await fs.writeFile(tmpScript, buildHookScript(proxyUrl, workspaceRoot, workspaceId), 'utf-8')
  await fs.rename(tmpScript, hookScriptPath)
  await fs.chmod(hookScriptPath, 0o755)

  const registration = buildHookRegistration(hookScriptPath)

  // 1. Project-level: <root>/.grok/hooks/intutic-governance.json
  const projectHooksDir = path.join(workspaceRoot, '.grok', 'hooks')
  await atomicWriteJson(path.join(projectHooksDir, HOOK_FILENAME), registration)
  log.info({ action: 'grok_hooks_written', level: 'project', path: projectHooksDir }, 'Grok project-level hooks written')

  // 2. User-level: ~/.grok/hooks/intutic-governance.json
  const userHooksDir = path.join(GROK_USER_DIR, 'hooks')
  await atomicWriteJson(path.join(userHooksDir, HOOK_FILENAME), registration)
  log.info({ action: 'grok_hooks_written', level: 'user', path: userHooksDir }, 'Grok user-level hooks written')

  // 3. config.toml model base_url — project and user level.
  await mergeGrokConfigToml(path.join(workspaceRoot, '.grok', 'config.toml'), proxyUrl)
  await mergeGrokConfigToml(path.join(GROK_USER_DIR, 'config.toml'), proxyUrl)
}
