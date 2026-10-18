/**
 * The patterns a decide log's arguments excerpt is redacted with: the
 * gate's credential-value patterns (`secretPatterns.ts`) and the PII
 * detectors' regexes (`piiDetectors.json`), applied without the detectors'
 * validators, so a stored excerpt loses more than live traffic would, never
 * less. Kept apart from `decideLog.ts`, which the gate SDK copies byte for
 * byte; `fixtures/decide-log-vectors.json` pins the list for the Python port.
 *
 * @module
 */

import { PII_DEFINITION } from './piiDetectors.js'
import { SECRET_VALUE_PATTERNS } from './secretPatterns.js'

export function decideLogRedactionSources(): string[] {
  return [...SECRET_VALUE_PATTERNS.map((p) => p.source), ...PII_DEFINITION.detectors.map((d) => d.regex)]
}
