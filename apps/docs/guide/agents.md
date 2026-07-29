# Agents <Badge type="warning" text="Cloud / Team" />

The **Agents** screen on [app.intutic.ai](https://app.intutic.ai) is the
workspace agent graph: one node per durable agent identity, the connections
between them, and a concentric security-posture ring per agent.

## What an agent is

A **session** is one run of an agent — it ends, it carries a task and a commit.
An **agent** is the durable thing you keep opening: same harness, same role,
same workspace, many sessions over time. The registry keys on that durable
identity (`agent_id`); sessions link up to it. The [sync daemon](/concepts/harnesses)
registers each detected harness as an agent on every sync and reports the facets
it can see locally.

## Linked facets

Each agent node carries the primitives linked to it, shown as satellites around
its ring:

| Facet | What is linked |
|---|---|
| 🛡️ Guardrails | DLP, WASM rules, hook gate, PCAS — which are enforcing |
| 📋 SOPs | Role SOPs bound to the agent, and whether each is enforced |
| 💰 Budgets | Session and workspace spend caps |
| 🔌 MCP tools | Connected MCP servers/tools and whether their access is scoped |
| 🎓 Skills | Declared skills and their source |
| 🔁 Loops | Loop / turn limits |
| 🕸️ Graphs | Graph membership and whether keys are workspace-scoped |
| 🖥️ Harness | The harness type and whether its config is drift-watched |
| 🧠 Memory | Connected memory providers and whether they are governed |

## Connections between agents

Directed edges show how agents relate — **spawns**, **handoff**, **verifies**,
or **shares-graph** — derived from session parentage and shared graph IDs, or
declared explicitly. This is what lets a rule reason about the whole graph
rather than one node's turn.

## The trust ring

Each node is wrapped in a concentric ring whose arc length is the agent's
**security-posture score** and whose colour runs red → orange → yellow → green
with it. The score is configurational — how much of the guardrail surface that
*applies* to the agent is actually switched on — scored against the published
`owasp-llm-2025.1` rubric (see [Prompt Commands](/guide/agent-commands) for the
scale). It is distinct from the behavioural [trust score](/concepts/enforcement-actions),
which decays on anomalies and boosts on clean runs.

By default the ring is scored deterministically; on the Team tier and above, an
LLM-as-judge pass can override per-facet scores with a semantic assessment of
which SOP rules and primitives apply to each agent, harness and connection.

## Reopening a session

Select an agent to see its live sessions and copy-paste commands to reopen each
one on your own machine — a harness-native resume (`claude --resume …`,
`cursor .`, `aider --restore-chat-history`, …) plus the proxy-attach.

## Related

- [Prompt Commands](/guide/agent-commands) — `/fix` and `/draw`, and the posture rubric
- [Graph Guardrails](/guide/graph-guardrails) — how the proxy governs the graph
- [Developer Sessions](/guide/agent-top) — live session telemetry
