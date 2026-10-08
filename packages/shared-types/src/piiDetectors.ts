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
import definition from './piiDetectors.json'

/** What a detector does with a match. `off` detectors are not run. */
export type PiiAction = 'off' | 'redact' | 'block'

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
