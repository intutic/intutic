# SOP Front Matter <Badge type="tip" text="Open-Core" />

Everything the proxy can act on, declared in the YAML block at the top of a SOP
file. No toolchain, no compile step — the rules stay readable in review, which a
`.wasm` binary does not.

The proxy reads SOPs from disk. See [Agent Guidelines](/guide/sops) for where it
looks and what `INTUTIC_SOPS_DIR` is for.

## The keys

Nine keys can block, steer or hold a run. Everything else in a SOP is prose,
injected into the agent's context and advisory by construction — the model may
ignore it.

| Key | Shape | What it does |
| :--- | :--- | :--- |
| `deny_tools:` | `Bash, WebFetch` | Blocks the tool outright (403). |
| `allow_harnesses:` | `claude-code, cursor` | Restricts which harnesses a role may use. |
| `plan_steps:` | `Read, Edit, Bash, action:run_tests` | Work drifting outside the declared steps is steered. |
| `scope_paths:` | `src, docs` | File access outside these paths is steered. |
| `review_before:` | `action:deploy` | Holds the run for human approval. |
| `requires_before:` | `A -> B` | B is refused unless A appeared earlier. |
| `forbid_after:` | `A -> B` | B is refused if A appeared earlier. |
| `max_calls:` | `A <= N` | Refuses the N+1th call of A. |
| `forbid_with:` | `taint(), token` | Refuses the two together in one request. |

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
