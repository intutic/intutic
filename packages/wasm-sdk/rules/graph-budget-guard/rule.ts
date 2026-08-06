/**
 * The agent graph as a whole is over budget.
 *
 * Per-node budgets do not bound a fan-out: ten nodes each under their own ceiling can be far over the graph’s. Unknown arrives as -1, not 0, so an absent budget must be checked before it is compared.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/graph-budget-guard/rule.ts --out build/graph-budget-guard.wasm
 *     intutic policy test --wasm build/graph-budget-guard.wasm --mock rules/graph-budget-guard/block.json
 *     intutic policy test --wasm build/graph-budget-guard.wasm --mock rules/graph-budget-guard/allow.json
 *     intutic policy install --wasm build/graph-budget-guard.wasm --name graph-budget-guard
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
  if (ctx.graph_spend_usd < 0 || ctx.graph_budget_usd < 0) return 0; // unknown
  if (ctx.graph_budget_usd == 0) return 0;                          // unbounded
  return ctx.graph_spend_usd >= ctx.graph_budget_usd ? 1 : 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
