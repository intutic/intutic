# Upgrading to 3.0 <Badge type="tip" text="Open-Core" />

3.0 adds [decide rules](/guide/decide): narrow questions a self-hosted model answers about a tool call. A workspace with no `decide:` line in its SOPs behaves as it did on 2.9, and its policy snapshot is byte for byte what 2.9 wrote. The changes below apply once a SOP carries one.

---

## Gates older than 3.0 refuse what an enforcing rule covers {#fallback-refusals}

A gate that cannot evaluate a decide rule must not let through the calls the rule was written to stop. So for every rule stamped `enforce`, the policy snapshot carries a **fallback line**: an ordinary block rule on the rule's tools, with an id starting `decide-fallback:` and the reason

```
Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule
```

- **A 2.x gate** (hook gates written before gate body v22, and `@intutic/gate` or `intutic-clawde` before 3.0) skips the snapshot's new `@format` and `@decide` lines, as it skips any line it does not know, and enforces the fallback line. Every call to the rule's tools is refused, with the refusal code `SNAPSHOT`.
- **A 3.0 gate** decodes the rule's `@decide` record, checks it against its hash, and skips the fallback line only when the record is intact. A damaged record leaves the fallback line in force, so the call is refused.
- **A rule running as shadow** has no fallback line, so a 2.x gate allows those calls as before.
- **A `decide:` line that does not read** gets a fallback line whatever its rollout, and it refuses its tools (every tool, when it names none that can be read) on every gate, 2.x and 3.0 alike, until it is fixed. In a workspace whose intervention mode is silent logging, that line logs instead of refusing.

A rule is stamped `enforce` only once its `rollout` is `enforce` and a passing `intutic decide eval` has pinned a model for it, so nothing is refused this way on the day you upgrade. When it is, update the gates on each machine that runs the rule: `intutic gates install` rewrites them on a machine with no login, and a connected machine's sync daemon rewrites them on its next sync. Upgrade `@intutic/gate` and `intutic-clawde` to 3.0 in agents that use the gate SDKs.

A 3.0 gate that reads a snapshot format newer than it knows reports `snapshot_format_newer` and enforces what it can read.

---

## A rule's rollout is `rollout`, never `mode` {#rollout}

A decide rule carries its own rollout, `"rollout": "shadow"` (the default) or `"rollout": "enforce"`, inside its JSON:

```yaml
decide: {"id":"prod-data-export","on":"tool_call","tools":["Bash"],"questions":{"exports":{"type":"yes_no","ask":"Does this command copy customer data out of the production database?"}},"when":"exports","rollout":"shadow"}
```

- **There is no `mode` field.** A rule is read strictly, so `"mode": "shadow"` inside the JSON is an unknown field: the line does not read (`decide: unknown field mode`) and refuses its tools.
- **A SOP's own `mode: shadow` does not reach its decide rules.** It governs the SOP's other keys. A decide rule runs as shadow because its own `rollout` says so, or for one of the reasons in [When a rule enforces](/guide/decide#when-a-rule-enforces).
- **`"rollout": "enforce"` is a ceiling, not a switch.** The rule enforces only on a model a pre-registered `intutic decide eval` has pinned, and runs as shadow everywhere else.

---

## New refusal codes {#refusal-codes}

The hook gates and the gate SDKs refuse with three codes that 2.x gates never used. The hook gates that answer in JSON carry them as `code` beside `ruleId`, which is `decide.<ruleRef>`, for example `decide.local:data.md#prod-data-export`. The other hook gates print them on stderr with the rule id in brackets.

| Code | Meaning |
| :--- | :--- |
| `DECIDE_REFUSED` | The rule asked its questions and the answers made its `when` true |
| `DECIDE_ESCALATED` | The answers left `when` unknown and the harness cannot ask a person, or the rule's `escalate` is `refuse` |
| `GOVERNANCE_UNAVAILABLE` | An enforcing rule could not be evaluated: the engine is not configured, its host is not self-hosted, it errored or was asked and did not answer in time, it returned no usable probabilities or failed its known-answer canary; or more than four enforcing rules name the tool. A rule the stored p95 says cannot fit the time left is not asked, and escalates (`DECIDE_ESCALATED`) instead |

The gate SDKs throw `IntuticGateEscalation`, a subclass of `IntuticGateRefusal`, for `DECIDE_ESCALATED`. Code that catches `IntuticGateRefusal` keeps refusing; code that knows the subclass can ask its user instead. `GOVERNANCE_UNAVAILABLE` was already a code of the proxy and the SDK clients; it is new on the gates.

[Decide escalation by harness](/integrations/decide-escalation) says where an escalation asks rather than refuses.

---

## What 3.0 reads but does not enforce {#not-enforced}

- **`on: response` rules are not enforced in 3.0.** They are read and validated, and nothing evaluates them: the gates see tool calls, and the gateway evaluates no `decide:` line. The only decide rule the gateway runs is the `local-judge` rule it builds from the deprecated variables below. The gateway logs each SOP's response rules when it loads them, and `intutic decide lint`, `intutic gates install` and `intutic doctor` name each one. A `decide:` line that does not read refuses its tools at every gate; the gateway only logs it.
- **`context: ["last_user_turn"]` is reserved.** A rule may declare it, and the rule's hash includes it, but no gate supplies the user's last turn, so the rule is asked without it. `intutic decide test` and `intutic decide eval` ask without it too, even when the file has a `lastUserTurn`, so an eval measures what a gate will ask. `intutic decide lint` and `intutic gates install` warn about each rule that declares it.

---

## The local judge's environment variables are deprecated {#local-judge-variables}

The shared gateway's local judge is configured by seven environment variables. They still work in 3.0: the gateway maps them to a decide rule, `local-judge`, and logs a deprecation warning once. 4.0 removes them.

| Variable | In 3.0 |
| :--- | :--- |
| `INTUTIC_GATEWAY_LOCAL_JUDGE` | Still turns the local judge on |
| `LITELLM_LOCAL_URL` | The model server the rule's questions are asked of (default `http://litellm:4000`). Its host is allowed as self-hosted because you named it; a hosted decision API is refused |
| `LITELLM_LOCAL_API_KEY` | The bearer key sent to that server |
| `LITELLM_LOCAL_TYPED_JUDGE_MODEL` | The model the rule's two questions are asked of |
| `LITELLM_LOCAL_JUDGE_MODEL` | The free-text judge's model, and the questions' model when `LITELLM_LOCAL_TYPED_JUDGE_MODEL` is not set |
| `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`, `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI` | The rule's band: `{no_below: σ(LO), yes_at: σ(HI)}` |

With both band variables set, `local-judge` asks two yes/no questions about the response, `a` ("Does the ASSISTANT RESPONSE violate any of the ACTIVE SOP CONSTRAINTS?") and `r1` (whether the agent actually took, instructed or produced something that breaks a constraint), and scores them with the combiner `{bias: 0, weights: {a: 0.5, r1: 0.5}}`: σ(½·logit(p_a) + ½·logit(p_r1)), the mean log-odds the typed judge scored with in 2.x. Its outcomes map back to the judge's verdicts:

| Rule outcome | Verdict |
| :--- | :--- |
| refuse (score at or above `HI`) | `VIOLATION`; the free-text judge only writes the note |
| allow (score below `LO`) | `COMPLIANT` |
| escalate (between them) | `AMBIGUOUS` |

Two things differ from 2.x. A score of exactly `HI` is now a violation, because a decide answer is yes at `p ≥ yes_at`. And inside the band the free-text verdict no longer decides: the response is `AMBIGUOUS`. `HI` must be above 0, since σ(0) is 0.5 and a decide band's `yes_at` must be above 0.5; a band that cannot be mapped logs one error, and the free-text judge decides as it does without a band.

Without the band variables there is no equivalent decide rule. The free-text verdict keeps deciding, with its own deprecation warning, until 4.0.

<!-- ENTERPRISE_ONLY_START -->
`intutic judge configure` now also writes the decide engine's configuration, `~/.intutic/decide/engine.json`, and prints the deprecated variables with a warning. See [On-Prem Judge Setup](/external/on-prem-judge#typed-stage-the-local-judge-decide-rule) for the walkthrough.
<!-- ENTERPRISE_ONLY_END -->

---

## Related

- [Decide rules](/guide/decide)
- [SOP front matter: decide rules](/reference/sop-front-matter#decide-rules)
- [Refusal codes in a JSON decision](/reference/harness-security-matrix#hook-refusal-codes)
