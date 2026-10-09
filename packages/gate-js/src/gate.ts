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
 * Six tiers, in order — identical precedence to the Python SDK:
 *
 *   A0  SSO group policy  from the policy snapshot       unknown groups refused
 *   A1  policy snapshot   port of intuticGate()          fails CLOSED
 *   M   MCP registry      from the policy snapshot       unverified snapshot admits none
 *   A3  SOP rules         authored in the product        fails OPEN (A2 covers it)
 *   A2  image integrity   local check                    fails CLOSED
 *   B   POST /hook-gate   control-plane check             fail posture set by GateClient
 *
 * Tier M applies the workspace's MCP server registry and `mcpAllowedServers`
 * list to an `mcp__<server>__<tool>` call, from the snapshot's
 * `@mcp_registry` and `@mcp_allowlist` records, with the decision, codes,
 * rule ids and reasons the hook gates and the MCP proxy use
 * (`mcpRegistryRecord.ts`, a byte-identical copy of `@intutic/shared-types`'
 * module). On a snapshot that fails its integrity check, Tier M refuses
 * every MCP call with `POLICY_SNAPSHOT_UNVERIFIED`, observe-only or not: a
 * deleted or edited record cannot be told from the workspace's own. A
 * refusal of an unapproved server reaches the control plane as a
 * `tool_blocked` event whose reason ends `[mcpDefaultPolicy]`, which puts the
 * server in the approval queue, as a hook gate's refusal does.
 *
 * A hold rule in A1 or A3 (a `REQUIRE_APPROVAL:` SOP, or a local
 * `review_before:` token) refuses with {@link IntuticGateHold} after
 * recording the hold for review, unless an approved bypass lets this exact
 * call through — the hook gates' and the MCP proxy's mechanism, through the
 * same decisions API. See hold.ts.
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
import { IntuticGateHold, IntuticGateRefusal, type GateRefusalCode } from './errors.js'
import { holdMessage, requestHold } from './hold.js'
import { tooLargeReason } from './limits.js'
import { GateClient } from './client.js'
import { evaluateMcpAllowlist, evaluateMcpRegistry, mcpSnapshotUnverifiedRefusal } from './mcpRegistryRecord.js'
import * as imagecheck from './imagecheck.js'
import * as snapshot from './snapshot.js'
import * as soprules from './soprules.js'
import { evaluateSsoGroupClearance } from './ssoGroups.js'

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

    // ---- Size: refused before any tier reads the call ------------------
    //
    // Every built-in rule is linear, but a workspace's own WHERE patterns
    // need not be, and the bound is what keeps a crafted call from holding
    // the agent (or a harness hook) past its deadline. See limits.ts.
    const tooLarge = tooLargeReason(command, toolInput)
    if (tooLarge !== null) {
      await this.emit('tool_blocked', toolName, tooLarge)
      throw new IntuticGateRefusal(tooLarge, 'COMMAND_TOO_LARGE')
    }

    await this.reportSnapshotHealthOnce(toolName)

    // ---- Tier A0: SSO group policy, from the snapshot ------------------
    //
    // The workspace's group policy decided for the member the snapshot was
    // issued to — the same evaluator, and so the same answer, as the control
    // plane's hook gate. Not skippable by INTUTIC_GUARD_DISABLE: it is the
    // workspace's own policy, not the destructive family.
    const sso = this.getSnapshot().ssoGroups
    if (sso) {
      const d = evaluateSsoGroupClearance(sso.policy, toolName, sso.member ? sso.member.ssoGroups : null)
      if (d.clearance !== 'GRANTED') {
        const reason = `${d.reason} [${d.ruleId}]`
        await this.emit('tool_blocked', toolName, reason, toolInput)
        throw new IntuticGateRefusal(reason, 'SSO_GROUP')
      }
    }

    // ---- Tier A1: policy snapshot -------------------------------------
    const disabled = snapshot.guardDisabledFromEnv()
    if (disabled) {
      await this.emit(
        'guards_disabled',
        toolName,
        'INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; built-in protections still active',
      )
    }

    // Hold rules an approved bypass let through on this call, so the register's
    // copy of the same rule in Tier A3 does not hold it a second time.
    const approved = new Set<string>()
    const d = snapshot.evaluate(toolName, target, command, this.getSnapshot(), disabled)
    if (d.severity === snapshot.SEV_HOLD) {
      await this.hold({ id: d.ruleId, reason: d.reason }, toolName, toolInput)
      approved.add(d.ruleId)
    } else if (d.severity === snapshot.SEV_BLOCK) {
      await this.emit('tool_blocked', toolName, d.reason, toolInput)
      throw new IntuticGateRefusal(d.reason, 'SNAPSHOT')
    }
    if (d.severity === snapshot.SEV_WARN) {
      await this.emit('tool_flagged', toolName, d.reason, toolInput)
    } else if (d.severity === snapshot.SEV_SHADOW) {
      await this.emit('tool_would_block', toolName, d.reason, toolInput)
    }

    // ---- Tier M: the MCP server registry and allowlist ----------------
    await this.guardMcp(toolName, toolInput)

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
          // Held for a person, under the id the snapshot gives the same rule
          // (`sop.<id>`), so one approval covers the call in either tier.
          const id = `sop.${rule.id}`
          if (!approved.has(id)) await this.hold({ id, reason: rule.reason }, toolName, toolInput)
        } else {
          await this.emit('tool_flagged', toolName, reason, toolInput)
        }
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
        // The hook gate names the MCP registry's own code when the registry
        // refused; anything else it refuses is HOOK_GATE.
        const code = MCP_CODES.has(resp.code ?? '') ? (resp.code as GateRefusalCode) : 'HOOK_GATE'
        throw new IntuticGateRefusal(resp.reason, code, resp.incidentId)
      }
    }

    if (!READ_ONLY_TOOLS.has(toolName)) {
      await this.emit('tool_allowed', toolName, '', toolInput)
    }
  }

  /**
   * Throws when the workspace's MCP server registry or allowlist refuses an
   * `mcp__<server>__<tool>` call: the registry first, as every gate orders
   * them. An allowlist in `shadow` records the refusal and lets the call on.
   * A snapshot that failed its integrity check admits no MCP server.
   */
  private async guardMcp(toolName: string, toolInput: ToolInput): Promise<void> {
    if (!toolName.startsWith('mcp__')) return
    const rest = toolName.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) return
    const snap = this.getSnapshot()
    const server = rest.slice(0, sep)
    if (snap.state === 'invalid') {
      const refusal = mcpSnapshotUnverifiedRefusal(server)
      const reason = `${refusal.reason} [${refusal.ruleId}]`
      await this.emit('tool_blocked', toolName, reason, toolInput)
      throw new IntuticGateRefusal(reason, refusal.code)
    }
    const registry = snap.mcpRegistry ? evaluateMcpRegistry(snap.mcpRegistry, server, rest.slice(sep + 2)) : null
    if (registry) {
      const reason = `${registry.reason} [${registry.ruleId}]`
      await this.emit('tool_blocked', toolName, reason, toolInput)
      throw new IntuticGateRefusal(reason, registry.code)
    }
    const allowlist = snap.mcpAllowlist ? evaluateMcpAllowlist(snap.mcpAllowlist, server) : null
    if (allowlist) {
      const reason = `${allowlist.reason} [${allowlist.ruleId}]`
      if (snap.mcpAllowlist!.severity === 'shadow') {
        await this.emit('tool_would_block', toolName, reason, toolInput)
        return
      }
      await this.emit('tool_blocked', toolName, reason, toolInput)
      throw new IntuticGateRefusal(reason, allowlist.code)
    }
  }

  /**
   * A hold rule matched: resolves when an approved bypass lets this exact
   * call through (the remaining tiers still apply), and otherwise throws
   * {@link IntuticGateHold} after recording the hold.
   */
  private async hold(rule: { id: string; reason: string }, toolName: string, toolInput: ToolInput): Promise<void> {
    const outcome = await requestHold(this.client, rule, toolName, toolInput)
    if (outcome.kind === 'bypassed') {
      // Let through, loudly: a bypass nobody can see used is no better than
      // no review at all.
      await this.emit(
        'hold_approved_bypass_used',
        toolName,
        `Approved bypass for ${rule.id} — approved by ${outcome.decidedBy || 'an approver'} on hold ${outcome.holdId}`,
        toolInput,
      )
      return
    }
    await this.emit('tool_held', toolName, `${rule.reason} [${rule.id}]`, toolInput)
    throw new IntuticGateHold(holdMessage(rule.reason, rule.id, outcome), outcome.recorded ? outcome.holdId : undefined)
  }
}

/** The refusal codes of the MCP registry and allowlist, which the hook gate may also return. */
const MCP_CODES: ReadonlySet<string> = new Set<GateRefusalCode>([
  'SERVER_BLOCKED',
  'SERVER_HELD',
  'SERVER_NOT_APPROVED',
  'TOOL_DISABLED',
  'SERVER_NOT_ALLOWED',
])

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === '/') end--
  return s.slice(0, end)
}

function trimLeadingSlashes(s: string): string {
  let start = 0
  while (start < s.length && s[start] === '/') start++
  return s.slice(start)
}

function joinPath(a: string, b: string): string {
  return `${trimTrailingSlashes(a)}/${trimLeadingSlashes(b)}`
}

// The process-wide active gate lives in registry.ts, which imports no Node.js
// built-ins (see that module's doc); re-exported so the API is unchanged.
export { install, active } from './registry.js'
