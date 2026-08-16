/**
 * The session has made an unusually high number of tool calls in the last
 * 60 seconds — a burst, not merely a long session.
 *
 * Returns REASK, not block: this is a threshold nobody has measured a false-
 * positive rate for, the same reasoning `risk-tier-ceiling` and
 * `injection-then-egress` use. A legitimate agent working through a batch of
 * small, fast calls (a `Glob` sweep, a series of `Read`s) can cross a fixed
 * number honestly; the honest response to a guess is to say so and let the
 * agent slow down or explain, not to end the run on the first trip.
 *
 * `calls_last_60s` exists for exactly this: `tool_sequence`'s cap bounds a
 * fixed *entry count* with no notion of time, so it cannot tell a burst that
 * fills it in ten seconds from one spread over an hour. This field can.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/call-rate-guard/rule.ts --out build/call-rate-guard.wasm
 *     intutic policy test --wasm build/call-rate-guard.wasm --mock rules/call-rate-guard/block.json
 *     intutic policy test --wasm build/call-rate-guard.wasm --mock rules/call-rate-guard/allow.json
 *     intutic policy install --wasm build/call-rate-guard.wasm --name call-rate-guard
 *
 * `block.json` and `allow.json` beside this file are the two contexts the rule
 * is asserted against in CI. The allow mock is the sharper of the two: it is a
 * near-miss, one call under the ceiling, so the test catches an off-by-one
 * rather than proving only that the rule is not constant.
 *
 * Verdict codes: 0 allow, 1 block, 3 reask. 2 is deprecated — the proxy maps
 * it to a block, so a rule returning it believing it redacts gets a block.
 */
import { RequestContext, readContext } from "../../assembly/index";

export { allocate } from "../../assembly/index";

/**
 * Starter ceiling, not a measured one. A workspace adopting this rule should
 * tune it against its own traffic rather than trust this number — it exists
 * to show the shape of a rate-limit rule, not to be a correct default for
 * every agent's call pattern.
 */
const MAX_CALLS_PER_MINUTE: i32 = 30;

export function rule(ctx: RequestContext): i32 {
  return ctx.calls_last_60s >= MAX_CALLS_PER_MINUTE ? 3 : 0; // reask
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
