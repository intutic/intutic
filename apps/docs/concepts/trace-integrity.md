# Trace Integrity <Badge type="warning" text="Cloud / Team" />

::: warning Commercial / Team Tier Feature
Root sealing, the integrity endpoints and the signing key all live in the
control plane. The open-core proxy records traces; it does not seal them.
:::


Every execution trace Intutic records is append-only. This page is about the
harder question an auditor actually asks: **how would you know if one changed?**

## What "append-only" is worth on its own

`execution_traces` carries a `BEFORE UPDATE OR DELETE` trigger that raises on any
attempt to modify a recorded trace. That stops accidents and it stops the
application. It does not stop the party who runs the database — a superuser can
drop a trigger, edit a row, and recreate the trigger, and nothing in the product
would notice.

So a control that ends there reduces to *trust the operator*, which is the one
claim an external auditor exists in order not to have to accept.

The sealed roots, their leaves and the mirror ledger all carry the same trigger,
and it buys them exactly the same thing: protection from the application, not
from whoever owns the tables. Everything below is about closing that gap rather
than restating it.

## Merkle roots over enumerated runs

Once a loop run is terminal and has been quiet for fifteen minutes, a sweep seals
it: every trace in the run is reduced to a canonical **leaf preimage**, the
leaves are hashed into a Merkle tree, and the root is stored alongside the exact
list of trace ids it covers.

The important property is that sealing is **reproducible**. Anyone can re-read
the live traces, rebuild the tree, and compare:

```bash
curl -XPOST https://<control-plane>/api/v1/integrity/roots/<rootId>/recompute
```

| Verdict | Meaning |
| :--- | :--- |
| `match` | Every covered trace still hashes to what was sealed. |
| `mismatch` | At least one trace changed after sealing. The response **names the trace ids**. |
| `missing_traces` | A covered trace is gone. Reported separately, because a deletion is a different problem from an edit. |

That re-derivation *is* the verification. It is also why traces are sealed by a
sweep rather than chained together as they arrive: a per-trace chain can only be
trusted, whereas a sweep can be re-run, and a re-run producing a different root is
exactly the alarm the feature exists to raise.

(The roots themselves *are* chained to one another — for a different reason, and
one re-derivation cannot serve. See [below](#what-re-derivation-cannot-see-a-deleted-root).)

### The root covers a set, not a time range

A root names its traces explicitly. With a time-range root, a trace that arrived
a few seconds late would be indistinguishable from tampering — and lateness is
normal, so the alarm would be ignored inside a week.

Naming the set separates two signals that must never be conflated:

- **Coverage** — how many traces are under a root. Benign when it dips; a trace
  that lands after its run was sealed simply stays unrooted.
- **Integrity** — whether the roots that exist still re-derive. Never benign.

The `audit_log_integrity` compliance probe reports both, plus the count of traces
that belong to no run at all, which is the honest measure of ungoverned traffic.

## What the leaf commits to

The leaf is an explicit ordered allowlist of write-once fields — identifiers,
timestamp, models, token counts, costs, compliance and enforcement outcome,
anomaly fields, tool sequence, change manifest. It is a field concatenation,
**not JSON**, so number and unicode formatting cannot creep into the middle of an
integrity guarantee.

Deliberately excluded:

- `savings_usd`, which is a generated column — derived, so it adds nothing.
- `raw_payload_json`, which is NULL when a workspace runs BYOC storage in
  `primary` mode. Its presence depends on a *setting*, so including it would make
  a root fail to reproduce after a configuration change that never touched a
  trace.

`actual_cost_usd` **is** included, and that is safe precisely because corrections
never mutate it: a late provider invoice is recorded in a separate corrections
ledger. The figure in the leaf is the one you were originally shown.

Because the allowlist is explicit, a future migration that adds a column does not
invalidate historical roots. Including a new field is a deliberate act that bumps
`leaf_schema_version`, and roots record the version they were built under.

### Leaf schema version 2 — the length tag

Version 1 wrote each field as `name ␟ presence ␟ payload ␞` and rested on the
claim that the separator bytes cannot appear inside a field. That claim was
wrong. `requested_model` is taken from the client's own request body with no
allowlist, so a client picks arbitrary bytes — including the separators — inside
a field of an integrity preimage. Two different rows could therefore be made to
produce byte-identical v1 preimages, because the v1 byte string does not
determine where one field stops and the next begins.

Version 2 writes `name ␟ presence ␟ byteLength ␟ payload ␞`, where `byteLength`
is the payload's length **in UTF-8 bytes**. A reader takes exactly that many
bytes, so no payload content can be read as structure. The version is also part
of the domain tag, so a v1 preimage and a v2 preimage can never be the same
bytes.

**Roots sealed under v1 still verify.** The v1 encoder is retained verbatim, and
every leaf row records the schema version its hash was produced under, so
re-derivation selects the encoder from the stored version rather than from
whatever the current default happens to be. A root sealed before the bump
re-derives to `match`, and a root sealed after it re-derives under v2. That is
deliberate: the alternative — re-hashing history under a new encoder — would have
reported tampering on every already-sealed root while nothing had touched the
data.

Version 1 is frozen rather than repaired. Its bytes are now evidence, not a
format to improve.

## Proving one trace without disclosing the rest

A root is a single hash over many traces. To settle a dispute about one request
you do not need the others:

```bash
curl https://<control-plane>/api/v1/integrity/roots/<rootId>/proof/<traceId>
```

The response returns the sibling hashes along the path and which side each sits
on. A holder can reconstruct the root from the one leaf they care about, learning
nothing about the other traces in the run.

The tree uses RFC 6962 domain separation (leaves and interior nodes are hashed
under different prefixes) and promotes unpaired nodes rather than duplicating
them — the two constructions whose absence causes distinct trace sets to produce
identical roots.

The endpoint returns `verified` and answers **409** when the stored leaves no
longer rebuild the stored root. A proof that does not reconstruct is not a usable
proof, so it does not leave with a success status — unlike `/recompute`, where a
mismatch is the answer to the question asked and 200 is correct.

## What re-derivation cannot see: a deleted root

Re-derivation compares a root against its traces. It has nothing to say about a
root that is no longer there — the survivors all verify perfectly, and deleting a
row is cheaper than editing one for anyone who can drop an append-only trigger.

So each root also names the one before it. `previous_root` is written inside the
sealing transaction, per workspace, ordered by `(sealed_at, root_id)`, and it is
**walked by a verifier**:

```bash
curl https://<control-plane>/api/v1/integrity/chain
```

A root whose named predecessor is not the root that actually precedes it is
reported as a **break**, naming both ends — "the chain is broken" is not
actionable, whereas "root B claims a predecessor that is not root A, which is
what actually precedes it" points straight at the gap. A root that names no
predecessor at all is reported separately as **unchained**: nothing was claimed,
so nothing contradicts, and what it means is only that a deletion at that point
would go unseen. The `audit_log_integrity` probe reports the same walk on every
run.

The oldest root in the window is never checked, because its predecessor is either
absent by definition — it is the workspace's first — or sits outside the window.
Checking it either way would invent a break at the edge of the page, and an alarm
that always fires is an alarm nobody reads.

::: warning The chain is only as long as the walk
The walk covers the most recent 500 roots per workspace. A break older than that
window is outside what this endpoint can see, so a 200 means "no break in the
last 500 roots", not "no break ever".

The status code distinguishes the two states: **409 on a genuine break only**.
An unchained root — what an instance predating the chain writes during a rolling
deploy — answers 200, because nothing was claimed and so nothing is
contradicted. Both facts still travel in the body, in `breaks` and
`unchainedRootIds`.
:::

From the command line, `intutic integrity chain` performs the same walk and exits
non-zero on a break — see the [CLI reference](/reference/cli#intutic-integrity-chain).

## The other chain: harness config snapshots

The same construction guards a different record. Every snapshot of a harness
config file stores a `content_hash` of its body and the `previous_hash` of the
snapshot before it, so the history of what an agent was actually told to do is
itself a chain.

`GET /api/v1/integrity/config-chain` walks it, and it checks **both** halves,
because each catches only what the other misses:

- **The links.** Each snapshot's `previous_hash` against the `content_hash` of
  the snapshot that actually precedes it. This is what catches a **deleted**
  snapshot — the two survivors either side still hash correctly on their own.
- **The bodies.** Every stored `content` re-hashed against its stored
  `content_hash`. This is what catches an **edited** body — the links are
  untouched and stay perfectly consistent, so a link-only walk sees nothing.

A break names both ends, the same way the root chain does. A snapshot whose
`previous_hash` is absent is reported as **unchained** and returns 200: nothing
was claimed, so nothing is contradicted. Breaks and content mismatches return
409.

::: tip One chain per file, not per harness
Snapshots chain within `(workspace, harness type, file path)`, because that is
how a snapshot picks its predecessor when it is written. Walking a harness type
as a single sequence would report a break between every pair of adjacent
captures of *different* files, so any workspace tracking both `CLAUDE.md` and
`AGENTS.md` would never be intact. `?harnessType=` narrows which chains are
walked; it does not merge them.
:::

The table is append-only at the database level as well, so an edit or a delete is
refused rather than merely detected afterwards. As with the root triggers, that
stops accidents and application bugs — it is not a control against whoever owns
the database.

::: warning This chain has no scheduled reader
Nothing runs this walk on a timer, and no dashboard page shows it. It is
deliberately **not** folded into the `audit_log_integrity` probe — a linear chain
and a Merkle tree are different claims, and averaging them into one score is how
that probe became misleading once already. Until it has a scheduled caller, the
guarantee is "you can check this whenever you ask", not "you will be told".
:::

## Signatures, and exactly what they prove

If `TRACE_SIGNING_PRIVATE_KEY` is set to an Ed25519 PKCS#8 PEM, each root is
signed before it is stored, and the public half is published:

```
GET /.well-known/intutic-trace-signing.json
```

That endpoint is unauthenticated on purpose. An auditor who must hold your
credentials to obtain the verifying key is not an external auditor.

The signature covers a domain-separated preimage binding the workspace, the loop
run, the leaf schema version, the root, and `previous_root` — never the bare 32
bytes. A signature over an anonymous hash is portable: the same bytes could be
presented against a different run's row and still verify.

Including `previous_root` is what puts the chain walk above under the signature.
Until it was there, the link a deleted root would have to be hidden by was the
one field the signature said nothing about, so anyone able to write the table
could relink the chain and every signature still verified. Now relinking a root —
or setting its predecessor to NULL to claim nothing preceded it — invalidates its
signature.

Roots therefore record which preimage they were signed over, in
`signing_preimage_version`: `1` for roots sealed before this changed, `2` since.
Every verifier selects the reconstruction by that column rather than assuming the
current one, and reports a version it does not recognise as **unverifiable**
rather than as a bad signature. A verifier that guessed would report roots nobody
touched as forged the moment the encoding moved again.

::: warning What a signature does not prove
An Ed25519 signature from the party that also runs the database proves a root
**came from that deployment**. It does not prove the history is true, because the
same party holds the key.

It becomes evidence when the customer holds a copy the operator cannot rewrite.
Configure BYOC storage and each root — with its full leaf list — is written to
your bucket as it is sealed, where a later re-derivation is checked against
*your* copy rather than ours. The compliance probe reports
`externallyVerifiable: false` until that is true, and says so in its remediation
even when it passes.
:::

Symmetric secrets are disqualified for this. With HS256, every party who can
verify can also forge, so "signed by Intutic" would carry no information at all.

::: warning Docker Compose does not pass the key through yet
`docker-compose.enterprise.yml` sets the control-plane environment as an explicit
list and does not include either signing variable, so setting one in `.env` has
no effect on a Compose install and roots are sealed unsigned. The Kubernetes base
passes both. Tracked as TD-246; the two lines that close it are in
`infra/compose/.env.enterprise.example`.
:::

### What "mirrored" is read from

Every mirror **attempt** is appended to a ledger of its own — provider,
destination, outcome, and the provider's error message when it failed — and the
compliance probe reads that ledger. It does not read your workspace settings.

The distinction is the whole point. Settings record that somebody once typed a
bucket name. A workspace whose bucket had been deleted, or whose credentials had
expired, previously reported `externallyVerifiable: true` while every single
write was failing — the loudest-when-wrong shape a compliance signal can take.
The claim is now a count of writes that landed, and it is all-or-nothing across
the sampled roots: nine copies out of ten leaves the tenth held only by us, and
that is the one an auditor asks about. `rootMirrorFailures` and `lastMirrorError`
report the provider's own error alongside it.

::: warning What is proven, and what is not
Until recently the two cloud SDKs were loaded through an indirection that hid
them from dependency resolution, and neither was declared as a dependency — so
in a built image *every* mirror write failed at import time, and no test noticed
because the tests mocked the SDKs. Both are now real declared dependencies, and
the test suite fails if either stops resolving or stops being declared.

What is still unproven is a successful upload. No test writes to a real bucket or
an emulator, so the failure path is covered and the success path is exercised
only against a mock. Treat your first sealed root as the thing that confirms
mirroring works, and read `rootsMirrored` in the probe rather than assuming it.
:::

::: tip A failed mirror is retried on later sweeps
Mirroring is attempted at seal time, and every later sweep makes a bounded pass
over roots that still have no successful mirror. So a root whose write failed —
misconfigured bucket, expired credentials, a network blip — is re-attempted, and
fixing the bucket afterwards does bring it back without re-sealing anything.

Two limits are worth knowing. The pass only considers workspaces that actually
asked for external custody (`settings.byocStorage.provider` other than
`disabled`), because a workspace with no bucket never produces a mirror row and
would otherwise crowd out the roots the pass exists for. And it orders
least-recently-attempted first, so a long backlog rotates rather than starving
the root sealed ten minutes ago whose bucket has since recovered. Read
`mirrorsRetried` in the sweep result and `rootsMirrored` in the probe rather
than assuming either.
:::

### Rotation

`signing_key_id` is the RFC 7638 thumbprint of the key that signed a given root.
A rotated-out key must stay published in the JWKS for as long as roots signed by
it are retained — otherwise those roots become permanently unverifiable.

`TRACE_SIGNING_RETIRED_KEYS` is how you keep them published. To rotate:

1. Generate the new key and set it as `TRACE_SIGNING_PRIVATE_KEY`.
2. Move the outgoing PEM into `TRACE_SIGNING_RETIRED_KEYS`, which holds any
   number of previously-active PEMs. Whole armoured blocks are matched, so
   separating them by newline, by comma, or not at all all work.
3. Restart. Nothing else — no re-signing, no migration.

Only `TRACE_SIGNING_PRIVATE_KEY` ever signs. Retired keys are used for
verification and publication alone: the JWKS serves the active key and every
retired key, each under its own thumbprint, and verification selects the key by
the `signing_key_id` recorded when the root was sealed. Leaving the outgoing key
in both variables during a rollout is safe — the JWKS deduplicates by thumbprint.

Retiring the *last* key is also safe. With `TRACE_SIGNING_PRIVATE_KEY` unset and
retired keys present, new roots are sealed unsigned, but the JWKS still serves
the retired keys and already-sealed roots still verify.

::: tip Three outcomes, not two
A signature the recorded key **rejects** is reported as
`signaturesInvalid` and fails the probe: that is tampering.

A signature whose recorded key is in neither variable is reported separately as
`signaturesUnverifiable`, and it does **not** fail the probe. Nothing is known to
be wrong with that root — we simply no longer hold the key that would settle it,
which is a key-retention gap, not evidence of forgery. The remediation names the
variable to put the key back into. Reporting it as a bad signature would accuse
the operator of rewriting history over their own key management.
:::

## Failure modes worth knowing

- **Signing configured but broken.** The sweep writes no root rather than an
  unsigned one. The ledger is append-only, so a row stored without a signature
  could never acquire one; leaving the run unsealed is the recoverable failure,
  and the next sweep picks it up.
- **Customer bucket unreachable.** The root is still sealed, and the failed
  attempt is recorded in the mirror ledger with the provider's error. An unsealed
  run is verifiable by nobody; an un-mirrored root is at least verifiable by us.
  Later sweeps re-attempt it, so fixing the bucket does bring it back — see the
  tip above for the two limits on which roots those passes consider.
- **No key configured at all.** Fully supported. Roots are still sealed and still
  re-derive; they simply cannot be attributed to your deployment by a third
  party, and the probe says so rather than passing silently.
- **A root is deleted outright.** Re-derivation cannot see this; the chain walk
  can, and reports a break naming the roots on either side of the gap. What
  neither can do is tell you what the missing root said.
- **A covered trace is deleted.** The leaf survives its trace on purpose — there
  is no cascade from `execution_traces` — so the root still states which traces
  it covered and `/recompute` returns `missing_traces` naming them. Had the leaf
  died with the trace, that verdict could never have been reached.

## Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/v1/integrity/roots` | Sealed roots for the workspace, newest first. |
| `GET /api/v1/integrity/roots/:rootId` | One root and the trace ids it covers. |
| `GET /api/v1/integrity/roots/:rootId/proof/:traceId` | Merkle inclusion proof for one trace. **409** if the leaves no longer rebuild the root. |
| `POST /api/v1/integrity/roots/:rootId/recompute` | Re-derive from live rows. Always 200 — the verdict is the answer. |
| `GET /api/v1/integrity/chain` | Walk the `previous_root` chain. **409** on a genuine break only — an unchained root answers 200. |
| `GET /api/v1/integrity/config-chain` | Walk the harness config snapshot chain. Optional `?harnessType=`. **409** on a contradicted claim only — an unchained snapshot answers 200. |
| `GET /api/v1/integrity/traces/:traceId/leaf` | The canonical preimage and leaf hash, recomputed. |
| `GET /.well-known/intutic-trace-signing.json` | Public signing keys (JWKS), active and retired. Unauthenticated. |

The last two exist so you can reproduce our arithmetic on data you already hold,
instead of being asked to trust that the hash we stored is the hash of the row we
showed you.

::: tip The leaf endpoint encodes at the version the trace was sealed with
It takes no version parameter and does not need one: it reads the trace's stored
leaf and re-encodes under **that** leaf's `leaf_schema_version`, so the preimage
and hash it returns match the sealed leaf for a **v1** root as well as a v2 one.
The response labels which version it used.

Only a trace with no sealed leaf at all falls back to the current version, since
there is no sealed encoding to reproduce. To check a whole root at once, use
`POST /api/v1/integrity/roots/:rootId/recompute` — it selects the encoder from
each leaf's stored version and names any affected trace ids.
:::
