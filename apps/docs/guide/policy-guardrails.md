# Policy Guardrails <Badge type="warning" text="Cloud / Team" />

Your policies already exist — in Notion, Confluence, GitHub, Google Docs, or a
file someone wrote last year. Policy Guardrails turns those sentences into
deterministic controls the harness hooks and the proxy enforce, and every
control stands on the exact sentence it came from. A model proposes; parsers,
parity fixtures, replay and counted shadow evidence verify; a person turns it
on.

This page is the map. The mechanics of each enforcer live on their own pages:
[Agent Guidelines](/guide/sops) for the proxy's front-matter keys,
[Custom Filters](/guide/wasm-rules) for WASM rules, and
[Enforcement Actions](/concepts/enforcement-actions) for what a verdict does.

## From a page to a rule

1. **Sources.** A connector (Notion, Confluence, GitHub, Google Docs) or a
   one-off upload (Markdown, plain text or HTML) brings a document in. Every
   document is split into **passages** — paragraphs, list items, table rows,
   code fences — each addressed by the hash of its text. A re-sync re-splits
   and keeps the hashes that did not change.
2. **Clauses.** Extraction presents the passages to a model and accepts
   exactly two things back: a **verbatim quote** of one passage and a clause
   in a **closed grammar** (the Guardrail IR). A quote that is not a
   character-for-character substring of a passage is rejected; a clause with a
   key the grammar does not have is rejected; a tool or literal the passage
   never mentions is rejected. Nothing the model writes becomes a regex.
3. **Guardrails.** A valid clause becomes one proposed guardrail — one control,
   one citation. It enforces nothing and measures nothing until an owner or
   admin approves it for shadow.

The Review tab shows each proposal as the cited passage beside the exact
artifact the enforcer will read: for a hook rule, the very line a developer
will see on stderr when it blocks.

## Three targets, three enforcers

| The clause says | Target | Who enforces it | How it gets there |
| :--- | :--- | :--- | :--- |
| "never run *this* with *that* in the arguments" | `hook_rule` | the PreToolUse gate scripts in every connected harness, offline | the daemon's policy snapshot, refreshed every 30 s |
| ordering, counts, denied tools, taint: `requires_before`, `forbid_after`, `max_calls`, `forbid_with`, `deny_tools`, `review_before` | `sop_front_matter` | the proxy's SOP detectors | the workspace SOP policy a gateway-mode proxy fetches; `intutic guardrails pull` for a proxy that reads SOPs from disk |
| a context condition — which harness, role or environment may act | `wasm_rule` | a compiled WASM rule in the proxy | the rule-candidate pipeline: compiled from its source of record, gated, shadowed, promoted |

Hook rules are rendered from literal tool names and up to four literal
argument fragments — the tool pattern is anchored, the argument pattern is a
lookahead over the serialised input — so the same rule fires identically in
the control plane's matcher, the MCP proxy's matcher and the emitted gate
scripts. A parity fixture file runs every vector through all three.

## Shadow first, then a person

Every generated guardrail is **rung 2**: its derivation was a model, so it
starts in shadow, where it reports what it would have done and changes nothing
the agent experiences. It is promoted by a named owner or admin, and only when
the server says it is ready:

- at least **200** shadow evaluations,
- a would-act rate of at most **5 %**,
- and, of the calls it would have acted on, at least **min(10, fires)**
  adjudicated as true positives on the Findings page with a false-positive
  rate of at most **1 %** — over the adjudicated fires, never the total.

A rule that never fired in shadow can be promoted only with an explicit
acknowledgement that no observed traffic exercised it, and that caveat is
recorded on the promotion event. WASM guardrails follow the candidate
pipeline's own bar instead: 200 shadow evaluations and at most 1 % would-block.
There is no workspace setting, plan flag or feature flag that promotes a
guardrail on its own; a test pins that none exists.

Once promoted, the emitted artifact — a gate rule, a front-matter key, a
compiled rule — is enforced by the same rung-1 machinery as a hand-authored
one and is indistinguishable from it.

## The citation travels

A guardrail's citation is the passage hash and the verbatim quote. It goes
where the rule goes:

- a hook rule's block message is `<title> — policy: "<quote>" (<page url>)`,
  so the developer reads the cited sentence at the moment of the block;
- a front-matter guardrail carries `source:` and `cite:` lines the proxy
  ignores and a reviewer can follow;
- a WASM candidate carries the quote as its evidence and in the rendered
  source's header.

When the upstream page changes, the document is re-split. A quote still
verbatim in the successor passage is **re-bound**; one that is not marks the
guardrail **stale** — promotion and re-approval are refused until a person
re-confirms or retires it, and enforcement never changes on its own in either
direction. The product also never writes an edit back to a page while a live
guardrail cites it.

## What this is not

- **Not the agent graph.** [Agents](/guide/agents) shows which agents call
  which; the ledger is documents, passages, clauses and guardrails joined by
  foreign keys, hashes and verified substrings.
- **Not the Context Graph.** That was a federation of harness config files and
  source-code symbols, removed when the product narrowed to circuit-breaker
  scope (`9cfc0200`). Nothing here indexes source code, and there are no
  embeddings, no vector store and no similarity search: where two passages are
  said to overlap, the row carries the intersection and union it was computed
  from.
- **Not the withdrawn Hook SOPs.** Those ran operator scripts in Node's `vm`
  and failed open; see
  [SOP Hook Scripts — withdrawn](/guide/sops#sop-hook-scripts-withdrawn). A
  policy guardrail is data — a rule in a closed grammar — evaluated by the
  gates and detectors that already exist.
- **Not a chat.** There is no "ask the policy" surface. Grounding was borrowed
  from search products only in one sense: every generated rule cites its
  source.

## Honest limits

- **PDF and Word documents are not ingested.** Export them to Markdown, or put
  them in a Google Drive folder and let Drive convert them.
- **Shadow evidence for a front-matter guardrail comes from a proxy that
  reports traces to the control plane** — a gateway-mode proxy, or a
  standalone proxy attached to a workspace. A proxy with no control plane
  enforces a pulled guardrail from disk and produces no evidence.
- **The hook-rule denominator is per call**, counted from the batches the
  gates drain. A machine whose snapshot had not refreshed yet counts as an
  evaluation that did not fire, which biases the would-act rate down by at
  most one 30-second cycle per machine.
- **Extraction fidelity is unmeasured until the golden corpus is recorded.**
  The corpus (22 documents, two adversarial) and the fidelity test ship; the
  test prints how many goldens exist and asserts nothing about quality until a
  person records and reviews them.
- **A gateway-mode proxy ignores the disk.** Pulled guardrail files are for a
  proxy that reads `.intutic/sops`; the two planes never merge.

## From the terminal

`intutic guardrails` is the same ledger without the page: `sources list|add|sync`,
`docs list|show|extract`, `search <token>`, `list`, `show`, `approve-shadow`,
`promote`, `reject`, `retire`, `reconfirm`, `replay`, `conflicts`, and `pull`.
See the [CLI reference](/reference/cli).

## Related

- [Agent Guidelines (SOPs)](/guide/sops) — the front-matter keys and where the proxy looks for them
- [Custom Filters](/guide/wasm-rules) — the WASM rule pipeline, including rules from policy documents
- [Enforcement Actions](/concepts/enforcement-actions) — the two rungs and the promotion rule
- [Evidence and Authority Provenance](/concepts/evidence-and-authority-provenance) — why a citation is evidence and an approval is authority
- [SOP Front Matter](/reference/sop-front-matter) — the keys a front-matter guardrail renders to
