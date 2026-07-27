---
title: Graph Guardrails
description: Enforcing invariants across multi-agent graphs — ordering, cycles, budgets, and data flow — from outside the graph.
---

# Graph Guardrails <Badge type="tip" text="Open-Core" />

Agent systems have been drifting from a single loop — plan, act, check, repeat —
toward graphs: parallel branches, handoffs between specialised agents, verifier
nodes, and shared state. The vocabulary settled on "graph engineering" during
2026, though the structure itself is older than the name; workflow engines and
DAG schedulers have drawn these graphs for a decade.

What changed is not the shape. It is that a node now *interprets* its task
instead of following a fixed rule, which is what makes explicit budgets, vetoes
and stop conditions necessary rather than optional.

## The problem a graph creates

The failure mode most often raised about graph systems is that **agents checking
agents produce confident nonsense at scale**. A verifier node is another
probabilistic node. Adding one raises the cost and the fluency of the output; it
does not, on its own, add ground truth.

The conclusion people keep landing on is that some of the evidence has to come
from outside the agent system — tests that actually ran, budgets that actually
ran out, rules that are not themselves prompts.

That is the role Intutic occupies. The proxy is **not a node in the graph**. It
is the network hop every node's traffic crosses, and it decides deterministically
in the hot path, without asking a model.

## What holds across the whole graph

Every request from every node in a session carries the same `session_id`, and
the proxy accumulates the tool calls it has seen against it. Rules therefore see
the graph's history, not just the current node's turn.

### 1. Cycles, stalls and runaway recursion

Detection is on by default. Every request runs through a registry of detectors,
each a pure function of that request — no baselines, no learning, no extra model
call, nothing that could add latency to your agent. Findings are reported against
the shared anomaly taxonomy:

| Detector | Fires on | Category |
|---|---|---|
| Consecutive repeat | 5 identical tool calls in a row | `LOOP_DETECTED` |
| Ping-pong cycle | two tools alternating for 3 full cycles | `LOOP_DETECTED` |
| Runaway recursion | graph depth beyond 7 | `LOOP_DETECTED` |
| Transition plausibility | low-scoring `A -> B` run | `TOOL_ABUSE` |
| Missing predecessor | `deploy` with no earlier `run_tests` | `SCOPE_VIOLATION` |
| Forbidden succession | `db_write` after `pii_export` | `SCOPE_VIOLATION` |
| DLP escalation | 3+ distinct blocked patterns in one request | `DATA_EXFILTRATION` |
| Diversity collapse | last 10 calls used one tool | `TOKEN_WASTE` |
| Context growth | large context after several hops | `TOKEN_WASTE` |
| Budget exhaustion | no headroom left | `BUDGET_BREACH` |

The ping-pong detector exists because a consecutive-repeat check cannot see two
nodes handing work back and forth — no tool ever repeats twice in a row, yet
nothing progresses.

Self-transitions score low deliberately: `run_command -> run_command` sits at
`0.15`, because a node calling the same tool repeatedly is the most common shape
of a graph that has stopped making progress.

All detectors run on every request rather than stopping at the first hit — a
request that trips three checks tells you more than one that trips one — and the
most severe finding determines the verdict.

### 2. One budget for the whole graph

A per-node budget is not a budget: a graph that fans out to eight workers spends
eight times what you capped. The ceiling is set on the session, so every hop,
every sub-agent and every retry draws from it.

```bash
intutic loop exec --name "REFACTOR-42" --budget 5.00 -- claude
```

Rules can also read the remaining headroom directly and tighten as it drains, via
`budget_remaining_usd` on the request context.

### 3. Ordering invariants

Some constraints are only expressible over the sequence — "tests before deploy"
is meaningless to a single node in isolation, because the node that deploys is
usually not the node that tested.

As a local SOP:

```markdown
## Graph Invariants

1. NEVER call `deploy` unless `run_tests` appears earlier in the session.
2. NEVER call `db_write` after `pii_export` in the same session.
3. A node that has produced a `KILL` verdict must not be retried by a sibling.
```

And on the hot path, where it is enforced rather than requested. `tool_sequence`
is the session's tool history, oldest first — the graph's edge list so far:

```typescript
// AssemblyScript — see Custom Filters for the full rule harness.
const seq = ctx.tool_sequence;

// Deploy without a test anywhere earlier in the graph.
if (seq.indexOf("deploy") >= 0 && seq.indexOf("run_tests") < 0) {
  return 1; // BLOCK
}

// PII left the boundary, and now something wants to write.
const exported = seq.indexOf("pii_export");
if (exported >= 0 && seq.indexOf("db_write") > exported) {
  return 1; // BLOCK
}

return 0; // ALLOW
```

Because the rule reads the session rather than the turn, it holds however the
graph reorders itself — which is the point, since the ordering of a graph is not
known in advance.

### 4. Data flow between nodes

DLP runs on the traffic itself, so a secret that one node reads cannot be handed
to another node through the model. Findings arrive in the rule context as
`dlp_findings`, and can be combined with the sequence: *this* tool call is only
a problem because of what an earlier node already exposed.

## What is available to a rule

The full context the proxy serialises for each evaluation. Field names are
snake_case on the wire:

| Field | Type | Use in a graph |
|---|---|---|
| `session_id` | string | One identity spanning every node |
| `tool_sequence` | string[] | Tool history, oldest first — ordering and cycles |
| `tool_calls` | ToolCall[] | What this node is asking for right now |
| `budget_remaining_usd` | float | Headroom left for the whole graph |
| `estimated_input_tokens` | int | Context growth across hops |
| `dlp_findings` | DlpFinding[] | What has already been exposed |
| `risk_tier` | string | Severity banding |
| `model`, `workspace_id`, `virtual_key_prefix` | string | Routing and attribution |
| `node_id`, `agent_role`, `graph_id` | string | Which node, what role, which graph |
| `parent_session_id` | string | Who handed work to this node |
| `depth` | int | Distance from the graph root |

## Node identity

The proxy also knows *which* node is calling, and where it sits.

It reads this from the headers your harness already sends if it has
OpenTelemetry instrumentation — W3C `baggage` carrying the OTel GenAI
attributes, plus `traceparent`:

| Field | Source | Fallback header |
|---|---|---|
| `node_id` | `baggage: gen_ai.agent.id` | `X-Intutic-Node-Id` |
| `agent_role` | `baggage: gen_ai.agent.name` | `X-Intutic-Agent-Role` |
| `graph_id` | `baggage: gen_ai.conversation.id` | `X-Intutic-Graph-Id` |
| `parent_session_id` | `traceparent` parent span | `X-Intutic-Parent-Session` |
| `depth` | `baggage: intutic.graph.depth` | `X-Intutic-Depth` |

Because these are the same attributes your tracing backend records, a governance
verdict lines up with the trace you already have — no correlation layer.

Nothing is required. A harness that sends none of this still works exactly as
before: `node_id` and `graph_id` fall back to the session id, `depth` is `0`, and
every rule in this guide behaves identically. A single-agent session is simply a
graph of one.

Depth enables runaway-recursion detection, which fires past a depth of 7.

::: warning Identity is for observing, not authorising
These values are client-supplied and unverifiable — the W3C Baggage
specification is explicit that baggage must not carry anything requiring
integrity.

Use them to reason about the graph. Never grant capability on the basis of
`agent_role`: an agent that can set a header can claim any role, which would turn
a governance rule into a privilege-escalation path. Authorisation stays bound to
the virtual key.
:::

## Related

| Page | What it covers |
|---|---|
| [Custom Filters (WASM)](/guide/wasm-rules) | Writing and compiling the rules shown here |
| [Enforcement Actions](/concepts/enforcement-actions) | BYPASS, ENHANCE, HIJACK and KILL |
| [Integrations](/integrations/) | Harness setup, including multi-agent frameworks |
