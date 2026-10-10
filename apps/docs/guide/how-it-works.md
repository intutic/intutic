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
| Cursor | `.cursor/hooks.json`, `~/.cursor/hooks.json` | Project and user hooks; see [Cursor](/integrations/cursor) |
| Claude Code | `.claude/settings.json` | PreToolUse hook and deny rules |
| Windsurf | Windsurf's user `settings.json` | Cascade hooks + HTTP proxy setting |
| Aider | `.aider.conf.yml` | `openai-api-base`, and `ANTHROPIC_BASE_URL` under `set-env` |
| Antigravity | `~/.gemini/settings.json`, `~/.gemini/config/hooks.json` | BeforeTool / PreToolUse hooks |
| Codex | `~/.codex/config.toml`, `.env.intutic` | `openai_base_url`, and `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` for shells that source the env file |
| OpenHands | `config.toml` | `[llm] base_url` merged in, plus a PreToolUse hook in `.openhands/hooks.json` |
| n8n | `~/.intutic/hooks/n8n-governance-hook.js` | External hook the n8n server loads through `EXTERNAL_HOOK_FILES` |
| Cline | `.clinerules/hooks/PreToolUse` | PreToolUse hook; the base URL is set by hand in Cline's settings panel |
| Roo Code | none | Base URL set by hand in Roo Code's settings panel; no hook system |
| Continue | `~/.continue/config.yaml` | `apiBase` on each OpenAI and Anthropic model (no gate: `cn` never fires its PreToolUse hooks) |
| Claude Desktop | `claude_desktop_config.json` | Dev override + MCP wrapping |
| Goose | `.agents/plugins/intutic-governance/hooks/hooks.json` | JSON plugin hook structure |
| Open WebUI | `.open-webui/intutic-governance-filter.py` | Python inlet() filter hook |
| OpenClaw | `~/.openclaw/openclaw.json`, `~/.intutic/hooks/openclaw/intutic-governance.cjs` | `before_tool_call` plugin, listed in `plugins.load.paths` |
| Hermes | `~/.hermes/config.yaml` | YAML configuration file |
| Pi | `~/.pi/agent/extensions/intutic-governance.js`, `~/.pi/agent/models.json` | `tool_call` extension; `baseUrl` for the Anthropic and OpenAI providers |

Where the rule sets themselves go is a separate question; see [Where rule sets go](#where-rule-sets-go).

### Proxy Response Post-Processor

The proxy gateway contains a dedicated Rust post-processing engine (`packages/proxy/src/postprocessor/` — `mod.rs`, `formatter.rs`, `notification_client.rs`). It acts as a consumer for workspace-level Valkey notification queues (`gov:notify:workspace:{workspaceId}`) and session-specific queues (`gov:notify:{sessionId}`).

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
| **KILL** | Request is blocked entirely | Policy violation, budget breach, deterministic anomaly (loop, forbidden succession, credential sweep) |

## The Circuit Breaker

The circuit breaker is the runtime enforcement mechanism. It evaluates each request against:

1. **SOP rules** — Does this request comply with active SOPs?
2. **Budget limits** — Is the workspace within its daily spend cap?
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

The Autonomous Reasoning Engine detects 12 categories of runtime anomalies. It runs on the control plane over ingested traces and hook events (a heuristic classifier per trace plus a periodic baseline sweep), records findings and opens incidents; it is not on the request path, and a finding blocks only after [promotion](/concepts/enforcement-actions#the-promotion-rule). Request-time content checks are the proxy's detectors and DLP, the response judge, the MCP interceptor and the hook gates.

| Anomaly Type | Description |
|-------------|-------------|
| `TOOL_ABUSE` | Excessive or inappropriate tool calls |
| `TOKEN_WASTE` | Inefficient token usage patterns |
| `LOOP_DETECTED` | Agent stuck in a retry/repeat loop |
| `UNAUTHORIZED_TOOL` | Calling tools outside allowed set |
| `DATA_EXFILTRATION` | Attempting to leak sensitive data |
| `PROMPT_INJECTION` | Malicious prompt manipulation detected |
| `HALLUCINATION` | An agent still working for a parent that is gone — its results have nowhere to go |
| `SCOPE_VIOLATION` | Operating outside defined task scope |
| `BUDGET_BREACH` | Exceeding allocated budget |
| `SPAWN_BUDGET_BREACH` | Sub-agent spawning over limits |
| `WORKFLOW_BUDGET_BREACH` | Multi-step workflow over budget |
| `WORKFLOW_GOAL_DRIFT` | Workflow deviating from stated objective |

An incident can also have the type `WASM_RULE_REFUSED`, which is not an anomaly: a proxy refused to load a version of a [custom filter](/guide/wasm-rules#when-a-rule-cannot-load).

## FinOps Ledger

Every execution trace records:
- Input/output token counts
- Model used and actual cost in USD
- Enforcement action applied
- Token utility classification (`USEFUL` or `WASTED`)

Spend is limited by the workspace's daily and monthly caps and by budgets on virtual keys and members, each one refusing requests or alerting only; the proxy checks the ones that refuse on every request. See [Budgets](/guide/budgets#setting-up-budget-limits).

## Sync Daemon

The `intutic connect` command starts a long-lived sync daemon that:

1. **Polls** the control plane for SOP updates (default: every 30 seconds)
2. **Detects** which harnesses are present in the workspace
3. **Writes** updated governance config to each harness's config file
4. **Reports** sync state back to the control plane
5. Uses **atomic writes** (tmp file + rename) to prevent file corruption

The daemon supports 42 of Intutic's 43 harness adapters and handles each one's config format natively. The 43rd, TrueForge run as its own standalone/hosted server, is not something `intutic init` can detect in a repo at all (it's an operator-configured deployment, not a repo dependency) — it is governed instead by a separate, out-of-process service, `services/trueforge-bridge`. See the [TrueForge integration guide](/integrations/trueforge#server-mode-standalone-hosted).

## Where rule sets go

`intutic connect` writes the rule sets aimed at a harness, and the [Governed Decisions Log](/guide/decisions-log) when the workspace turned it on, into the file that product reads as standing instructions, and nowhere else. Three shapes:

- **A file of Intutic's own** in a directory whose every file the product reads, such as `.cursor/rules/`. The decisions log gets a second file there. You keep your own rules in other files there.
- **A marked section** of a file you also write, such as `AGENTS.md`. The rule sets sit between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->`, and the decisions log in a section of its own between `<!-- INTUTIC:DECISIONS_LOG:START -->` and `<!-- INTUTIC:DECISIONS_LOG:END -->`; the rest of the file is yours, and connect never touches it. You can move the sections within the file.
- **No instructions file.** The product reads no file of standing instructions, so neither the rule-set text nor the decisions log can reach the model. A harness with a gate still enforces the rules compiled from your rule sets. The dashboard's Compliance Scope card for such a harness says so.

Connect never creates or writes `CLAUDE.md`. Claude Code gets everything from `.claude/rules/`, which it loads at launch with or without a `CLAUDE.md`. When Claude Code also reads the workspace's `AGENTS.md` (by default, when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` is in its working directory or above; always, if you chose `claude-md-and-agents-md` for **Project instructions** in your own `/config`), what `AGENTS.md` carries for the other harnesses is left out of `.claude/rules/`, so Claude Code reads each rule set and the decisions log once. See [Claude Code](/integrations/claude-code#rules-and-the-decisions-log).

`AGENTS.md` is shared: every harness below that reads it gets one section holding every rule set aimed at any of them that is configured in the workspace. A rule set aimed at Codex is therefore also read by OpenCode in the same workspace. Muse Code, OpenCode, Pi and Hermes read `AGENTS.md` in place of a `CLAUDE.md` once both exist, so connect creating `AGENTS.md` in a workspace that only had `CLAUDE.md` changes what those harnesses read.

`intutic disconnect` takes the section out, or puts back the file the rules file replaced, byte for byte when you have not edited it since. Earlier versions overwrote `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `.roorules` and `AGENTS.md` whole; the first sync with this version gives you your own copy of each back.

| Harness | Id | Rule sets go to | Decisions log goes to | Notes |
|---------|----|-----------------|-----------------------|-------|
| Claude Code | `claude-code` | `.claude/rules/intutic-governance.md` | `.claude/rules/intutic-decisions.md` | Loaded at launch, with or without a `CLAUDE.md`. Not `CLAUDE.md`: by default a project `CLAUDE.md` stops Claude Code reading `AGENTS.md`. What also reaches it through `AGENTS.md` is left out. |
| Cursor | `cursor` | `.cursor/rules/intutic-governance.mdc` | `.cursor/rules/intutic-decisions.mdc` | `alwaysApply: true`. |
| Windsurf | `windsurf` | `.windsurf/rules/intutic-governance.md` | `.windsurf/rules/intutic-decisions.md` | `trigger: always_on`; 12,000 characters per rule file. |
| Antigravity and Gemini CLI | `antigravity` | `GEMINI.md` (section) | Its own section of the same file | Gemini CLI reads it only in a trusted folder. |
| Aider | `aider` | `.intutic/aider-sops.md` | `.intutic/aider-decisions.md` | Listed under `read:` in `.aider.conf.yml` by absolute path, so Aider finds it from any subdirectory. |
| OpenHands | `openhands` | `.openhands/microagents/intutic-governance.md` | `.openhands/microagents/intutic-decisions.md` | A microagent with no triggers is always active. |
| Codex | `codex` | `AGENTS.md` (section) | Its own section of the same file | Codex reads at most 32 KiB of `AGENTS.md` files in total. |
| Muse Code | `muse-code` | `AGENTS.md` (section) | Its own section of the same file | Read once the workspace is trusted. |
| Grok Build | `grok` | `AGENTS.md` (section) | Its own section of the same file | Read once the folder is trusted. |
| OpenCode | `opencode` | `AGENTS.md` (section) | Its own section of the same file | |
| Pi | `pi` | `AGENTS.md` (section) | Its own section of the same file | |
| Hermes | `hermes` | `AGENTS.md` (section) | Its own section of the same file | A `.hermes.md` or `HERMES.md` between the working directory and the git root takes the place of `AGENTS.md`; keep your Hermes instructions in `AGENTS.md`. |
| Roo Code | `roo-code` | `AGENTS.md` (section) | Its own section of the same file | Read unless `roo-cline.useAgentRules` is off. Not `.roo/rules/`, whose first file hides your `.roorules` and `.clinerules`. |
| dsh | `dsh` | `AGENTS.md` (section) | Its own section of the same file | Read by the default profile's agent-instructions plugin. |
| GitHub Copilot | `github-copilot` | `.github/copilot-instructions.md` (section) | Its own section of the same file | |
| Cline | `cline` | `.clinerules/intutic-governance.md` | `.clinerules/intutic-decisions.md` | |
| Continue | `continue` | `.continue/rules/intutic-governance.md` | `.continue/rules/intutic-decisions.md` | `alwaysApply: true`. The `cn` CLI reads the `.continue/rules/` of the directory it runs in. |
| Goose | `goose` | `.goosehints` (section) | Its own section of the same file | |
| OpenClaw | `openclaw` | `~/.openclaw/workspace/AGENTS.md` (section) | Its own section of the same file | OpenClaw reads instructions only from its agent workspace, never from a project: connect writes to the one `agents.defaults.workspace` names, or `OPENCLAW_WORKSPACE_DIR`. 20,000 characters per file. |
| n8n | `n8n` | No instructions file | Does not reach it | An AI Agent node's system message is part of the workflow. The workflow gate still applies. |
| Claude Desktop | `claude-desktop` | No instructions file | Does not reach it | Instructions live in the app's projects. |
| Open WebUI | `open-webui` | No instructions file | Does not reach it | System prompts live in Open WebUI's settings. |
| Xirp | `xirp` | No instructions file | Does not reach it | The harnesses it runs read their own files. |
| Agentic Orchestrator | `agentic-orchestrator` | No instructions file | Does not reach it | The harnesses it runs read their own files. |
| AWS Bedrock AgentCore | `agentcore-runtime` | No instructions file | Does not reach it | Your framework's SDK gate applies. |
| TrueForge server | `trueforge-server` | No instructions file | Does not reach it | Governed by the TrueForge bridge. |
| LangGraph | `langgraph` | No instructions file | Does not reach it | SDK framework: the instructions are your code; the SDK gate applies. |
| LangChain | `langchain` | No instructions file | Does not reach it | SDK framework. |
| CrewAI | `crewai` | No instructions file | Does not reach it | SDK framework. |
| AutoGen | `autogen` | No instructions file | Does not reach it | SDK framework. |
| AG2 | `ag2` | No instructions file | Does not reach it | SDK framework. |
| Google ADK | `google-adk` | No instructions file | Does not reach it | SDK framework. |
| OpenAI Agents SDK | `openai-agents` | No instructions file | Does not reach it | SDK framework. |
| Pydantic AI | `pydantic-ai` | No instructions file | Does not reach it | SDK framework. |
| smolagents | `smolagents` | No instructions file | Does not reach it | SDK framework. |
| Strands Agents | `strands` | No instructions file | Does not reach it | SDK framework. |
| Microsoft Agent Framework | `agent-framework` | No instructions file | Does not reach it | SDK framework. |
| Mastra | `mastra` | No instructions file | Does not reach it | SDK framework. |
| Vercel AI SDK | `vercel-ai-sdk` | No instructions file | Does not reach it | SDK framework. |
| eve | `eve` | No instructions file | Does not reach it | SDK framework. |
| TrueForge | `trueforge` | No instructions file | Does not reach it | SDK framework. |
| AI SDK Harness | `ai-sdk-harness` | No instructions file | Does not reach it | SDK framework. |
| AI SDK Workflow | `ai-sdk-workflow` | No instructions file | Does not reach it | SDK framework. |

---

## Dual-Path Telemetry Fallback

To prevent data loss and bypasses during command executions, Intutic hooks implement a **dual-path telemetry reporting mechanism**:

1. **Path A (Real-Time API):** When a command executes, the hook makes an asynchronous, non-blocking HTTP POST request directly to the control plane `/api/v1/hook-events` endpoint using the workspace API key.
2. **Path B (Local Log Fallback):** Simultaneously, the event is appended to `.intutic/events/hook-events.jsonl` in the workspace root.

The `sync-daemon` monitors this log file in real time using FSEvents/inotify (`chokidar`). As soon as a modification is detected, the daemon drains the log file and sends the events to the control plane, ensuring that even if Path A fails due to network isolation, all governance audits are preserved.

Most events therefore arrive more than once: over both paths, and again whenever the daemon resends a batch whose response it did not get. Each event carries an `eventId`, generated when it is recorded and kept in the line that is resent, and the control plane processes each id once per workspace. A resend files no second incident, finding or plan deviation and exports no second gate decision. Events from gates and SDKs older than the `eventId` field are processed every time they arrive.

---

## Egress Enforcement & Runtime Isolation (opt-in)

By default the proxy *mediates* the traffic pointed at it — an agent that does
not route through it is not governed, and the [Active Network Probes](#active-network-probes)
below exist to *detect* exactly that. Two opt-in layers turn mediation into
enforcement, so bypass is not possible rather than merely detected:

- **`intutic enforce`** installs a host-level default-deny egress firewall
  (nftables/iptables/pf) that permits outbound only to the proxy, DNS, and
  operator-declared infrastructure. Every other connection is dropped, so the
  only path to the network is the governing proxy. The proxy itself can then run
  in `enforce` mode (`intutic_settings.egress.mode`), where it denies — not just
  inspects — any destination not on its allow policy.

- **`intutic exec --sandbox`** runs an agent inside an isolated runtime — a
  container today, a Firecracker microVM where KVM is available — with a dropped
  capability set, a read-only root filesystem, resource caps, and its egress
  locked to the proxy. The agent cannot reach the network except through
  governance, and cannot alter the firewall it runs behind. The container
  backend is the one to reach for by default; the Firecracker backend boots on
  real KVM but has not yet been validated end-to-end for an agent running to
  completion inside it — see [Sandboxed Execution](/guide/sandboxed-execution)
  for the full backend-by-backend breakdown, what each does and doesn't cover,
  and the platforms this does and doesn't reach.

Both are off by default, so an existing install is unchanged.

## Active Network Probes

To detect if a developer has bypassed the proxy gateway (when host enforcement
is not enabled):
1. The `sync-daemon` periodically fires background HTTP requests directly to standard provider endpoints (e.g. `https://api.anthropic.com/v1/messages`) bypassing localhost routing.
2. If this direct connection succeeds, it indicates that the network is uncontained.
3. The daemon instantly raises a `network_bypass` incident of `CRITICAL` severity, shown to administrators under **Findings › Incidents**.
