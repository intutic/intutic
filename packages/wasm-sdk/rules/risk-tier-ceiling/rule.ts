/**
 * The SOP governing this request declares a high risk tier.
 *
 * Returns REASK: the tier describes the SOP, not this particular request, so it is a prompt to confirm rather than grounds to refuse. No proxy detector reads risk_tier — it is delivered for exactly this kind of rule.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/risk-tier-ceiling/rule.ts --out build/risk-tier-ceiling.wasm
 *     intutic policy test --wasm build/risk-tier-ceiling.wasm --mock rules/risk-tier-ceiling/block.json
 *     intutic policy test --wasm build/risk-tier-ceiling.wasm --mock rules/risk-tier-ceiling/allow.json
 *     intutic policy install --wasm build/risk-tier-ceiling.wasm --name risk-tier-ceiling
 *
 * `block.json` and `allow.json` beside this file are the two contexts the rule
 * is asserted against in CI. The allow mock is the sharper of the two: it is a
 * near-miss, differing from the block case in as few fields as possible, so the
 * test catches the specific inversion this rule's fields invite rather than
 * proving only that the rule is not constant.
 *
 * Verdict codes: 0 allow, 1 block, 3 reask. 2 is deprecated — the proxy maps
 * it to a block, so a rule returning it believing it redacts gets a block.
 */
import { RequestContext, readContext } from "../../assembly/index";

export { allocate } from "../../assembly/index";

export function rule(ctx: RequestContext): i32 {
  if (ctx.risk_tier != "Critical") return 0;
  for (let i = 0; i < ctx.new_tool_calls.length; i++) {
    if (ctx.new_tool_calls[i] == "action:deploy") return 3; // reask
  }
  return 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
