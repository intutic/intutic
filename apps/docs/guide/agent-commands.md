# Prompt Commands: `/fix` & `/draw` <Badge type="tip" text="Open-Core" />

Two blocking slash-commands the proxy answers locally, without forwarding the
turn to your LLM provider — the same interception the [`/intutic-predict`](/reference/cli)
cost pre-check uses. Type them as the start of any prompt in any harness routed
through the Intutic proxy.

## `/fix` — Grammarly for prompts

`/fix <your prompt>` (aliases: `@fix`, `/intutic-fix`, `@intutic fix`) runs a
pre-flight pass over your prompt and returns a **synthesis card** instead of a
model reply. The card:

1. Echoes your prompt with a word count.
2. **Inventories the Intutic primitives** applied to this request — input/output
   DLP, WASM rules, the hook gate, policy enforcement, and the role SOPs on disk.
3. **Inlines the governance** that applies to your role, so the enhanced prompt
   carries the actual policy the agent must follow, not just a count.
4. Scores the request's **security posture** (see below) and shows the per-facet
   breakdown with the OWASP LLM category each facet maps to.
5. Lists **recommendations** for whatever guardrail is off — e.g. "enable output
   DLP", "write a role SOP under `.intutic/sops`".

It never leaves your machine. In the enterprise tier, `/fix` can additionally
enhance the prompt with ranked chunks from your connected memory providers
(mem0, Supermemory, AgentMemory, …), routed through the LLM-as-judge — that path
runs in the control plane and is off in open core.

## `/draw` — visualize the agent

`/vdraw <your prompt>` (aliases: `@draw`, `/intutic-draw`, `@intutic draw`)
returns a Mermaid + text picture of how the request flows through the proxy: the
DLP stages, the policy/SOP check, the role SOPs that constrain tool use, and the
agent's likely trajectory for your prompt. Because the card is Mermaid, any
harness that renders Markdown shows the diagram inline.

## Security-posture score

Both commands score against a published rubric (`owasp-llm-2025.1`): each Intutic
primitive maps to the [OWASP LLM Top 10 (2025)](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
risk it mitigates and, for the agent-to-agent surface, the OWASP Agentic-AI
threat classes. A facet that does not apply to your setup (no MCP tools, single
agent so no graph) is excluded from the weighting rather than scored zero — you
are not marked down for a surface you never use. The score bands map to a colour
you will also see on the [Agents dashboard](/guide/agents) ring: red < 40,
orange < 65, yellow < 85, green ≥ 85.

## Blocking vs. passthrough

Both commands are **blocking** by default: the proxy answers and no upstream
request is made, so they cost nothing in tokens. They are deterministic and
local — the whole of the open-core behaviour.

## Related

- [Graph Guardrails](/guide/graph-guardrails) — the primitives these commands inventory
- [Policies & Enforcement](/guide/policies) — DLP, PCAS, SOP enforcement
- [Agents](/guide/agents) — the workspace agent graph and posture rings <Badge type="warning" text="Cloud" />
