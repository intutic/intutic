# How It Works <Badge type="tip" text="Open-Core" />

Intutic is a **transparent governance layer** that sits between your AI agents and the LLM providers they call. It enforces policies, detects anomalies, tracks costs, and records every decision — without adding meaningful latency.

## Architecture Overview

```
┌──────────────┐     ┌──────────────────────────────────────────┐
│  Claude Code │     │            Intutic Control Plane         │
│  Cursor      │────▶│                                          │
│  Aider       │     │  ┌──────────┐  ┌──────┐  ┌───────────┐  │
│  Windsurf    │     │  │  Proxy   │──│ PCAS │──│  Circuit  │  │
│  Antigravity │     │  │ Gateway  │  │      │  │  Breaker  │  │
│  Codex       │     │  └────┬─────┘  └──────┘  └─────┬─────┘  │
│  OpenHands   │     │       │                        │        │
│  n8n         │     │  ┌────▼─────┐  ┌──────┐  ┌─────▼─────┐  │
└──────────────┘     │  │  FinOps  │  │  ARE │  │   SOP     │  │
                     │  │  Ledger  │  │      │  │  Registry │  │
                     │  └──────────┘  └──────┘  └───────────┘  │
                     └──────────────────────────────────────────┘
                                      │
                              ┌───────▼───────┐
                              │  LLM Provider │
                              │  (Anthropic,  │
                              │   OpenAI, …)  │
                              └───────────────┘
```

## The Proxy Gateway

Every LLM request from your agents flows through the Intutic proxy. The proxy is transparent — agents don't need to change their code. The CLI's `init` command configures each harness to route through the proxy by setting the appropriate base URL or config variable.

**How routing works per harness:**

| Harness | Config File | Mechanism |
|---------|-------------|-----------|
| Cursor | `.cursorrules` | Markdown rules + project hooks.json |
| Claude Code | `CLAUDE.md` | Markdown rules + PreToolUse hooks.json |
| Windsurf | `.windsurfrules` | Markdown rules + Cascade settings.json HTTP proxy |
| Aider | `.aider.conf.yml` | `extra-instructions` YAML field |
| Antigravity | `.gemini/settings.json` | `customInstructions` JSON field |
| Codex | `.env.intutic` | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` env vars |
| OpenHands | `config.toml` | `[intutic]` TOML section with `proxy_url` |
| n8n | `.intutic/n8n/governance-workflow.json` | Workflow parameters via n8n REST API |
| Cline | `.cline/hooks/hooks.json` | PreToolUse hooks + apiBase injection |
| Roo Code | `.roorules` | Markdown rules + cancel hooks |
| Continue | `.continue/config.json` | JSONC config file manipulation |
| Claude Desktop | `claude_desktop_config.json` | Dev override + MCP wrapping |
| Goose | `.agents/plugins/intutic-governance/hooks/hooks.json` | JSON plugin hook structure |
| Open WebUI | `.open-webui/intutic-governance-filter.py` | Python inlet() filter hook |
| OpenClaw | `.openclaw/openclaw.json` | OpenClaw configuration file |
| Hermes | `.hermes/config.yaml` | YAML configuration file |
| Pi | `.pi/hooks.json` | Pi agent hooks config |

### Proxy Response Post-Processor

The proxy gateway contains a dedicated Rust post-processing engine (`response_postprocessor.rs` / `notification_client.rs`). It acts as a consumer for workspace-level Valkey notification queues (`gov:notify:workspace:{workspaceId}`) and session-specific queues (`gov:notify:{sessionId}`).

When the proxy intercepts a streaming or block response from an LLM provider:
1. It queries Valkey to drain any pending policy or budget notifications queued for that session.
2. It formats notifications using markdown or plaintext formatters.
3. It appends the compiled notifications block directly into the response stream inside a `<!-- intutic-governance -->` tag.
4. The agent harness displays the injected feedback inline, warning developers immediately of budget overruns, compliance score drops, or recommended fixes.

## Enforcement Actions (PCAS)

The **Policy Compliance and Action System** evaluates every request against your SOPs and applies one of four enforcement actions:

| Action | What happens | When it's used |
|--------|--------------|----------------|
| **BYPASS** | Request passes through unmodified | Compliant with all SOPs |
| **ENHANCE** | Request is modified (prompt enrichment, model upgrade) | SOP suggests improvements |
| **HIJACK** | Request is rerouted to a different model or modified substantially | Cost optimization, capability routing |
| **KILL** | Request is blocked entirely | Policy violation, budget breach, anomaly detected |

## The Circuit Breaker

The circuit breaker is the runtime enforcement mechanism. It evaluates each request against:

1. **SOP rules** — Does this request comply with active SOPs?
2. **Budget limits** — Is the user/workspace within budget tier limits?
3. **Anomaly scores** — Has the ARE flagged this session?
4. **Trust scores** — What's the trust level of this agent session?

If any check fails, the circuit breaker applies the appropriate enforcement action.

## SOP Lifecycle

SOPs (Standard Operating Procedures) are the policy documents that define governance rules. They follow a 7-state lifecycle:

```
DRAFT → PENDING_REVIEW → GENERATED → HYPOTHESIZED → REFINED → VALIDATED
                                                                    ↓
                                                              INVALIDATED
```

| State | Meaning |
|-------|---------|
| `DRAFT` | Initial authoring, not yet active |
| `PENDING_REVIEW` | Submitted for team review |
| `GENERATED` | Auto-generated from observed patterns |
| `HYPOTHESIZED` | Proposed rule being tested |
| `REFINED` | Iteratively improved based on feedback |
| `VALIDATED` | Active and enforced |
| `INVALIDATED` | Retired or superseded |

SOPs include:
- **Risk tier** — `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- **Complexity tier** — task complexity classification
- **Dependencies** — other SOPs this one depends on
- **Markdown content** — the actual policy rules

Changes to SOPs are classified as `STRENGTHEN`, `CLARIFY`, `NARROW`, or `WEAKEN` for audit trail.

## Anomaly Detection (ARE)

The Autonomous Reasoning Engine detects 12 categories of runtime anomalies:

| Anomaly Type | Description |
|-------------|-------------|
| `TOOL_ABUSE` | Excessive or inappropriate tool calls |
| `TOKEN_WASTE` | Inefficient token usage patterns |
| `LOOP_DETECTED` | Agent stuck in a retry/repeat loop |
| `UNAUTHORIZED_TOOL` | Calling tools outside allowed set |
| `DATA_EXFILTRATION` | Attempting to leak sensitive data |
| `PROMPT_INJECTION` | Malicious prompt manipulation detected |
| `HALLUCINATION` | Model generating fabricated information |
| `SCOPE_VIOLATION` | Operating outside defined task scope |
| `BUDGET_BREACH` | Exceeding allocated budget |
| `SPAWN_BUDGET_BREACH` | Sub-agent spawning over limits |
| `WORKFLOW_BUDGET_BREACH` | Multi-step workflow over budget |
| `WORKFLOW_GOAL_DRIFT` | Workflow deviating from stated objective |

## FinOps Ledger

Every execution trace records:
- Input/output token counts
- Model used and actual cost in USD
- Enforcement action applied
- Token utility classification (`USEFUL` or `WASTED`)

Budget tiers control spending limits per developer level:

| Tier | Role |
|------|------|
| `JUNIOR` | Junior developers — lowest budget ceiling |
| `SENIOR` | Senior developers |
| `STAFF` | Staff engineers |
| `PRINCIPAL` | Principal engineers — highest budget ceiling |

## Sync Daemon

The `intutic connect` command starts a long-lived sync daemon that:

1. **Polls** the control plane for SOP updates (default: every 30 seconds)
2. **Detects** which harnesses are present in the workspace
3. **Writes** updated governance config to each harness's config file
4. **Reports** sync state back to the control plane
5. Uses **atomic writes** (tmp file + rename) to prevent file corruption

The daemon supports all 18 harness adapters and handles each one's config format natively.

---

## Dual-Path Telemetry Fallback

To prevent data loss and bypasses during command executions, Intutic hooks implement a **dual-path telemetry reporting mechanism**:

1. **Path A (Real-Time API):** When a command executes, the hook makes an asynchronous, non-blocking HTTP POST request directly to the control plane `/api/v1/hook-events` endpoint using the workspace API key.
2. **Path B (Local Log Fallback):** Simultaneously, the event is appended to `.intutic/events/hook-events.jsonl` in the workspace root.

The `sync-daemon` monitors this log file in real time using FSEvents/inotify (`chokidar`). As soon as a modification is detected, the daemon drains the log file and sends the events to the control plane, ensuring that even if Path A fails due to network isolation, all governance audits are preserved.

---

## Active Network Probes

To detect if a developer has bypassed the proxy gateway or disabled system-level firewall redirection:
1. The `sync-daemon` periodically fires background HTTP requests directly to standard provider endpoints (e.g. `https://api.anthropic.com/v1/messages`) bypassing localhost routing.
2. If this direct connection succeeds, it indicates that the network is uncontained.
3. The daemon instantly raises a `network_bypass` incident of `CRITICAL` severity to alert administrators via the performance dashboard.
