# SOP Front Matter <Badge type="tip" text="Open-Core" />

Everything the proxy can act on, declared in the front matter: the YAML block
between the `---` lines at the top of a SOP file. No toolchain, no compile step —
the rules stay readable in review, which a `.wasm` binary does not.

```markdown
---
review_before: action:deploy
---
# Deploys

A person approves every deploy.
```

The keys are enforced; the Markdown below the block is guidance the agent reads.

The proxy reads SOPs from disk: `.intutic/sops/*.md`, found by walking up from the
directory it runs in, or the directory `INTUTIC_SOPS_DIR` names (see
[Configuration](/reference/configuration#rules-budgets-and-memory)).

## The keys

Fourteen keys can block, steer or hold a run, and a fifteenth, `decide:`, asks a
self-hosted model about a tool call before the hook gates let it run. Six more
[modifier keys](#modifier-keys) change how some of them act. Everything
else in a SOP is prose, injected into the agent's context and advisory by
construction — the model may ignore it.

| Key | Shape | What it does |
| :--- | :--- | :--- |
| `deny_tools:` | `Bash, WebFetch` | Blocks the tool outright (403). |
| `allow_harnesses:` | `claude-code, cursor` | Restricts which harnesses a role may use. |
| `plan_steps:` | `Read, Edit, Bash, action:run_tests` | Work drifting outside the declared steps is steered. |
| `scope_paths:` | `src, docs` | A file write outside these paths is steered; reads are not checked. |
| `review_before:` | `action:deploy` | Holds the run for human approval — at every hook gate before the call runs, and at the proxy after it. Approval needs a control plane: without one, the gates refuse the call. |
| `requires_before:` | `A -> B` | B is refused unless A appeared earlier. |
| `forbid_after:` | `A -> B` | B is refused if A appeared earlier. |
| `max_calls:` | `A <= N` | Refuses the N+1th call of A. |
| `forbid_with:` | `taint(), token` | Refuses the two together in one request. |
| `sql_guard:` | `refuse` or `warn`, with `sql_allow_dsns:` | Refuses (or logs) destructive SQL in a shell call aimed at a database not on the allowlist. See [Destructive SQL](#destructive-sql). |
| `hook_rule:` | one JSON object per line | Refuses a tool call by tool name and argument literals. See [Hook rules](#hook-rules). |
| `decide:` | one JSON object per line | Narrow questions a self-hosted model answers about a tool call or a response; the hook gates and gate SDKs refuse, allow or ask a person from the answers, and the gateway evaluates both kinds. See [Decide rules](#decide-rules). |
| `closed_lanes:` | `irreversible`, `reversible_wide` | Holds every action in the listed reversibility lanes for human approval, as `review_before:` does. See [Lanes](#lanes). |
| `plan_approval:` | `required` or `strict` | At the hook gates and gate SDKs: refuses calls until the session's plan is approved (`PLAN_NOT_APPROVED`); `strict` also refuses a tool that is not a step of it (`OFF_PLAN`). Not enforced by the gateway. |
| `node_kind:` | `splitter`, `worker`, `code`, `gate` | Limits what a graph node in these roles may do: a `code` node calls no model, a `worker` or `gate` node may not start child agents, a `gate` node may not change files or run shell commands. See [Graph Guardrails](/guide/graph-guardrails). |

::: warning Two shapes that look right and match nothing

**`plan_steps:` takes tool names, not prose.** The detector lowercases the list
and filters the session's tool sequence for entries that are not in it — and
that sequence holds real tool names (`Read`, `Edit`, `Bash`) and the
`action:` tokens, never verbs. A plan of `investigate, patch, test` puts *every*
step off-plan, past the 0.4 deviation tolerance, so the detector steers on every
request. This page documented exactly that example.

**`scope_paths:` takes path prefixes, not globs.** There is no glob expansion.
A scope is matched by equality or by `prefix/`, so `src/**` matches nothing:
`src/main.rs` is neither equal to `src/**` nor prefixed by `src/**/`. Every
write then reads as out of scope. Write `src`, not `src/**`.

Both failures point the same way — the control fires on everything rather than
nothing, which reads as an over-eager product rather than a misconfiguration.
:::

`risk_tier:` is also parsed, but **no proxy detector reads it** — it is passed to
[WASM rules](/guide/wasm-rules), which may act on it. A SOP declaring only
`risk_tier:` will be reported as enforcing nothing, because as far as the proxy's
own detectors are concerned, it is.

### Modifier keys {#modifier-keys}

Each changes how another key acts and declares nothing of its own. Every one is
opt-in: a SOP without it behaves exactly as before.

| Key | Values (default first) | What it does |
| :--- | :--- | :--- |
| `scope_paths_mode:` | `advise`, `enforce` | `enforce` refuses an out-of-scope write instead of steering: the gateway withholds the call before it runs (`OUT_OF_SCOPE`, rule `scope_paths.<SOP title>`) and refuses the request that reports one it missed. |
| `plan_steps_mode:` | `advise`, `enforce` | `enforce` re-asks (409 `policy_reask`) on any call in the current turn that is not a plan step — no tolerance, and only this turn's calls, so the agent can correct itself. Gateway only. |
| `on_reask_exhausted:` | `block`, `pause` | In a loop run, `pause` holds the whole run for review on the third failed correction (403 `LOOP_RUN_PENDING_REVIEW`) instead of refusing one request. After approval the run gets three fresh attempts. |
| `context_isolation:` | `advise`, `enforce` | Sibling workers handed nearly the same brief are steered by default; `enforce` re-asks. See [Graph Guardrails](/guide/graph-guardrails). |
| `open_actions:` | action tokens | Re-opens these tokens in this SOP's own `closed_lanes:`. Never re-opens a lane the workspace closed. |
| `node_kind_allow:` | `model`, `write`, `shell`, `spawn` | Lifts these limits from the kinds `node_kind:` (or the request) declares. |

Keys that can only strengthen a SOP are read at any indentation, and the
strongest value across lines wins. `open_actions:` and `node_kind_allow:` weaken
it, so they are read at the top level only, like `mode:` — an indented
`open_actions:` re-opens nothing. **An unrecognised value enforces**: a typo in
`scope_paths_mode:` reads as `enforce` and `on_reask_exhausted:` as `pause`,
and is reported at load. An unknown entry in a list is dropped and reported.

An older proxy ignores keys it does not know, so a gateway older than the
version that reads a key does not enforce it.

### Informational keys

The parser reads keys by line prefix and ignores every key it does not know,
so a SOP may carry annotations the proxy never acts on. Intutic's own tooling
writes six: the first two come from generating front matter from a cited
policy passage, the last four are the sync record a pull from, or push to, a control plane leaves:

| Key | Shape | What it is |
| :--- | :--- | :--- |
| `source:` | a URL | Where the rule's text came from — the upstream page. |
| `cite:` | a hex digest | The hash of the exact passage the rule was derived from. |
| `content_hash:` | a hex digest | The marker a pull of SOPs or guardrails from a control plane leaves: the hash of the body when the file was written, so a later pull can tell an upstream change from a local edit. |
| `intutic_id:` | a SOP id (`sp_…`) | The control-plane SOP this file was last pulled from or pushed to; a push updates it instead of creating a new one. |
| `intutic_revision:` | an integer | That SOP's edit counter at the last sync, sent as the push's precondition so an edit made on the control plane since is refused, not overwritten. Not the `version:` semver. |
| `intutic_draft:` | a SOP id (`sp_…`) | On the `<name>.approved.md` file a push or pull keeps beside a file that edits a draft: the draft this approved version is waiting on. A push never sends such a file. |

None of them blocks, steers or holds anything. They exist so a rule on disk still
says which sentence it stands on; the enforcing keys above are the only ones
the proxy reads.

One more key from a pull does change what is enforced, in one
direction only. `intutic_enforced: false` marks a pulled copy of a SOP the
control plane does not enforce (any state but `VALIDATED`, or a SOP no longer
active), and the proxy and the sync daemon skip that file entirely. Any other
value, or no key, leaves the file enforced as written. See
[GitOps for SOPs](/guide/gitops-sops#pulled-sops-enforce-what-the-control-plane-enforces).

### `mode: shadow` — prove a SOP before it enforces

```yaml
---
deny_tools: kubectl
mode: shadow
---
```

Every key above enforces by default. Adding `mode: shadow` changes that for
*this SOP only*: its declarations are still evaluated against every request,
but a match is recorded rather than acted on — the request proceeds
unchanged. Nothing else in the file needs to change; the same `deny_tools:`
or `max_calls:` that would block in enforce mode is what gets evaluated in
shadow mode, so the evidence a shadow period produces is exactly the evidence
the SOP would have generated enforcing.

What each request's shadow SOPs would have done is recorded on that request's
trace, per SOP, as `would_act: true` (something matched) or `false` (a
bypass — both are reported, since a would-act rate needs a denominator). This
is the SOP-declaration analogue of [WASM rules](/guide/wasm-rules)' own
`mode: SHADOW` bundle setting: prove a policy against real traffic before it
can block anyone's work, without a second parallel policy language to
maintain.

`mode: enforce` is the explicit spelling of the default, for a file that wants
to say so. Anything else — a missing key, a typo — also reads as `enforce`:
the failure direction that matters here is a typo silently *disabling*
enforcement, not merely going unread, so an unrecognised value never falls
back to shadow.

`mode:` counts only at the top level of the front matter, with no
indentation. An indented `mode: shadow` belongs to some nested block and
leaves the SOP enforcing. The same holds for every key that can only weaken a
SOP: `roles:`, `risk_tier:`, `sql_guard:`, `sql_allow_dsns:` and
`intutic_enforced:`. Keys that add a rule, such as `deny_tools:`, count at any
indentation.

Scoping (`roles:`) still applies to a shadow SOP exactly as it does to an
enforcing one — a shadow policy scoped to `deployer` is evaluated only against
requests reporting that role, same as if it were enforcing.

::: tip Looking for a network/egress key?
There isn't one, deliberately. Network egress is a workspace-wide and
host-level control, not a per-node policy decision — it doesn't fit the
per-SOP, per-role shape everything above uses. See
[Network Egress Control](/guide/policies#network-egress-control) (the
proxy-level allow list) and `intutic enforce` in the
[CLI reference](/reference/cli#intutic-enforce) (the host firewall).
:::

## Ordering rules

```yaml
---
requires_before: action:run_tests -> action:deploy
forbid_after: action:pii_export -> action:db_write
---
```

**Both arrows read left-to-right as sequence order.** `requires_before: A -> B`
is "A must precede B"; `forbid_after: A -> B` is "B must not follow A". A rule
pointed backwards does not error — it silently never matches — so the two keys
deliberately share one reading rather than each having its own.

`~>` is the same idea with a stricter window: the two must be **directly
adjacent**, with nothing between them. Both keys accept both arrows.

```yaml
forbid_after: action:secret_read ~> action:http_post
```

### Built-in floors

Some ordering rules are enforced with no configuration at all:

| Rule | Meaning |
| :--- | :--- |
| `action:deploy` requires `action:run_tests` | No deploy without a test first. |
| `action:publish` requires `action:run_tests` | Same, for publish. |
| `action:release` requires `action:run_tests` | Same, for release. |
| `action:pii_export -> action:db_write` forbidden | Exported PII must not then be written. |
| `action:pii_export -> action:http_post` forbidden | …or sent. |
| `action:secret_read -> action:http_post` forbidden | Read a credential, then send it somewhere. |

Declaring rules under a key **replaces that detector's floor** — so
`forbid_after:` replaces the three forbidden pairs, and `requires_before:`
replaces the three required ones. Each detector reads only its own key, so
declaring one cannot silently disarm the other.

### Qualified prerequisites {#qualified-prerequisites}

```yaml
requires_before: action:run_tests[ok] -> action:deploy
```

`[ok]` asks for more than a test run: **the latest test run in the session
passed**. Anything else leaves the rule unmet, and the gated call is refused
`PREREQUISITE_UNMET`, with a reason that says which case applies:

| Case | Reason |
| :--- | :--- |
| No run | `action:deploy needs a passing action:run_tests first; none ran in this session` |
| Failed | `… the last action:run_tests failed (<why>)` |
| Unreadable | `… the result of the last action:run_tests could not be read; rerun the tests so their summary is visible` |
| Files changed | `… files changed after the last passing action:run_tests; rerun the tests` |
| `~>`, not adjacent | `… action:deploy must come directly after it, and another call came between` |

- **The qualifier is exact:** `[ok]`, on `action:run_tests`, on the left of the
  arrow. Anything else is a rule error, and the rule still refuses rather than
  vanishing.
- **Deciding "ok".** A non-zero exit code or an error result fails. So does a
  runner summary reporting a failure (pytest, jest, vitest, go test,
  `cargo test`, mocha, rspec) or saying no test ran. Exit code 0, or a summary
  with passes and no failures, is ok. Anything else — phpunit or gradle output
  with no exit code, say — is unknown, and unknown is not ok.
- **A file write makes a pass stale**: an edit, write, delete or move, or a
  shell command such as `sed -i`, `git checkout`, `git pull` or `git stash pop`.
  The next deploy needs a new passing run.
- **At the gateway** the result of each test call is paired with its call by
  id and read, and a gated call in the model's response is withheld before it
  runs, on a stream as well. The request that reports a gated call that ran
  anyway is refused, with `error.scope` naming it.
- **`npm test && git push` in one call** is checked before that command's tests
  run, so an earlier passing run is still required.
- An outcome older than a day is ignored.

The built-in floors stay unqualified: a harness whose results cannot be read
would otherwise never deploy.

## Count bounds

```yaml
max_calls: action:deploy <= 1, Bash <= 20
```

Refuses the call that would exceed the ceiling. There is no built-in ceiling and
no default: how many deploys is too many is a question only you can answer, and
an invented number would be a guess presented as a policy.

`max_calls:` **splits on commas** — the line above is two rules.

## Taint co-occurrence

```yaml
forbid_with: secrets(), action:http_post
```

Refuses a request where a secret is present *and* the named token appears. The
left side is `secrets()` or `pii()`, the only two taints.
`secrets()` covers credentials as well as keys, so a database URL with a password
in it counts, and `pii()` covers custom `phi` patterns as well as personal data:
there is no separate `phi()`. A rule naming one is ignored with a warning in the proxy log, and the rest of the SOP still loads.

::: warning This is co-occurrence, not flow
The DLP scan reports that a secret is **present in the request**, with an offset
into the body and no mapping to a position in the tool sequence. So this rule
cannot say "the tool that read the secret later sent it" — it says "these two
things are in the same request", which is what the data supports.

For real source-to-sink ordering, use `forbid_after:` over the `action:` tokens,
where the sequence position is real.
:::

`forbid_with:` **does not split on commas** — the comma separates the two sides
of one rule. Write one rule per line. Two rules on one line used to be swallowed
into the first rule's token, producing a rule that could never fire; that is now
refused at load, but the asymmetry with `max_calls:` directly above is worth
knowing.

## Destructive SQL

```yaml
---
sql_guard: refuse
sql_allow_dsns: postgres://localhost/*, postgres://localhost:*, postgres://scratch-*.internal/*, sqlite:*
---
```

Off unless a SOP covering the node's role declares it. When on, the proxy reads
every call to a shell tool (`Bash`, `shell`, `run_command`, `execute_command`,
`run_shell_command`, `terminal`, …) **in the model's response, before the harness receives it**, and
looks for a SQL client — `psql`, `mysql` / `mariadb`, `sqlite3`, `dropdb` —
about to run `DROP TABLE` / `DATABASE` / `SCHEMA`, `TRUNCATE`, or `DELETE`
with no `WHERE`. It reads the SQL from `-c` / `--command`, `-e` / `--execute`,
sqlite3's trailing argument, a heredoc, a here-string, or an `echo … |` pipe,
and it reads `bash -c "…"` and argv arrays (`["psql", "-c", …]`) as commands.
Comments and string literals are ignored, so `SELECT 'drop table'` is not a
drop, while `DROP/**/TABLE`, keywords split by a tab, a newline or a `--`
comment, and a `\n` that `printf` or `echo -e` expands are.

It then works out **which database** the command targets — a
`postgres://` / `postgresql://` / `mysql://` URI, the `-h` / `-p` / `-d`
(psql) or `-h` / `-P` / `-D` (mysql) flags, a `host=… dbname=…` string,
inline `PGHOST=` / `PGPORT=` / `PGDATABASE=`, or the sqlite file — and matches
it, in a credential-free form, against `sql_allow_dsns:`:

| Command | Target matched |
| :--- | :--- |
| `psql -h db.prod -p 5432 -d app -c "…"` | `postgres://db.prod:5432/app` |
| `psql postgres://<USER>:<PASSWORD>@localhost/app_dev -c "…"` | `postgres://localhost/app_dev` |
| `mysql -h 127.0.0.1 -D shop -e "…"` | `mysql://127.0.0.1/shop` |
| `sqlite3 /tmp/scratch.db "…"` | `sqlite:/tmp/scratch.db` |

A target on the allowlist passes untouched — which is what keeps migrations
against a scratch database working. Anything else is refused: the call is
withheld and the agent is told which statement, which client and which target,
in place of the call. **A target the proxy cannot read off the command is never
on the allowlist**: `psql "$DATABASE_URL"`, `-h $(…)`, no host named at all (the
client would fall back to `PGHOST` or the local socket, neither of which the
proxy can see), or a script that switches connection with `\connect`. Name the
host and database explicitly on the command line.

| Key | Values |
| :--- | :--- |
| `sql_guard:` | `refuse` (withhold the call) or `warn` (forward it and log). An unrecognised value enforces as `refuse` and is reported at load — a typo never switches the guard off. To turn it off, remove the key. |
| `sql_allow_dsns:` | Comma-separated patterns. `*` matches any run of characters (including `/` and `:`), `?` one. Matching ignores case; `postgresql://` is read as `postgres://` and any `user:password@` in a pattern is ignored. Writing `sql_allow_dsns:` without `sql_guard:` turns the rule on at `refuse`. An empty allowlist refuses every destructive statement. |

Write `postgres://localhost/*` **and** `postgres://localhost:*` to admit local
databases on any port: `postgres://localhost*` would also admit
`postgres://localhost.example.com/…`. A pattern containing a comma (a
multi-host URI) cannot be written, because the list splits on commas.

When several SOPs apply, the strictest severity wins and workspace-scope
allowlists are combined. An org-scope SOP's allowlist is a **ceiling**: a target
must match it as well as the workspace list, so a workspace can narrow the org's
allowlist but never widen it. Under `mode: shadow`, a SOP's SQL guard never
withholds anything and its matches are logged by the proxy (they are not part of
the trace's shadow report, which covers the detector-backed keys). Passwords
never appear in what the proxy logs or tells the agent — the target is rendered
without user, password, query string or password flags.

What it does not see: SQL in a file (`psql -f`, `mysql < file.sql`), SQL issued
from a program (`python -c …`), and migration tools (`prisma migrate reset`,
`rails db:drop`) — none of these are SQL-client invocations, and a migration
command passes untouched. The response gate must be on
(`intutic_settings.response_gate.enabled`, the default); with it off, so is this.

## Hook rules

A hook-rule [policy guardrail](/guide/policy-guardrails) reaches the proxy as
one `hook_rule:` line, in the SOP the control plane serves for it (and the file
a guardrails pull writes). The value is one JSON object on one line:

```yaml
---
hook_rule: {"id":"guardrail.pgr_x","tools":["Bash"],"argContains":["kubectl apply"],"argNotContains":["--dry-run"],"reason":"kubectl apply must be a dry run"}
---
```

The rule fires on a call to one of `tools` — the exact name, case included —
whose arguments, serialised as compact JSON, contain every `argContains`
literal and none of the `argNotContains` ones. The response gate withholds the
call before the client sees it and answers with a `TOOL_DENIED` refusal naming
`id`; `mode: shadow` in the same block reports instead. The proxy also refuses a
request whose latest turn reports a call the rule refuses.

A rule scoped to workspace roles carries them, lower case:
`"roles":["developer","em"]`. The proxy applies it only to a request whose
virtual key belongs to a member holding one of those roles, by the role the
control plane's key context names for the key (cached per key for 30 seconds,
and read again on the key's next request once the workspace's policy changes,
which a role change announces). With no control plane or no virtual key the
role is not known, and the rule applies. This is the member's role, not the
agent role a `roles:` line scopes by.

A `hook_rule:` line the proxy cannot read — not JSON, no `tools`, an empty
literal, or a key it does not know — is not ignored: it refuses every tool call
while it is in force, and the load names it. A call whose arguments are not
JSON is refused by a rule that constrains arguments, since whether a literal is
in them cannot be shown. A rule that names only tools decides on the name.

## Decide rules {#decide-rules}

A [decide rule](/guide/decide) is one `decide:` line holding one JSON object,
one rule per line, like `hook_rule:`. It is read at any indentation. The JSON is
never split on commas, and a YAML block under `decide:` is not read: a bare
`decide:` line does not read.

```yaml
---
decide: {"id":"prod-data-export","on":"tool_call","tools":["Bash"],"questions":{"exports":{"type":"yes_no","ask":"Does this command copy customer data out of the production database?"},"dest":{"type":"choice","ask":"Where does the data go?","options":["local_file","cloud_bucket","external_host"]}},"when":"exports AND dest != none_of_these","band":{"yes_at":0.85,"no_below":0.15},"escalate":"ask","rollout":"shadow"}
---
```

| Field | Required | Value |
| :--- | :--- | :--- |
| `id` | yes | A lower-case letter, then up to 47 of `a-z`, `0-9`, `_` or `-`. Unique within the SOP: a second line with the same id does not read |
| `title` | no | 1 to 80 characters, no tab or newline. Default: the SOP's title (its first `# ` heading, else its file name) |
| `on` | yes | `tool_call`, or `response`. A `response` rule is enforced at the gateway, which judges each complete response by it ([Decide rules at the gateway](/guide/decide#at-the-gateway)); the gates see tool calls only |
| `tools` | with `on: tool_call` only | 1 to 8 tool names, each a letter then up to 63 of `A-Z`, `a-z`, `0-9`, `_`, `.`, `:` or `-`. Matched exactly, case included, against the name the harness reports. No wildcards |
| `questions` | yes | 1 to 8 questions, by name: a lower-case letter, then up to 31 of `a-z`, `0-9` or `_`, and not `and`, `or`, `not` or `in` |
| `questions.<q>.type` | yes | `yes_no` or `choice` |
| `questions.<q>.ask` | yes | 8 to 300 characters, no tab or newline, never about approval (below) |
| `questions.<q>.options` | with `choice` only | 2 to 8 distinct option names, written like question names. `none_of_these` is appended when absent and moved last when present |
| `questions.<q>.band` | no | This question's band, as `band`. Default: the rule's |
| `when` | yes | The expression below, at most 256 characters, using every question at least once |
| `band` | no | `{"yes_at": …, "no_below": …}`: `yes_at` above 0.5 and below 1, `no_below` above 0 and below `yes_at`. Default `{"yes_at": 0.85, "no_below": 0.15}` |
| `escalate` | no | What an unknown `when` does: `ask` (default), `review` (asks as `ask` does; a workspace that uploads its decide log also queues the call for a person's ruling) or `refuse` |
| `rollout` | no | `shadow` (default) or `enforce`. The author's ceiling: the rule enforces only once a pre-registered `intutic decide eval` has pinned a model for it |
| `context` | no, `on: tool_call` only | `["last_user_turn"]` or `[]`. Reserved in 3.0: no gate supplies the last user turn, so the rule is asked without it |

Any other field makes the line unreadable, `mode` included: a rule's rollout is
`rollout`. A SOP's own `mode: shadow` runs its decide rules as shadow, whatever
their `rollout` says ([When a rule enforces](/guide/decide#when-a-rule-enforces)).

### `when`

```
expr  := or
or    := and ( "OR" and )*
and   := unary ( "AND" unary )*
unary := "NOT" unary | atom
atom  := "(" expr ")" | name | name "==" option | name "!=" option
       | name "IN" "(" option ( "," option )* ")"
```

- A bare `name` is a `yes_no` question and means "the answer is yes".
- `==`, `!=` and `IN` take a `choice` question and options it has
  (`none_of_these` included). `q != o` is `NOT (q == o)`; `q IN (a, b)` is
  `(q == a) OR (q == b)`.
- Keywords are upper case; names and options are lower case. There are no
  numbers, functions or other operators.

Each answer is yes, no or unknown through its band, and `when` is evaluated in
three-valued logic: true refuses (`DECIDE_REFUSED`), false allows, and unknown
escalates through `escalate`. Every question is asked before `when` is
evaluated.

### What makes a line unreadable

The first failure is the reason, in this order: the JSON's shape (a missing or
unknown field, or a value out of range), then:

| Check | Reason |
| :--- | :--- |
| `tools` with `on: tool_call` only | `decide: tools is required for on: tool_call and not allowed for on: response` |
| `context` with `on: tool_call` only | `decide: context applies to on: tool_call only` |
| 1 to 8 questions | `decide: a rule asks 1 to 8 questions` |
| Each band's `no_below` below its `yes_at` | `decide: <q>: no_below must be below yes_at` |
| `when` parses | `decide: when: <message> at column <n>` |
| `when` names questions and options that exist, with the right types | `decide: when: <q> is not a yes_no question`, `… is not a choice question`, `decide: when: unknown option <o> for <q>` |
| Every question is used in `when` | `decide: question <q> is never used in when` |
| No question asks about approval | `decide: <q> asks about approval; approval comes from the harness ask or the review queue, never from a question` |

The approval check refuses wording that contains a word starting `approv`,
`authoris` or `authoriz`, `consent`, `permit` or `permission`, or the phrase
`sign off` or `signed off` (with a space or a hyphen), in any case.

An unreadable line is kept, not dropped. The policy snapshot turns it into a
block rule on the tools it names, or on every tool when it names none that can
be read, so the calls it would have judged are refused until it is fixed.
`intutic gates install`, `intutic decide lint` and the proxy's load name it with
its file.

### Identity

- **ref:** `<sopId>#<id>`, for example `local:data.md#prod-data-export` for
  `.intutic/sops/data.md`. A refusal names the rule as `decide.<ref>`.
- **rule hash:** the SHA-256 of the rule's canonical form: `on`, `tools`, the
  questions with every band written out and `none_of_these` placed, `when`
  fully parenthesised (`exports AND dest != none_of_these` becomes
  `(exports AND (NOT (dest == none_of_these)))`) and `context`. It leaves out
  `id`, `title`, `escalate` and `rollout`. A pin belongs to one rule hash, so
  changing a word, an option or a band returns the rule to shadow, and changing
  its rollout does not.

## The `action:` vocabulary

Ordering, count and taint rules are usually written over synthesised action
tokens rather than tool names, because the same intent arrives under a different
tool name in every harness. There are exactly eight:

`action:run_tests` · `action:deploy` · `action:publish` · `action:release` ·
`action:secret_read` · `action:pii_export` · `action:http_post` ·
`action:db_write`

A concrete tool name (`Bash`, `WebFetch`) also works, and matching is
case-insensitive.

**A command is not a token.** `git push` names a command, and no harness emits a
tool by that name — such a rule would load, look correct, and never fire. Rules
naming a command are refused at load, with a message pointing here.

## Lanes {#lanes}

Every action token has a reversibility class:

| Class | Tokens |
| :--- | :--- |
| `reversible_contained` | `action:run_tests`, `action:secret_read`, `action:pii_export` |
| `reversible_wide` | `action:deploy`, `action:release`, `action:db_write`, `action:http_post`, `action:migrate`, `action:prod_write` |
| `irreversible` | `action:publish`, `action:destroy`, `action:force_push`, `action:payment` |

```yaml
---
closed_lanes: irreversible
open_actions: action:publish
---
```

`closed_lanes:` holds every token of the listed classes for a person, exactly
as listing them in `review_before:` would. A SOP whose `risk_tier:` is `HIGH` or
`CRITICAL` also closes `reversible_wide` once it closes any lane;
`risk_tier:` alone still closes nothing. `open_actions:` (top level only)
re-opens tokens in this SOP's own lanes. A workspace can close lanes for every
role with its `closedLanes` setting, which no SOP re-opens.
`reversible_contained` never closes.

What the five newer tokens match, in a shell command:

| Token | Matches |
| :--- | :--- |
| `action:migrate` | `prisma migrate deploy`, `prisma db push`, `alembic upgrade` / `downgrade`, `rails db:migrate`, `rake db:migrate`, `manage.py migrate`, `flyway migrate`, `liquibase update`, `knex migrate:latest`, `sequelize db:migrate` |
| `action:prod_write` | `--prod`, `RAILS_ENV=production`, `NODE_ENV=production`, `--context prod`, `--namespace production`, `-n production`, `--environment production`, `--stage prod` |
| `action:destroy` | `terraform destroy`, `kubectl delete`, `helm uninstall`, `helm delete`, `drop table` / `database` / `schema`, `truncate`, `aws s3 rb`, `aws s3 rm`; and a recursive forced `rm` whose target is absolute, under `~`, or contains `..` (`rm -rf build/` is not one) |
| `action:force_push` | `git push` with a whole-word `--force` or `-f` (`--force-with-lease` is not one) |
| `action:payment` | Stripe charge, payment-intent, transfer, payout and refund calls (`api.stripe.com/v1/charges`, `stripe charges create`, …) and PayPal payments |

`drop` and `truncate` are both `action:db_write` and `action:destroy`.

A hold is released by the same approval as any `review_before:` hold. A decide
rule's `allow` never releases one: holds are evaluated before decide rules, and
only a person releases them.

## What happens to a malformed rule

It is reported at load with the file named, and **the valid rules beside it still
load**. A SOP whose entire content is rules — no prose body — loads normally.

If a SOP declares nothing enforceable, the proxy says so at startup, naming every
control that is consequently inactive. That warning exists to catch a
one-character typo (`review_befor:`) that parses clean and enforces nothing, so
it is worth reading rather than silencing.
