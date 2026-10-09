/**
 * How much the gate evaluates before it refuses, and for how long a hook
 * script it writes may run. The same values as `@intutic/shared-types`
 * gateLimits.ts, which documents where they come from; a test holds both to
 * the `limits` of `packages/shared-types/fixtures/gate-rule-vectors.json`.
 */

/** The largest shell command, in UTF-8 bytes, the gate evaluates. */
export const COMMAND_SIZE_LIMIT = 256 * 1024

/** The largest tool arguments, in UTF-8 bytes of compact JSON, the gate evaluates. */
export const ARGUMENTS_SIZE_LIMIT = 1024 * 1024

/**
 * The timeout, in seconds, on the Claude Code hook entry the sandbox bootstrap
 * writes (`intuticSandboxBootstrap`); Claude Code runs a call whose hook times out.
 */
export const HOOK_TIMEOUT_SECONDS = 10

/** How far below its harness's hook timeout a gate refuses: interpreter start-up, and the refusal written and read. */
export const GATE_DEADLINE_MARGIN_MS = 1000

/** How long the hook script the sandbox bootstrap writes may run, from process start, before it refuses. */
export const GATE_DEADLINE_MS = HOOK_TIMEOUT_SECONDS * 1000 - GATE_DEADLINE_MARGIN_MS

/**
 * Why a call is too large to evaluate, or null. Counts the command and the
 * compact JSON of the arguments in UTF-8 bytes; arguments that do not
 * serialize are left to the tiers, which handle them already.
 */
export function tooLargeReason(command: string, toolInput: unknown): string | null {
  const commandBytes = Buffer.byteLength(command, 'utf8')
  if (commandBytes > COMMAND_SIZE_LIMIT) {
    return (
      `COMMAND_TOO_LARGE: the command is ${commandBytes} bytes, over the ${COMMAND_SIZE_LIMIT}-byte ` +
      'limit a gate evaluates; split it into smaller commands'
    )
  }
  let json: string | undefined
  try {
    json = JSON.stringify(toolInput ?? {})
  } catch {
    return null
  }
  const argumentBytes = json === undefined ? 0 : Buffer.byteLength(json, 'utf8')
  if (argumentBytes > ARGUMENTS_SIZE_LIMIT) {
    return (
      `COMMAND_TOO_LARGE: the tool arguments are ${argumentBytes} bytes, over the ` +
      `${ARGUMENTS_SIZE_LIMIT}-byte limit a gate evaluates; write the content in smaller parts`
    )
  }
  return null
}
