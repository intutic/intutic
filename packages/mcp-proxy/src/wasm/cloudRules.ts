/**
 * wasm/cloudRules.ts — the workspace's custom rules from the control plane:
 * the rules uploaded from the dashboard, the CLI or Terraform, which the LLM
 * proxy enforces too.
 *
 * Port of the control-plane half of `packages/proxy/src/wasm/registry.rs`
 * (`ensure_up_to_date`, `load_descriptor`, `report_refusal`). The descriptors
 * arrive with the workspace policy this proxy already fetches (`wasmRules` on
 * `GET /api/v1/sop/rules`, or on the MCP daemon's cached
 * `GET /api/v1/policy/resolve`), so they refresh when the policy does. Each
 * binary is fetched by the SHA-256 its descriptor names, only when no loaded
 * rule already has that hash, and must hash to it before it is compiled:
 * whoever can answer for that hash could otherwise swap a governance rule for
 * one that allows everything.
 *
 * A version that cannot load — binary missing, hash mismatch, or a module the
 * worker refuses — is reported once per hash and reason, and the version of
 * that rule already loaded, if any, keeps enforcing. A control plane that
 * cannot be reached for a binary leaves the whole loaded set as it was, as
 * `registry.rs` does when its fetch fails.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { WasmRuleDescriptor, WasmRuleMode } from '@intutic/shared-types'
import { createStderrLogger as createLogger } from '../stderrLog.js'
import { HttpStatusError, getBytes } from '../httpJson.js'
import type { WasmRuleRefusalDetail } from '../emitter.js'
import { MAX_RULE_FILE_BYTES, type CompileBridge, type CompileFailureReason } from './loader.js'

const log = createLogger('mcp-proxy-wasm-cloud')

/**
 * Minimum time between attempts after a sync that could not reach the control
 * plane or refused a version — the Rust proxy's 5-second rescan, so a binary
 * published a moment after its descriptor is picked up as quickly there.
 */
export const CLOUD_RETRY_MS = 5_000

/** A control-plane rule loaded into the worker. */
export interface CloudRuleMeta {
  /** The control plane's rule id (`wasm_…`), reported as is, like the Rust proxy does. */
  ruleId: string
  name: string
  sha256: string
  priority: number
  mode: WasmRuleMode
  readsReferencedFiles: boolean
  rego: boolean
  /** Kept so a worker respawn can recompile without fetching again. */
  bytes: Uint8Array
}

/**
 * Why a control-plane rule version was not loaded (`registry.rs`'s `Refusal`).
 * `kind` is the reason the control plane files the incident under
 * (`RULE_LOAD_FAILURE_REASONS`): a module the worker refuses carries the
 * worker's own reason for it.
 */
export type CloudRuleRefusal =
  | { kind: 'missing' }
  | { kind: 'hash_mismatch'; actual: string }
  | { kind: CompileFailureReason; error: string }

/** One refused version, reported once per hash and reason. */
export interface CloudRuleRefusalReport {
  descriptor: WasmRuleDescriptor
  refusal: CloudRuleRefusal
  /** Whether an earlier version of the rule stays in force. */
  hasPrevious: boolean
  /** The sentence the incident and the log line carry, in the Rust proxy's words. */
  description: string
}

/**
 * The binary a hash names: its bytes, or `null` when the control plane has
 * none. Throws when the control plane cannot be asked.
 */
export type FetchRuleBinary = (sha256: string) => Promise<Uint8Array | null>

/** What the sync needs from the worker, implemented by `WasmRunner`. */
export interface CloudRuleBridge extends CompileBridge {
  /** A rule's loaded version changed: whatever the previous version did no longer counts against it. */
  replaced(ruleId: string): void
}

/**
 * Fetches binaries from the control plane's rule store by hash. A 404 is a
 * binary the control plane does not have; any other failure means it could
 * not be asked.
 */
export function fetchRuleBinaryFrom(controlPlaneUrl: string, apiKey: string): FetchRuleBinary {
  return async (sha256) => {
    const url = `${controlPlaneUrl}/api/v1/wasm-rules/binaries/${encodeURIComponent(sha256)}`
    try {
      return await getBytes(url, apiKey, MAX_RULE_FILE_BYTES)
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) return null
      throw err
    }
  }
}

/** A refusal as the `wasm_rule_refused` event carries it. */
export function refusalDetail(report: CloudRuleRefusalReport): WasmRuleRefusalDetail {
  const { descriptor, refusal } = report
  return {
    ruleId: descriptor.ruleId,
    name: descriptor.name,
    sha256: descriptor.sha256,
    refusal: refusal.kind,
    ...(refusal.kind === 'hash_mismatch' ? { actualSha256: refusal.actual } : {}),
    previousInForce: report.hasPrevious,
  }
}

/** Whether `bytes` are the binary `sha256` names; case is not significant in hex. */
export function binaryMatches(bytes: Uint8Array, sha256: string): { matches: boolean; actual: string } {
  const actual = createHash('sha256').update(bytes).digest('hex')
  return { matches: actual === sha256.toLowerCase(), actual }
}

/** What makes two refusals of one version the same report (`Refusal::key`). */
function refusalKey(refusal: CloudRuleRefusal): string {
  if (refusal.kind === 'hash_mismatch') return refusal.actual
  return refusal.kind
}

export function describeRefusal(descriptor: WasmRuleDescriptor, refusal: CloudRuleRefusal, hasPrevious: boolean): string {
  const why =
    refusal.kind === 'missing'
      ? "its binary is missing from the control plane"
      : refusal.kind === 'hash_mismatch'
        ? `its binary hashes to ${refusal.actual} but its descriptor names ${descriptor.sha256}`
        : `it cannot be loaded: ${refusal.error}`
  const consequence = hasPrevious
    ? 'The previously loaded version stays in force.'
    : 'No version of this rule has loaded on this proxy, so it enforces nothing until one does.'
  return `WASM rule '${descriptor.name}' (${descriptor.ruleId}) was refused: ${why}. ${consequence}`
}

export class CloudRuleSet {
  private rules: CloudRuleMeta[] = []
  /** The descriptor list last applied, serialized; `undefined` until one has been. */
  private appliedKey: string | undefined
  /** The list of the last attempt, applied or not, and when it ran. */
  private attemptedKey: string | undefined
  private attemptedAt = 0
  /** Whether the applied list left a version unloaded, so it is retried. */
  private incomplete = false
  private syncing: Promise<void> | null = null
  private readonly refusalsReported = new Set<string>()

  constructor(
    private readonly fetchBinary: FetchRuleBinary,
    private readonly report: (report: CloudRuleRefusalReport) => void,
  ) {}

  /** Whether a descriptor list has been applied, so the loaded set is the workspace's. */
  isLoaded(): boolean {
    return this.appliedKey !== undefined
  }

  /** The loaded rules, in descriptor order. */
  getRules(): readonly CloudRuleMeta[] {
    return this.rules
  }

  /**
   * Brings the loaded set in line with `descriptors`.
   *
   * A changed list is applied before this resolves, so the call that follows
   * a policy refresh is judged by the new set. Retrying versions the applied
   * list refused, at most every {@link CLOUD_RETRY_MS}, runs in the
   * background: the loaded set is already the workspace's. A list that could
   * not be applied is retried no sooner either, so an unreachable control
   * plane costs a call one fetch timeout at most every few seconds rather
   * than on every call.
   */
  async sync(descriptors: readonly WasmRuleDescriptor[], bridge: CloudRuleBridge): Promise<void> {
    while (this.syncing) await this.syncing
    const key = JSON.stringify(descriptors)
    const due = Date.now() - this.attemptedAt >= CLOUD_RETRY_MS
    if (key === this.appliedKey) {
      if (this.incomplete && due) void this.run(descriptors, key, bridge)
      return
    }
    if (key === this.attemptedKey && !due) return
    await this.run(descriptors, key, bridge)
  }

  /**
   * Recompiles every loaded rule from its kept bytes — the worker that held
   * them was replaced. Waits for a sync in flight, which may have compiled
   * into the old worker.
   */
  async reload(bridge: CompileBridge): Promise<void> {
    while (this.syncing) await this.syncing
    for (const rule of this.rules) await bridge.compile(rule.ruleId, rule.bytes)
  }

  private run(descriptors: readonly WasmRuleDescriptor[], key: string, bridge: CloudRuleBridge): Promise<void> {
    const run = this.apply(descriptors, key, bridge)
      .catch((err: unknown) => {
        // The worker itself failed under the sync; the loaded set is unchanged
        // and the next sync tries again.
        log.warn({ action: 'wasm_cloud_sync_failed', err: (err as Error).message }, "Syncing the workspace's custom rules failed")
      })
      .finally(() => {
        if (this.syncing === run) this.syncing = null
      })
    this.syncing = run
    return run
  }

  private async apply(descriptors: readonly WasmRuleDescriptor[], key: string, bridge: CloudRuleBridge): Promise<void> {
    this.attemptedKey = key
    this.attemptedAt = Date.now()

    const previousBySha = new Map(this.rules.map((r) => [r.sha256, r]))
    const previousByRule = new Map(this.rules.map((r) => [r.ruleId, r]))

    // Every binary no loaded rule already has, fetched before anything
    // changes: a control plane that cannot be reached leaves the loaded set
    // exactly as it was.
    const wanted = [...new Set(descriptors.map((d) => d.sha256).filter((sha) => !previousBySha.has(sha)))]
    let fetched: Map<string, Uint8Array | null>
    try {
      fetched = new Map(await Promise.all(wanted.map(async (sha) => [sha, await this.fetchBinary(sha)] as const)))
    } catch (err) {
      log.warn(
        { action: 'wasm_cloud_fetch_failed', err: (err as Error).message, loaded: this.rules.length },
        this.isLoaded()
          ? "Could not fetch the workspace's custom rules; the loaded set stays in force"
          : "Could not fetch the workspace's custom rules; none have loaded yet",
      )
      return
    }

    const next: CloudRuleMeta[] = []
    let incomplete = false
    for (const descriptor of descriptors) {
      const reuse = previousBySha.get(descriptor.sha256)
      const outcome = reuse
        ? await this.reuse(descriptor, reuse, bridge)
        : await this.load(descriptor, fetched.get(descriptor.sha256) ?? null, bridge)
      if ('kind' in outcome) {
        incomplete = true
        const previous = previousByRule.get(descriptor.ruleId)
        this.reportOnce(descriptor, outcome, previous !== undefined)
        if (previous) next.push(previous)
        continue
      }
      if (previousByRule.get(descriptor.ruleId)?.sha256 !== descriptor.sha256) bridge.replaced(descriptor.ruleId)
      next.push(outcome)
    }

    // A rule no longer listed — deleted, or switched off — stops enforcing.
    const kept = new Set(next.map((r) => r.ruleId))
    for (const rule of this.rules) {
      if (!kept.has(rule.ruleId)) bridge.remove(rule.ruleId)
    }

    this.rules = next
    this.appliedKey = key
    this.incomplete = incomplete
    log.info(
      { action: 'wasm_cloud_rules_loaded', rules: next.length, listed: descriptors.length },
      "Workspace's custom rules loaded",
    )
  }

  /** A binary some loaded rule already has: compiled again only when it is new to this rule id. */
  private async reuse(
    descriptor: WasmRuleDescriptor,
    loaded: CloudRuleMeta,
    bridge: CompileBridge,
  ): Promise<CloudRuleMeta | CloudRuleRefusal> {
    if (loaded.ruleId !== descriptor.ruleId) {
      const result = await bridge.compile(descriptor.ruleId, loaded.bytes)
      if (!result.ok) return { kind: result.reason, error: result.error }
    }
    return { ...loaded, ...descriptor }
  }

  /** `load_descriptor`: the hash, then the same load checks as a local rule. */
  private async load(
    descriptor: WasmRuleDescriptor,
    bytes: Uint8Array | null,
    bridge: CompileBridge,
  ): Promise<CloudRuleMeta | CloudRuleRefusal> {
    if (!bytes) return { kind: 'missing' }
    const { matches, actual } = binaryMatches(bytes, descriptor.sha256)
    if (!matches) return { kind: 'hash_mismatch', actual }
    const result = await bridge.compile(descriptor.ruleId, bytes)
    if (!result.ok) return { kind: result.reason, error: result.error }
    return { ...descriptor, readsReferencedFiles: result.readsReferencedFiles, rego: result.rego, bytes }
  }

  private reportOnce(descriptor: WasmRuleDescriptor, refusal: CloudRuleRefusal, hasPrevious: boolean): void {
    const id = [descriptor.sha256, refusalKey(refusal)].join('\u0000')
    if (this.refusalsReported.has(id)) return
    this.refusalsReported.add(id)
    const description = describeRefusal(descriptor, refusal, hasPrevious)
    log.error({ action: 'wasm_cloud_rule_refused', ruleId: descriptor.ruleId, sha256: descriptor.sha256, refusal: refusal.kind }, description)
    this.report({ descriptor, refusal, hasPrevious, description })
  }
}
