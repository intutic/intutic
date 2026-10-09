/**
 * Which gate an event came from, for the one harness that installs two.
 *
 * A harness is one `HarnessType`: one integration that `intutic connect` sets
 * up, and the unit the harness count counts. Its gate reports under the same
 * id, in hook events (`harnessType`), agent reports, the AI inventory and the
 * SIEM export. `antigravity` is the exception: the integration installs
 * Google Antigravity's `PreToolUse` gate and Gemini CLI's `BeforeTool` gate,
 * for two products a machine may have together or apart. Each reports under
 * its own gate id, `antigravity` and `gemini-cli`, so the silent-gate check
 * expects only the gate of the product that is there, and the inventory and
 * SIEM say which product a call came through. The harness, its rules file and
 * its count stay one.
 *
 * @module
 */

/** The gate id Gemini CLI's gate reports under. */
export const GEMINI_CLI_GATE_ID = 'gemini-cli'

/** The gate ids a harness's gates report under: its own id, or two for `antigravity`. */
export function gateIdentitiesOf(harness: string): readonly string[] {
  return harness === 'antigravity' ? ['antigravity', GEMINI_CLI_GATE_ID] : [harness]
}

/** The harness a gate id belongs to. */
export function harnessOfGate(gateId: string): string {
  return gateId === GEMINI_CLI_GATE_ID ? 'antigravity' : gateId
}
