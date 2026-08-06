/**
 * A tool server changed its contract mid-session.
 *
 * A server that redefines a tool after the agent has planned around it has changed the meaning of every later call. The agent cannot correct for that, so this blocks rather than asks.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/tool-contract-pinned/rule.ts --out build/tool-contract-pinned.wasm
 *     intutic policy test --wasm build/tool-contract-pinned.wasm --mock rules/tool-contract-pinned/block.json
 *     intutic policy test --wasm build/tool-contract-pinned.wasm --mock rules/tool-contract-pinned/allow.json
 *     intutic policy install --wasm build/tool-contract-pinned.wasm --name tool-contract-pinned
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
  return ctx.tool_contract_changed ? 1 : 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
