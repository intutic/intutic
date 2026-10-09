/**
 * PII detector definitions, shared with the Rust proxy.
 *
 * `piiDetectors.json` is a byte-identical copy of
 * `packages/proxy/src/dlp/pii_detectors.json`, which the Rust proxy embeds at
 * compile time. The proxy's image is built from `packages/proxy` alone, so it
 * cannot read this package, and this package ships to npm without the Rust
 * tree — hence two copies, each tested against the other (`dlp/pii.rs` and
 * the MCP proxy's `dlpPii.test.ts`). The validators the definition names are
 * implemented in `packages/proxy/src/dlp/pii.rs` and
 * `packages/mcp-proxy/src/dlpPii.ts`.
 */
import { z } from 'zod'
import definition from './piiDetectors.json'

/** What a detector does with a match, least to most strict. `off` detectors are not run. */
export const PII_ACTIONS = ['off', 'redact', 'block'] as const
export type PiiAction = (typeof PII_ACTIONS)[number]

/** Every detector's id, in `piiDetectors.json`'s order (a test holds the two equal). */
export const PII_DETECTOR_IDS = ['pii.card', 'pii.iban', 'pii.ssn', 'pii.email', 'pii.phone'] as const
export type PiiDetectorId = (typeof PII_DETECTOR_IDS)[number]

/**
 * The workspace setting `piiDetectors`: an action for each detector the
 * workspace governs centrally. Both proxies use it as the baseline for the
 * workspace's traffic, and a machine's own config may only tighten it
 * ({@link effectivePiiActions}). A detector left out keeps each machine's
 * action. Unknown ids and actions are refused.
 */
export const PiiDetectorSettingsSchema = z.record(z.enum(PII_DETECTOR_IDS), z.enum(PII_ACTIONS))
export type PiiDetectorSettings = Partial<Record<PiiDetectorId, PiiAction>>

/**
 * The `piiDetectors` field of a control-plane answer, as a proxy reads it.
 * The LLM proxy gets it from `/api/v1/auth/key-context`, the MCP proxy from
 * `/api/v1/sop/rules` or `/api/v1/policy/resolve`; all three send the same
 * value. `unreadable` goes to the proxy's fail mode.
 */
export type WorkspacePiiDetectors =
  | { kind: 'none' }
  | { kind: 'set'; actions: PiiDetectorSettings }
  | { kind: 'unreadable'; reason: string }

const isPiiAction = (v: unknown): v is PiiAction => (PII_ACTIONS as readonly unknown[]).includes(v)
const isPiiDetectorId = (v: string): v is PiiDetectorId => (PII_DETECTOR_IDS as readonly string[]).includes(v)

/**
 * Reads the field. Absent is a control plane older than the setting, and
 * `{}` a workspace that sets none: both `none`. `null` is the control plane
 * saying it could not read the stored setting. An id this build does not
 * know is left out, since a newer control plane can name a detector an older
 * proxy cannot run; an action that does not exist makes the whole field
 * unreadable. The Rust proxy reads it the same way (`dlp/workspace.rs`), and
 * `fixtures/pii-precedence-vectors.json` holds the two together.
 */
export function parseWorkspacePiiDetectors(field: unknown): WorkspacePiiDetectors {
  if (field === undefined) return { kind: 'none' }
  if (field === null) return { kind: 'unreadable', reason: "the control plane could not read the workspace's PII detector actions" }
  if (typeof field !== 'object' || Array.isArray(field)) {
    return { kind: 'unreadable', reason: `the workspace's PII detector actions are not an object: ${JSON.stringify(field)}` }
  }
  const actions: PiiDetectorSettings = {}
  for (const [id, action] of Object.entries(field)) {
    if (!isPiiDetectorId(id)) continue
    if (!isPiiAction(action)) {
      return {
        kind: 'unreadable',
        reason: `the workspace's piiDetectors setting sets '${id}' to ${JSON.stringify(action)}; only 'off', 'redact' and 'block' exist`,
      }
    }
    actions[id] = action
  }
  return Object.keys(actions).length > 0 ? { kind: 'set', actions } : { kind: 'none' }
}

/**
 * Every detector's action for a workspace's traffic on one machine.
 *
 * The workspace setting is the baseline for each detector it names, and the
 * machine's own config (`local`, only the detectors it names) may tighten it
 * (`off` → `redact` → `block`) but never loosen it, so a developer cannot
 * switch off on their machine what the workspace turned on. A detector the
 * workspace leaves out keeps the machine's action, else its default; with no
 * workspace setting the machine's config applies alone. The Rust proxy's
 * `effective_pii_actions` (`dlp.rs`) is the same rule, and both run
 * `fixtures/pii-precedence-vectors.json`.
 */
export function effectivePiiActions(
  local: PiiDetectorSettings,
  workspace: PiiDetectorSettings | null,
): Record<PiiDetectorId, PiiAction> {
  const rank = (a: PiiAction): number => PII_ACTIONS.indexOf(a)
  const table = Object.fromEntries(PII_DEFINITION.detectors.map((d) => [d.id, d.default_action])) as Record<
    PiiDetectorId,
    PiiAction
  >
  Object.assign(table, local)
  for (const [id, baseline] of Object.entries(workspace ?? {}) as Array<[PiiDetectorId, PiiAction]>) {
    const mine = local[id]
    table[id] = mine !== undefined && rank(mine) > rank(baseline) ? mine : baseline
  }
  return table
}

export interface PiiDetectorDefinition {
  /** Stable finding id, `pii.*`. */
  id: string
  category: string
  description: string
  /** Rust regex ∩ JavaScript RegExp: ASCII classes, no `\b`, no lookaround. */
  regex: string
  /** `numeric` adds the decimal/serial rule on top of the word boundary. */
  boundary: 'word' | 'numeric'
  validator: 'card_luhn' | 'iban_mod97' | 'ssn_ranges' | 'email_shape' | 'phone_digits'
  default_action: PiiAction
}

export interface PiiDefinition {
  version: number
  detectors: PiiDetectorDefinition[]
  /** Inclusive `[low, high]` IIN ranges, both bounds the same number of digits. */
  card_brands: Array<{ brand: string; prefixes: Array<[string, string]>; lengths: number[] }>
  /** IBAN length by ISO 3166 country code, from the SWIFT IBAN registry. */
  iban_lengths: Record<string, number>
}

/**
 * JSON imports type their strings as `string`, not the unions above, hence
 * the cast through `unknown`. The MCP proxy refuses to load an unknown
 * validator name, and the conformance vectors pin the rest.
 */
export const PII_DEFINITION = definition as unknown as PiiDefinition
