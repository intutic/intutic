/**
 * This node’s parent is gone.
 *
 * Work nobody is waiting for is the usual shape of a runaway fan-out that keeps spending. Note the tri-state: -1 means unknown, and unknown is NOT dead — treating it as dead blocks every single-agent session, since a root node has no parent to be alive.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/orphaned-node/rule.ts --out build/orphaned-node.wasm
 *     intutic policy test --wasm build/orphaned-node.wasm --mock rules/orphaned-node/block.json
 *     intutic policy test --wasm build/orphaned-node.wasm --mock rules/orphaned-node/allow.json
 *     intutic policy install --wasm build/orphaned-node.wasm --name orphaned-node
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
  if (ctx.parent_alive == 0 && ctx.depth > 0) return 1;
  return 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
