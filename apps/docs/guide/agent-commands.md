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

It never leaves your machine.

### Memory context

`/fix` enriches the card with a **Memory context** section drawn from two
independent sources.

**Local vaults (open core, offline).** Your markdown notes are searched on your
own machine — no network, no model call, no control plane. Obsidian, Logseq and
Foam vaults are detected automatically by their marker directory
(`.obsidian`, `.logseq`, `.foam`) when the vault is at or above your working
directory; anything else is named explicitly:

```yaml
# config.yaml
intutic_settings:
  memory:
    enabled: true
    vaults:
      - ~/Documents/ObsidianVault
      - ~/notes            # any folder of .md files works
```

Search is deterministic keyword matching, ranked so that a note matching two of
your terms beats one repeating a single term. It is bounded by construction —
capped files per search, oversized notes skipped, marker and dot directories
never walked — so a large vault costs milliseconds. In blocking `/fix` the
snippets never leave your machine at all; in non-blocking mode the rewritten
prompt still passes input DLP, so a token pasted into a note is redacted before
egress.

**Cloud providers (Cloud tier).** When a control plane is connected, your
workspace's memory providers (mem0, Supermemory, AgentMemory, or any provider
via the generic HTTP connector) are also searched, the chunks are ranked by the
LLM-as-judge (with a deterministic fallback when no judge is reachable), and the
winners are inlined with their provider attribution. A provider that is down
contributes nothing rather than blocking the command.

Both sources render in the same section, labelled by origin —
`vault:MyNotes/architecture` for a local note, `mem0` for a cloud provider.

::: tip Obsidian, two ways
A local vault is read directly by the proxy, as above — the private, offline
path, and the one most people want. If instead your vault is already synced to
a hosted memory service, connect that service as a Cloud provider and it is
searched through the same path as any other provider; no Obsidian-specific
configuration is involved.
:::

## `/draw` — visualize the agent

`/draw <your prompt>` (aliases: `@draw`, `/intutic-draw`, `@intutic draw`)
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
request is made, so they cost nothing in tokens. Setting
`intutic_settings.commands.non_blocking: true` in `config.yaml` switches `/fix`
to passthrough: the command token is stripped, the synthesis card is appended
to your prompt, and the turn is forwarded to your provider so the model sees
the enhanced prompt. `/draw` stays blocking either way — a visualization has no
upstream half.

## Related

- [Graph Guardrails](/guide/graph-guardrails) — the primitives these commands inventory
- [Policies & Enforcement](/guide/policies) — DLP, PCAS, SOP enforcement
- [Agents](/guide/agents) — the workspace agent graph and posture rings <Badge type="warning" text="Cloud" />
