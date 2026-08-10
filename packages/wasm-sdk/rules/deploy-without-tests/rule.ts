/**
 * A deploy ran with no test run anywhere earlier in the session.
 *
 * Order matters here too: `action:run_tests` must appear *before*
 * `action:deploy` in `tool_sequence`, not merely somewhere in the session — a
 * test run that happens after the deploy proves nothing about the code that
 * shipped.
 *
 * Traces to `packages/proxy/tests/corpus_support/mod.rs`'s `deploy_without_tests`
 * mutator: `git push origin main` with no prior test run, run through the real
 * classifier so `action:deploy` below is what production actually emits for
 * that command. The proxy already blocks this natively
 * (`MissingPredecessorDetector`, same rule: `action:deploy` requires
 * `action:run_tests` before it) — this rule exists as a worked example of a
 * WASM rule reproducing a real, corpus-backed attack class, not as an
 * enforcement gap the native detector leaves open.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/deploy-without-tests/rule.ts --out build/deploy-without-tests.wasm
 *     intutic policy test --wasm build/deploy-without-tests.wasm --mock rules/deploy-without-tests/block.json
 *     intutic policy test --wasm build/deploy-without-tests.wasm --mock rules/deploy-without-tests/allow.json
 *     intutic policy install --wasm build/deploy-without-tests.wasm --name deploy-without-tests
 *
 * `block.json` and `allow.json` beside this file are the two contexts the rule
 * is asserted against in CI. Here `block.json` is the sharper of the two:
 * `[deploy, run_tests]`, a test run that happens *after* the deploy it should
 * have gated. A rule that only checked whether both tokens were present
 * anywhere in the sequence — order-blind — would allow this, and it is exactly
 * the case where "we ran the tests" is true and worthless. `allow.json` is the
 * same two tokens in the order that actually clears the gate.
 *
 * Verdict codes: 0 allow, 1 block, 3 reask. 2 is deprecated — the proxy maps
 * it to a block, so a rule returning it believing it redacts gets a block.
 */
import { RequestContext, readContext } from "../../assembly/index";

export { allocate } from "../../assembly/index";

export function rule(ctx: RequestContext): i32 {
  let sawTests = false;
  for (let i = 0; i < ctx.tool_sequence.length; i++) {
    const t = ctx.tool_sequence[i];
    if (t == "action:run_tests") sawTests = true;
    else if (t == "action:deploy" && !sawTests) return 1;
  }
  return 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
