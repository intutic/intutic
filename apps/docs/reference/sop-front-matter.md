# SOP Front Matter <Badge type="tip" text="Open-Core" />

Everything the proxy can act on, declared in the YAML block at the top of a SOP
file. No toolchain, no compile step — the rules stay readable in review, which a
`.wasm` binary does not.

The proxy reads SOPs from disk. See [Agent Guidelines](/guide/sops) for where it
looks and what `INTUTIC_SOPS_DIR` is for.

## The keys

Ten keys can block, steer or hold a run. Everything else in a SOP is prose,
injected into the agent's context and advisory by construction — the model may
ignore it.

| Key | Shape | What it does |
| :--- | :--- | :--- |
| `deny_tools:` | `Bash, WebFetch` | Blocks the tool outright (403). |
| `allow_harnesses:` | `claude-code, cursor` | Restricts which harnesses a role may use. |
| `plan_steps:` | `Read, Edit, Bash, action:run_tests` | Work drifting outside the declared steps is steered. |
| `scope_paths:` | `src, docs` | File access outside these paths is steered. |
| `review_before:` | `action:deploy` | Holds the run for human approval — at every hook gate before the call runs, and at the proxy after it. |
| `requires_before:` | `A -> B` | B is refused unless A appeared earlier. |
| `forbid_after:` | `A -> B` | B is refused if A appeared earlier. |
| `max_calls:` | `A <= N` | Refuses the N+1th call of A. |
| `forbid_with:` | `taint(), token` | Refuses the two together in one request. |
| `sql_guard:` | `refuse` or `warn`, with `sql_allow_dsns:` | Refuses (or logs) destructive SQL in a shell call aimed at a database not on the allowlist. See [Destructive SQL](#destructive-sql). |

::: warning Two shapes that look right and match nothing

**`plan_steps:` takes tool names, not prose.** The detector lowercases the list
and filters the session's tool sequence for entries that are not in it — and
that sequence holds real tool names (`Read`, `Edit`, `Bash`) and the eight
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

### Informational keys

The parser reads keys by line prefix and ignores every key it does not know,
so a SOP may carry annotations the proxy never acts on. Two are used by
tooling that generates front matter from a cited policy passage:

| Key | Shape | What it is |
| :--- | :--- | :--- |
| `source:` | a URL | Where the rule's text came from — the upstream page. |
| `cite:` | a hex digest | The hash of the exact passage the rule was derived from. |
| `content_hash:` | a hex digest | `intutic sops pull` and `intutic guardrails pull`'s marker: the hash of the body when the file was written, so a later pull can tell an upstream change from a local edit. |

Neither blocks, steers or holds anything. They exist so a rule on disk still
says which sentence it stands on; the enforcing keys above are the only ones
the proxy reads.

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
left side is `secrets()` or `pii()` — the two categories the DLP scanner reports.
`secrets()` covers credentials as well as keys, so a database URL with a password
in it counts.

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

## What happens to a malformed rule

It is reported at load with the file named, and **the valid rules beside it still
load**. A SOP whose entire content is rules — no prose body — loads normally.

If a SOP declares nothing enforceable, the proxy says so at startup, naming every
control that is consequently inactive. That warning exists to catch a
one-character typo (`review_befor:`) that parses clean and enforces nothing, so
it is worth reading rather than silencing.
