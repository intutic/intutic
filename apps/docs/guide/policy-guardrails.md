# Policy Guardrails <Badge type="warning" text="Self-serve+" />

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

## Four targets, four enforcers

| The clause says | Target | Who enforces it | How it gets there |
| :--- | :--- | :--- | :--- |
| "never run *this* with *that* in the arguments" | `hook_rule` | the PreToolUse gate scripts in every connected harness, offline | the daemon's policy snapshot, refreshed every 30 s |
| ordering, counts, denied tools, taint: `requires_before`, `forbid_after`, `max_calls`, `forbid_with`, `deny_tools`, `review_before` | `sop_front_matter` | the proxy's SOP detectors | the workspace SOP policy a gateway-mode proxy fetches; `intutic guardrails pull` for a proxy that reads SOPs from disk |
| a context condition — which harness, role or environment may act, as a `wasm_predicate` clause | `wasm_rule` | a compiled WASM rule in the proxy | the rule-candidate pipeline: compiled from its source of record, gated, shadowed, promoted |
| which models agents may use (`allowed_models`), or which hosts they may also reach (`egress_allow`) | `workspace_setting` | the proxy's approved-models check and its egress policy, through the workspace settings `allowedModels` and `egressAllow` | a promotion writes the setting, recorded as a settings change by the promoting member; retiring the guardrail undoes its own write |

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
compiled rule, a workspace setting — is enforced by the same rung-1 machinery
as a hand-authored one and is indistinguishable from it.

### Settings: allowed models and egress

A settings-class guardrail proposes values for one workspace setting, and the
card shows them beside the setting as it stands.

- **Allowed models has a shadow.** Every request through the proxy is one
  evaluation; a request whose model is outside the proposed list (narrowed by
  the workspace's current list, if it has one) is a would-act, filed as a
  shadowed finding with the request's trace id. Replay and the extraction
  prompt read the same proxied requests — calls recorded by the OpenAI
  Agents trace sink never went through the proxy and are not counted. It is
  promoted under the same rule as any other guardrail, plus two refusals that
  would otherwise lock the workspace out: the result is never empty, and no
  live API key with its own model list is left with none of its models (the
  refusal names the key by prefix). Zero would-acts over the 200 evaluations
  is evidence that every request used a listed model, so it needs no
  acknowledgement. Model ids are compared exactly, as the proxy compares
  them. Promotion can only narrow the setting, and the setting, its
  settings-change record and the promotion event are written together or not
  at all. Retiring the guardrail puts back what was there before — but only
  if the setting is still exactly what the guardrail wrote; a later change by
  a person is left alone. Allowed-models guardrails unwind last in, first
  out: while a newer one enforces, retiring or rejecting an older one is
  refused and names the newer one to retire first.
- **Egress has no shadow.** Would-deny decisions stay in the proxy's local
  log, so nothing can measure an egress allow list and replay says so. It is
  applied straight from proposed, by an owner or admin, with the same
  acknowledgement a never-fired rule needs, and that caveat is recorded. It
  only adds entries to `egressAllow` and never changes the egress mode;
  entries take effect only while the mode is monitor or enforce. Retiring it
  removes only the entries it brought in, and never one that another
  enforcing egress guardrail still names — that entry stays until the last
  guardrail naming it is retired.

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

## Authoring guardrails directly

Not every rule has a sentence behind it. An owner or admin can write a
guardrail directly, as code, in the same closed grammar a model is held to.
An authored guardrail is a first-class guardrail: it is projected into the
same enforcer as an extracted one, moves through the same review, and carries
an **Authored** chip on the Review tab.

**The same IR, the same checks.** The rule is a Guardrail IR object, the
`kind` and its fields (`tools`, `argContains`, `first` and `then`, `limit`,
`models`, `hosts` and so on), exactly as extraction produces it. The server
runs the validator an extracted clause passes: the grammar, whether the tools
are ones a harness in the workspace has called (or known harness tools, before
anything has been observed), the render round trip, the catch-all and
portability checks on a hook rule, the reserved-phrase check on the block
message, and the credential check over everything that ships. Only the four
checks that compare a model's output with a passage it was shown do not run,
because an authored guardrail cites no passage: quote verbatim, tokens in the
passage, roles in the passage and the document's injection flag. An IR one
path refuses, the other refuses with the same check and the same words. The
kind `none` is refused: an authored guardrail must enforce something.

**What stands where the citation stood.** An authored guardrail has a name
(one line, at most 80 characters) and an optional description (at most 480).
The description takes the quote's place: a hook rule's block message is
`<title> — policy: "<description>"`, and a front-matter guardrail is served
titled by its name with the description as its body. Without a description,
the name stands there. A WASM guardrail's rule candidate records the authored
guardrail, not a citation, as its evidence.

**The same lifecycle, with no bypass.** An authored guardrail starts
**proposed**, the state an extracted one starts in: it enforces and measures
nothing until an owner or admin approves it for shadow. Promotion is the same
decision under the same rule: 200 shadow evaluations and the rest of the
promotion rule above, taken by a named member through the review card,
`intutic guardrails promote` or the promote route. Writing a guardrail never
approves or promotes it, whoever writes it, and there is no "promote when
ready" request: a promotion is a member's decision at the moment it takes
effect, and some promotions need an acknowledgement only that member can give
(a rule that never fired, an egress allow list). The one difference is that a
promotion does not check a citation, because there is none to go stale.

**Editing creates a version.** A name or description edit happens in place:
the rule is the same, so its status and evidence stand, and the edit is an
`UPDATED` event on its history. A change to the rule itself creates the next
version under a new id, proposed, with no evidence, and retires the version it
replaces in the same step; if that version was an enforcing allowed-models or
egress guardrail, its setting write is undone as a retirement undoes it.
A WASM version's rule candidate is retired with it, and the new version is
handed a candidate of its own only when it is approved for shadow. Shadow
evidence belongs to the rule that earned it, the way an edited SOP becomes a
new draft. The retired version keeps its evidence and history and
names its successor; the new one names the version it replaced.

**Extracted guardrails are read-only here.** A guardrail extracted from a
document changes when the document changes; the edit and delete routes refuse
it. Its review actions are unchanged.

**Deleting retires.** Deleting an authored guardrail retires it from any state
but retired, undoes what an enforcing settings-class guardrail wrote, and
retires a WASM guardrail's rule candidate. Its
history stays readable.

Four ways in, one API:

- **Dashboard.** **Author a guardrail** on the Review tab takes a name, a
  description and the rule as JSON; choosing a kind loads an example. **Edit**
  on an authored card says before you save when a change creates a new
  version.
- **CLI.** `intutic guardrails create`, `update` and `delete`, from a YAML or
  JSON file or from flags:

  ```yaml
  # guardrail.yaml
  name: Reviewed terraform apply
  description: Production applies need a reviewed plan.
  ir:
    kind: hook_rule
    title: Reviewed plan before terraform apply
    tools: [Bash]
    argContains: [terraform apply]
  ```

  ```bash
  intutic guardrails create --file guardrail.yaml
  intutic guardrails approve-shadow <guardrailId>
  ```

- **Terraform.** [`intutic_guardrail`](/reference/terraform/resources/guardrail)
  manages the rule and reads the lifecycle; see
  [Manage Intutic with Terraform](/guide/terraform#how-the-provider-behaves).
- **API.** `POST /api/v1/policy-guardrails/guardrails` with `name`,
  `description` and `ir`; `PUT` and `DELETE` on
  `/api/v1/policy-guardrails/guardrails/:guardrailId`; and
  `POST /api/v1/policy-guardrails/guardrails/validate`, which runs the checks
  without writing anything. A refusal is a 400 that names the check. See the
  [route catalog](/reference/api#route-catalog).

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

## Limits

- **PDF and Word documents are not ingested.** Export them to Markdown, or put
  them in a Google Drive folder and let Drive convert them. **Test connection** (an owner or admin) exchanges the stored credential and lists one document in the folder, so a wrong key or an unshared folder is found before the first sync.
- **Shadow evidence for a front-matter guardrail comes from a proxy that
  reports traces to the control plane** — a gateway-mode proxy, or a
  standalone proxy attached to a workspace. A proxy with no control plane
  enforces a pulled guardrail from disk and produces no evidence.
- **The hook-rule denominator is per call**, counted from the batches the
  gates drain. A machine whose snapshot had not refreshed yet counts as an
  evaluation that did not fire, which biases the would-act rate down by at
  most one 30-second cycle per machine.
- **Extraction fidelity is measured against a recorded golden corpus.** The
  corpus (22 documents, two adversarial) has goldens recorded against a real
  model; a golden is a real extraction, never hand-written, and its review
  status is tracked in the open-core repository's tech-debt record. The
  fidelity test's always-on half checks the corpus and prints how many goldens
  exist; its opt-in live half re-extracts every document and holds it to the
  thresholds (mean F1 at least 0.80, per-document
  recall at least 0.60, citation verbatim at least 0.95, no clause from a
  negative). CI never calls a model.
- **A promotion reaches machines on their own clocks.** The daemon re-reads
  the rule set every 30 seconds; an MCP proxy polls every 60 seconds behind a
  five-minute cache that a transition clears. No push exists.
- **A gateway-mode proxy ignores the disk.** Pulled guardrail files are for a
  proxy that reads `.intutic/sops`; the two planes never merge.
- **DLP rules are not generated.** A sentence about redacting or blocking
  credentials, card numbers or personal data is answered as "no enforceable
  rule". Data-loss patterns live only in the proxy's own configuration file —
  there is no workspace setting to write them to — and a generated regular
  expression would need a ReDoS check nothing here performs.

## From the terminal

`intutic guardrails` is the same ledger without the page: `sources list|add|sync`,
`docs list|show|extract`, `search <token>` (exact tool or action token) and
`search --text <words>` (full-text, stemmed, best match first),
`impact --doc <id>` or `--passage <id>` (what a change reaches, at most five
computed edges out), `duplicates` (overlapping passages with their Jaccard arithmetic, and the
same rule cited twice), `list`, `show`, `create`, `update` and `delete` (authored
guardrails), `approve-shadow`, `promote`, `reject`, `retire`, `reconfirm`,
`replay`, `conflicts`, and `pull`.
See the [CLI reference](/reference/cli).

## Related

- [Agent Guidelines (SOPs)](/guide/sops) — the front-matter keys and where the proxy looks for them
- [Custom Filters](/guide/wasm-rules) — the WASM rule pipeline, including rules from policy documents
- [Enforcement Actions](/concepts/enforcement-actions) — the two rungs and the promotion rule
- [Evidence and Authority Provenance](/concepts/evidence-and-authority-provenance) — why a citation is evidence and an approval is authority
- [SOP Front Matter](/reference/sop-front-matter) — the keys a front-matter guardrail renders to
