/**
 * The request arrived on a harness this role may not use.
 *
 * An EMPTY allowlist means unrestricted, not "permit nothing". Reading it the other way blocks every request in any workspace that never declared allow_harnesses.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/harness-allowlist/rule.ts --out build/harness-allowlist.wasm
 *     intutic policy test --wasm build/harness-allowlist.wasm --mock rules/harness-allowlist/block.json
 *     intutic policy test --wasm build/harness-allowlist.wasm --mock rules/harness-allowlist/allow.json
 *     intutic policy install --wasm build/harness-allowlist.wasm --name harness-allowlist
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
  if (ctx.allowed_harnesses.length == 0) return 0;
  if (ctx.harness.length == 0) return 0;
  for (let i = 0; i < ctx.allowed_harnesses.length; i++) {
    if (ctx.allowed_harnesses[i].toLowerCase() == ctx.harness.toLowerCase()) return 0;
  }
  return 1;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
