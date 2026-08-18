/**
 * The enforcement point.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/gate.py`.
 *
 * Intutic ships PreToolUse hooks for the harnesses it has a native adapter
 * for; frameworks outside that list (Mastra, the Vercel AI SDK, LangChain.js,
 * a hand-rolled loop) have no adapter, and the sync-daemon writes no
 * PreToolUse hook for them. This package is that enforcement point: the
 * missing adapter, written against Intutic's own published gate contract.
 *
 * Four tiers, in order — identical precedence to the Python SDK:
 *
 *   A1  policy snapshot   port of intuticGate()          fails CLOSED
 *   A3  SOP rules         authored in the product        fails OPEN (A2 covers it)
 *   A2  image integrity   local check                    fails CLOSED
 *   B   POST /hook-gate   control-plane check             fail posture set by GateClient
 *
 * A1 and A2 are load-bearing and local. Tier B contributes the DLP regexes
 * and workspace policy from the control plane; whether an unreachable control
 * plane blocks is the client's `failClosed` setting (default true).
 *
 * Tier A3 applies rules written in the SOP register rather than in code. It
 * runs BEFORE A2 so that a block, when both would fire, is attributed to the
 * authored policy rather than to the hardcoded one. It fails open because A2
 * covers the identical case and fails closed: A3 moves where the policy is
 * *written*, and is not what makes the run safe. See soprules.ts.
 *
 * ## Naming note for callers porting from other Intutic SDKs
 *
 * This is NOT the "static floor" tier the compiled shell/JS gate emitters
 * carry (`staticFloorPatterns()` in
 * `services/sync-daemon/src/harness/protectedPaths.ts`, concatenated ahead of
 * the snapshot's own rules in `gateBody.ts`'s `intuticGate()`). Like the
 * Python SDK it ports, this package's Tier A1 reads ONLY
 * `~/.intutic/hooks/policy-snapshot.rules` — the compiled-in bypass/secret/
 * skill-surface patterns never reach that file (only SOP-authored rules, the
 * destructive-command tier, and the tier-promoted skill-surface rules do, via
 * `buildSnapshotRules` in `services/sync-daemon/src/lib/policySnapshot.ts`).
 * A workspace relying on this SDK for governance therefore gets a strict
 * SUBSET of what a shipped shell/JS harness gate enforces. That gap already
 * exists in the Python SDK this package ports; it is not introduced here. See
 * `src/__tests__/fidelity.test.ts` for the parts of the shipped contract this
 * package's Tier A1 DOES reproduce exactly (the destructive-command and
 * skill-surface pattern tables, as they would arrive via a real snapshot).
 */

import { existsSync, readFileSync } from 'node:fs'
import { isDeploy, touchesInfra } from './actions.js'
import { IntuticGateRefusal } from './errors.js'
import { GateClient } from './client.js'
import * as imagecheck from './imagecheck.js'
import * as snapshot from './snapshot.js'
import * as soprules from './soprules.js'

/** Tools that cannot change anything. They still get the local snapshot check
 *  (Tier A1), but skip the remote gate call (Tier B). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'read',
  'cat',
  'view',
])

export interface GateConfig {
  repoRoot?: string
  workspaceId?: string
  allowlistPath?: string
  enforce?: boolean
  useHookGate?: boolean
  useSopRules?: boolean
}

interface ResolvedConfig {
  repoRoot: string
  workspaceId: string
  allowlistPath: string
  enforce: boolean
  useHookGate: boolean
  useSopRules: boolean
}

function resolveConfig(cfg: GateConfig): ResolvedConfig {
  return {
    repoRoot: cfg.repoRoot ?? '.',
    workspaceId: cfg.workspaceId ?? '',
    allowlistPath: cfg.allowlistPath ?? '.intutic/image-allowlist.json',
    enforce: cfg.enforce ?? true,
    useHookGate: cfg.useHookGate ?? true,
    useSopRules: cfg.useSopRules ?? true,
  }
}

export type ToolInput = Record<string, unknown>

export class Gate {
  readonly cfg: ResolvedConfig
  readonly client: GateClient | null
  private _snapshot: snapshot.Snapshot | null = null
  private _snapshotReported = false
  private _policy: imagecheck.ImagePolicy | null = null
  /** `null` = not fetched yet. A failed fetch caches `[]` so one unreachable
   *  control plane does not add a timeout to every subsequent tool call. */
  private _sopRules: soprules.SopRule[] | null = null

  constructor(cfg: GateConfig = {}, client: GateClient | null = null) {
    this.cfg = resolveConfig(cfg)
    this.client = client
  }

  private allowlistAbs(): string {
    const p = this.cfg.allowlistPath
    return isAbsolutePath(p) ? p : joinPath(this.cfg.repoRoot, p)
  }

  // ------------------------------------------------------------ loading

  getSnapshot(): snapshot.Snapshot {
    if (this._snapshot === null) {
      this._snapshot = snapshot.loadSnapshot(this.cfg.workspaceId)
    }
    return this._snapshot
  }

  /**
   * Load the image allowlist.
   *
   * A missing or malformed allowlist is NOT treated as "allow everything".
   * An empty policy with `require_digest` still refuses every unpinned
   * image, which is the safe direction; a policy we cannot read at all
   * throws, and the caller turns that into a block.
   */
  getPolicy(): imagecheck.ImagePolicy {
    if (this._policy === null) {
      const path = this.allowlistAbs()
      if (!existsSync(path)) {
        throw new IntuticGateRefusal(
          `[image-integrity] ${imagecheck.E_MANIFEST_UNPARSEABLE}: image allowlist not found at ` +
            `${path}; refusing to approve an image against a policy that does not exist`,
          imagecheck.E_MANIFEST_UNPARSEABLE,
        )
      }
      try {
        this._policy = JSON.parse(readFileSync(path, 'utf-8')) as imagecheck.ImagePolicy
      } catch (exc) {
        const name = exc instanceof Error ? exc.constructor.name : 'Error'
        throw new IntuticGateRefusal(
          `[image-integrity] ${imagecheck.E_MANIFEST_UNPARSEABLE}: image allowlist at ${path} is ` +
            `unreadable (${name})`,
          imagecheck.E_MANIFEST_UNPARSEABLE,
        )
      }
    }
    return this._policy
  }

  /**
   * Active SOP rules, fetched once per process.
   *
   * Deliberately not refreshed on a timer: a rule set that changes mid-run
   * makes a verdict depend on when the fetch landed. Construct a new `Gate`
   * (or clear the cache) to refresh.
   */
  async getSopRules(): Promise<soprules.SopRule[]> {
    if (this._sopRules === null) {
      let fetched: soprules.SopRule[] | null = null
      if (this.client !== null) {
        fetched = await soprules.fetchRules(this.client.baseUrl, this.client.apiKey, this.cfg.workspaceId)
      }
      if (fetched === null) {
        // Could not read the register. Say so once, then stay quiet — Tier
        // A2 still fails closed on the same condition.
        await this.emit(
          'tool_flagged',
          'sop_rules',
          'SOP rule register unreachable; SOP-rule tier inactive for this run ' +
            '(image-integrity check unaffected)',
        )
        fetched = []
      }
      this._sopRules = fetched
    }
    return this._sopRules
  }

  // ------------------------------------------------------------ emitting

  private async emit(
    event: string,
    tool: string,
    reason = '',
    toolInput?: unknown,
    incidentId?: string,
    filePath?: string,
  ): Promise<void> {
    if (this.client !== null) {
      await this.client.emit(event, tool, reason, toolInput, incidentId, filePath)
    }
  }

  /**
   * Report snapshot condition exactly once per process — otherwise these
   * states are computed and never read, and an operator cannot distinguish
   * "snapshot missing on 400 machines" from "snapshot healthy".
   */
  private async reportSnapshotHealthOnce(tool: string): Promise<void> {
    if (this._snapshotReported) return
    this._snapshotReported = true
    const snap = this.getSnapshot()
    if (snap.state !== 'ok') {
      await this.emit(`snapshot_${snap.state}`, tool, snap.healthMessage)
    }
  }

  // --------------------------------------------------------------- guard

  /** Throws {@link IntuticGateRefusal} if this call must not run. Resolves to allow. */
  async guard(toolName: string, toolInput: ToolInput): Promise<void> {
    if (!this.cfg.enforce) return

    const target = String(toolInput.path ?? toolInput.file_path ?? '')
    const command = String(toolInput.command ?? '')

    await this.reportSnapshotHealthOnce(toolName)

    // ---- Tier A1: policy snapshot -------------------------------------
    const disabled = snapshot.guardDisabledFromEnv()
    if (disabled) {
      await this.emit(
        'guards_disabled',
        toolName,
        'INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; built-in protections still active',
      )
    }

    const d = snapshot.evaluate(toolName, target, command, this.getSnapshot(), disabled)
    if (d.severity === snapshot.SEV_BLOCK) {
      await this.emit('tool_blocked', toolName, d.reason, toolInput)
      throw new IntuticGateRefusal(d.reason, 'SNAPSHOT')
    }
    if (d.severity === snapshot.SEV_WARN) {
      await this.emit('tool_flagged', toolName, d.reason, toolInput)
    } else if (d.severity === snapshot.SEV_SHADOW) {
      await this.emit('tool_would_block', toolName, d.reason, toolInput)
    }

    // ---- Tier A3: SOP rules authored in the product --------------------
    //
    // Runs before A2 on purpose. When both would fire, the block should be
    // attributed to the policy someone wrote in the register, not to the one
    // hardcoded here.
    if (this.cfg.useSopRules && !READ_ONLY_TOOLS.has(toolName)) {
      const rule = soprules.firstMatch(await this.getSopRules(), toolName, toolInput)
      if (rule !== null) {
        const reason = `[sop:${rule.id}] ${rule.reason}`
        if (rule.action === soprules.ACTION_BLOCK) {
          await this.emit('tool_blocked', toolName, reason, toolInput)
          throw new IntuticGateRefusal(reason, 'SOP_RULE')
        }
        if (rule.action === soprules.ACTION_APPROVAL) {
          // No human is at the keyboard during an agent run, so an approval
          // that cannot be granted is a block.
          await this.emit(
            'tool_blocked',
            toolName,
            `${reason} (approval required; no reviewer in an unattended run)`,
            toolInput,
          )
          throw new IntuticGateRefusal(reason, 'SOP_RULE_APPROVAL')
        }
        await this.emit('tool_flagged', toolName, reason, toolInput)
      }
    }

    // ---- Tier A2: image integrity -------------------------------------
    if (isDeploy(toolName, toolInput)) {
      const verdict = imagecheck.checkCommand(command, this.cfg.repoRoot, this.getPolicy())
      if (!verdict.ok) {
        const reason = `${imagecheck.verdictReason(verdict)} — policy ${this.cfg.allowlistPath}`
        await this.emit('tool_blocked', toolName, reason, toolInput)
        throw new IntuticGateRefusal(reason, verdict.code)
      }
    }

    // A write to infrastructure gets the same check one turn earlier, as a
    // flag rather than a block: the dashboard then shows the bad manifest
    // being authored before it is applied.
    if (target && touchesInfra(target) && 'content' in toolInput) {
      const v = imagecheck.checkWrittenManifest(target, String(toolInput.content), this.getPolicy())
      if (!v.ok) {
        await this.emit(
          'tool_flagged',
          toolName,
          `${imagecheck.verdictReason(v)} (authoring-time check; the apply will be refused)`,
          toolInput,
          undefined,
          target,
        )
      }
    }

    // ---- Tier B: control plane gate -----------------------------------
    //
    // Skipped for read-only tools — a network round trip whose checks are
    // DLP regexes over the arguments and SOP rules, neither of which can say
    // anything useful about a directory listing.
    if (this.cfg.useHookGate && this.client !== null && !READ_ONLY_TOOLS.has(toolName)) {
      const resp = await this.client.hookGate(toolName, toolInput)
      if (!resp.allowed) {
        await this.emit('tool_blocked', toolName, resp.reason, toolInput, resp.incidentId)
        throw new IntuticGateRefusal(resp.reason, 'HOOK_GATE', resp.incidentId)
      }
    }

    if (!READ_ONLY_TOOLS.has(toolName)) {
      await this.emit('tool_allowed', toolName, '', toolInput)
    }
  }
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

function joinPath(a: string, b: string): string {
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`
}

// Module-level active gate, so wrapped tools do not need the instance
// threaded through every call site.
let _active: Gate | null = null

export function install(gate: Gate | null): void {
  _active = gate
}

export function active(): Gate | null {
  return _active
}
