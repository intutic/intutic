/**
 * Prompt-injection findings on a turn that also reaches the network.
 *
 * Returns REASK, not KILL: injection findings are pattern matches and do produce false positives. It reads new_tool_calls, this turn’s delta — matching on tool_sequence would re-fire the hold on every later turn of the session, forever.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/injection-then-egress/rule.ts --out build/injection-then-egress.wasm
 *     intutic policy test --wasm build/injection-then-egress.wasm --mock rules/injection-then-egress/block.json
 *     intutic policy test --wasm build/injection-then-egress.wasm --mock rules/injection-then-egress/allow.json
 *     intutic policy install --wasm build/injection-then-egress.wasm --name injection-then-egress
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
  if (ctx.injection_findings.length == 0) return 0;
  for (let i = 0; i < ctx.new_tool_calls.length; i++) {
    const t = ctx.new_tool_calls[i];
    if (t == "action:http_post" || t == "action:pii_export") return 3; // reask
  }
  return 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
