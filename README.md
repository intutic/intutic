<div align="center">

# Intutic — Policy as Code for Continuous Compliance & Continuous Enforcement for AI Agents

**The circuit breaker for AI agents: your policies are files in git, enforced synchronously at the tool call, across 43 agent harnesses.**

[![GitHub Stars](https://img.shields.io/github/stars/intutic/intutic?style=social)](https://github.com/intutic/intutic)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/Docs-docs.intutic.ai-6f42c1)](https://docs.intutic.ai)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)](https://github.com/intutic/intutic/actions)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/intutic/intutic/pulls)

[Quickstart](#-30-second-quickstart) • [Architecture](#%EF%B8%8F-architecture) • [Key Features](#-key-features) • [Supported Harnesses](#-supported-harnesses--frameworks) • [Docs](https://docs.intutic.ai)

<br>

<img src="assets/demo.gif" alt="Intutic Hero Demo — Real-time AI Agent Circuit Breaker" width="100%">

</div>

---

## 💡 Why Intutic?

Observability tools and LLM gateways (like LangSmith or Portkey) work on model traffic: they trace each call, and their gateways and guardrails can cap spend, redact or reject a request inline. What they do not control is the agent's local tool execution — the shell command that deletes files, the write that leaks a secret, the loop that keeps calling an API. A gateway can stop an MCP call only when the call is routed through its own MCP gateway, as Portkey's now can.

**Intutic is an active circuit breaker at the tool call.** In 36 of the 43 supported harnesses, each tool call passes through a policy gate before it runs — a rule decision, not a model call — that blocks dangerous commands and steers agentic loops in real time. The proxies cover the rest, and the model traffic as well.

---

## 🏗️ Architecture

Intutic runs as a local or self-hosted proxy, written in Rust, between your agents and their model providers:

`intutic gates install` installs a tool-call gate in each harness that supports one, writes its rules file from `.intutic/sops/` and adds the bundled agent skills (Kitkat and rule authoring) where the workspace has none, with no control plane; `intutic start` rewrites them when a rule set changes.

<!-- UNRELEASED:cloud
With `intutic connect`, a sync daemon (`sync-daemon`) does the same and keeps the rules files in sync with a control plane.
-->

```mermaid
flowchart TD
    subgraph Dev[" 💻 Developer machine "]
        Agent["🤖 AI coding agent<br><i>(Claude Code, Cursor, Codex, Aider, LangGraph, …)</i>"]
        SOP["📝 SOP rules<br><i>(.intutic/sops/)</i>"]
        Installer["🧩 Gate installer<br><i>(intutic gates install · intutic start)</i>"]
        Gate["🚦 Tool-call gate<br><i>(harness hook; runs before each tool call)</i>"]
    end

    subgraph Proxy[" ⚡ Intutic proxy (:4000) "]
        Checks["🔒 Checks on each request and response<br><i>SOP rules · WASM/Rego rules · DLP · anomaly detectors · daily budget</i>"]
        Verdicts["Verdicts<br><code>BYPASS</code> | <code>HIJACK</code> | <code>REASK</code> | <code>KILL</code>"]
    end

    Providers["🌐 LLM providers<br><i>Anthropic · OpenAI · Gemini · Bedrock · Vertex · Azure · OpenRouter · …</i>"]
    Decide["🧠 Decide engine<br><i>(your self-hosted model; only for <code>decide:</code> rules)</i>"]
    App["🧾 Your app"]
    DecisionModels["⚖️ Decision models<br><i>(System One · OpenAI Decisions)</i>"]

    Agent -->|1 · Model request| Proxy
    Proxy -->|2 · Allowed request| Providers
    Providers -->|3 · Response with tool calls| Proxy
    Proxy -->|4 · Response, or refusal| Agent
    Agent -->|5 · Each tool call| Gate
    SOP -->|Reloaded every 30 s| Checks
    SOP -->|Compiled| Installer
    Installer -->|Writes gates, rules files and the policy snapshot| Gate
    Gate -.->|"decide: rules"| Decide
    Checks -.->|"decide: rules on tool calls and on: response"| Decide
    App -->|"/v1/systemone · /v1/decisions"| Proxy
    Proxy -->|DLP · egress policy · version pin · log| DecisionModels
```

---

## ⚡ 30-Second Quickstart

### 1. Install the CLI & Native Proxy Gateway
```bash
# Install global CLI and native Rust proxy binary
npm install -g @intutic/cli @intutic/proxy

# Or run the native proxy directly on-demand
npx @intutic/proxy
```

### 2. Install the Gates
Inside your project folder, detect your coding agents and install a blocking gate in each, with its rules file written from `.intutic/sops/`:
```bash
intutic init
intutic gates install
```

### 3. Start the Proxy
Run `intutic start` inside your project folder. This boots the local high-speed Rust proxy on port `4000` — no account, configuration file or control plane needed:
```bash
intutic start
```

### 4. Route Any Agent to Intutic
Point your favorite LLM client or agent framework to the local proxy:
```bash
export ANTHROPIC_BASE_URL="http://localhost:4000"     # Anthropic SDKs append /v1/messages
export OPENAI_BASE_URL="http://localhost:4000/v1"      # OpenAI SDKs append /chat/completions
```
Or launch it with `intutic exec -- <agent>`, or run `intutic gates install --route` to write the proxy URL into the configs of the agents that have a setting for it.

That's it! Your agent is now governed by real-time safety guardrails.

---

## 🔥 Key Features

| Feature | Description |
| :--- | :--- |
| ⚡ **In-Process WASM Engine** | Policy evaluation runs in-process — no model call and no network hop — so it adds no round-trip to the tool-call path. |
| 🛡️ **Zero-Trust Tool Interception** | Intercepts dangerous commands before they touch your system: with no configuration, the harness hook gate blocks writes to its own hook files and settings, governance-bypass commands and secrets, and flags `rm -rf /`, `mkfs` and similar destructive commands without blocking them, while the LLM proxy refuses those in a model's code-execution tool call; `git push --force` or any other command is refused once a rule you add names it (a SOP's `hook_rule:`, which the proxy enforces, or a WASM or Rego rule); a `DROP TABLE` in an MCP tool call is blocked by the MCP governance proxy, at the hook gate it is flagged for triage rather than blocked, and the LLM proxy refuses one in a model-emitted shell command (`psql`, `mysql`, `sqlite3`, `dropdb`) whose target database is not on the workspace's DSN allowlist — opt-in, via `sql_guard:` in a SOP. |
| 🔐 **Secret DLP & Masking** | Automatically redacts API keys (`[REDACTED_SECRET]`), AWS credentials, and tokens in prompts & tool payloads. |
| 💰 **Session Spend Ceilings** | Prevents "loop burn" by enforcing token spending ceilings per session (e.g. $5.00 limit). |
| 🔄 **43 Harness Adapters** | Pre-configured support for Claude Code CLI, Cursor, Windsurf, Aider, Antigravity, OpenCode, DeepSeek dsh, Spotify Xirp, DoorDash Agentic Orchestrator, AWS Bedrock AgentCore Runtime, and more. |
| 🤖 **Single & Multi-Agent Swarms** | Governs single developer tools as well as multi-agent graph/swarm workflows — LangGraph, LangChain, CrewAI, AutoGen, AG2, Google ADK, OpenAI Agents SDK, Pydantic AI, smolagents, AWS Strands Agents, and Microsoft Agent Framework each have a dedicated SDK-side gate (Python); Mastra, the Vercel AI SDK, eve, AI SDK Harness, AI SDK Workflow, and TrueForge (embedded) have the same on the TypeScript side (`@intutic/gate`). |
| 🧭 **Decide Rules** | A SOP's `decide:` key asks a model narrow yes/no or pick-one questions about a tool call (at the hook gates, the gate SDKs and the proxy) or a model's response (at the proxy), and refuses, allows or escalates from the answers. The engine is self-hosted only (Ollama, vLLM, llama.cpp or another server on your machine or network): it refuses to call a hosted decision API. A rule runs in shadow, logged but refusing nothing, until a pre-registered `intutic decide eval` pins it to a model; `intutic decide` also configures the engine, tests a rule on one call and lints rules. See [Decide rules](https://docs.intutic.ai/guide/decide). |
| 🔁 **Loop, Graph & Gate Keys** | SOP keys for agent loops and graphs: `requires_before: action:run_tests[ok] -> action:deploy` (a deploy needs a passing test run since the last file change), `scope_paths_mode: enforce` (writes outside `scope_paths` are refused), `plan_approval:` (no calls until the session's plan is approved), `closed_lanes:` (irreversible or reversible-wide actions held for a person), `node_kind:` (what a graph node may do), and `context_isolation:` (siblings handed the same brief). See [SOP Front Matter](https://docs.intutic.ai/reference/sop-front-matter). |
| ⚖️ **Decision-Model Traffic** | Your own app's calls to decision models (`POST /v1/systemone`, `POST /v1/decisions`) go through the proxy like LLM calls: DLP on the state, the egress policy, a version pin that refuses moving aliases, abstention and human-review headers on the answer, metering, and a local log. See [Decision Traffic](https://docs.intutic.ai/guide/decision-traffic). |

---

## 🛡️ The PCAS Primitives

Every request the proxy evaluates gets one of four **PCAS Action Primitives**:

```
 ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐
 │  BYPASS  │  │   HIJACK   │  │  REASK   │  │   KILL   │
 └────┬─────┘  └─────┬──────┘  └────┬─────┘  └────┬─────┘
      │              │              │              │
      ▼              ▼              ▼              ▼
 Direct Pass   Redact Secrets    Refuse &      Hard-Abort
 (In-Process)   or Swap Args    Bounded Retry  Runaway Loop
```

1. **`BYPASS`**: Standard safe execution passes through natively (in-process, no added network hop).
2. **`HIJACK`**: Substitute dangerous tool parameters or redact secrets on the fly.
3. **`REASK`**: Refuse the attempt and hand the reason back to the agent, which may retry a bounded number of times before the finding escalates to a block.
4. **`KILL`**: Refuse the request outright, for example when a model's code-execution tool call carries a destructive operation (`rm -rf /`, `mkfs`, `dd if=`) or a session hits its loop caps.

A fifth, **`ENHANCE`**, is not a proxy verdict: a control plane's evaluator scores a sample ENHANCE, and open core ships no control plane. See [Enforcement Actions](https://docs.intutic.ai/concepts/enforcement-actions#enhance).

---

## 🔌 Supported Harnesses & Frameworks

Intutic ships **43 harness adapters**: 18 install as native hook gates in the harness's own configuration, with no change to your agent's code; Claude Desktop and Roo Code have no hook system, and Continue's hooks never fire, so the three are governed through the proxy and the MCP governance proxy; 17 SDK-gated frameworks are governed by an in-process gate you add to your agent code (`@intutic/gate` or `intutic-clawde`); Aider is governed through the proxy alone; and four orchestrators and bridges hand off to an already-gated harness or to a bridge service you run. Every one of them is a **supported harness** — no adapter carries an open support gap today (AutoGen's closed with its workbench gate, the Agentic Orchestrator's with OpenCode's own adapter, both in September 2026). Anything else that speaks an OpenAI- or Anthropic-compatible API is governed the same way by pointing its base URL at the proxy:

| Category | Supported Tools & Frameworks |
| :--- | :--- |
| **Single-Agent Assistants** (native adapters) | **Claude Code CLI**, **Cursor**, **Windsurf**, **Aider**, **Antigravity**, **Cline**, **Roo Code**, **Codex**, **Continue**, **Claude Desktop**, **Goose**, **Pi**, **GitHub Copilot**, **OpenWebUI**, **Muse Code**, **Grok Build**, **OpenCode**, **dsh** (preview) |
| **Multi-Agent Swarms** (native adapters) | **OpenHands**, **OpenClaw**, **Hermes**, **n8n** |
| **Orchestrators** (delegate to already-gated harnesses, no gate of their own) | **Spotify Xirp**, **DoorDash Agentic Orchestrator**, **AWS Bedrock AgentCore Runtime** (hosts your own framework-SDK code unchanged; delegates to whichever already-supported framework adapter that code uses) |
| **SDK-gated frameworks** (dedicated in-process gate, `@intutic/gate`/`intutic-clawde`) | **LangGraph**, **LangChain**, **CrewAI**, **AutoGen**, **AG2**, **Google ADK**, **OpenAI Agents SDK**, **Pydantic AI**, **smolagents**, **AWS Strands Agents**, **Microsoft Agent Framework**, **Mastra**, **Vercel AI SDK**, **eve**, **TrueForge** (embedded), **AI SDK Harness**, **AI SDK Workflow** |
| **Bridge-gated** (a separate bridge service you run, no gate in the harness's own process; it checks each call with a control plane's hook gate, so it needs a control plane, and its code is not in this repository) | **TrueForge** (standalone/hosted server) |
| **Any OpenAI-compatible framework** (no adapter needed) | Anything else honoring `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — launch it with `intutic exec` or export the base-URL env vars |
| **Server-side platform integrations** (call Intutic directly over HTTP; no `HarnessType`, not auto-detected by `intutic init`) | **QM** (`securityScreen` HTTP contract, served by a control plane), **Anthropic Managed Agents** (session-confirmation responder), **AWS Bedrock AgentCore Gateway** (interceptor Lambda that calls a control plane named in `INTUTIC_CONTROL_PLANE_URL`) |

---

## 📝 Write Your First SOP

Intutic governance rules are written as standard Markdown files under `.intutic/sops/` in your repository. A file can sit directly in `.intutic/sops/` (for example `.intutic/sops/safety.md`) or one folder down, one folder per rule set (for example `.intutic/sops/safety/rules.md`); the proxy reads both.

<!-- UNRELEASED:cloud
SOPs can also be workspace SOPs on a connected control plane. `intutic connect` reads both layouts too, and writes the SOPs into the file each harness reads, such as `.claude/rules/intutic-governance.md`, `.cursor/rules/intutic-governance.mdc` or a marked section of `AGENTS.md` (never `CLAUDE.md`).
-->

The front matter is what gets enforced; the prose below it is guidance the agent reads. Save this as `.intutic/sops/safety.md`:

```markdown
---
sql_guard: refuse
hook_rule: {"id": "safety.no-force-push", "tools": ["Bash"], "argContains": ["git push --force"], "reason": "Force-pushing rewrites shared history."}
hook_rule: {"id": "safety.no-recursive-delete", "tools": ["Bash"], "argContains": ["rm -rf"], "reason": "Recursive deletes need a human."}
---
# Safety Guardrails

1. **No secret leaks**: never print raw API keys or passwords.
2. **No force push**: `git push --force` is refused.
3. **No recursive deletes**: `rm -rf` is refused.
4. **No destructive SQL**: `DROP TABLE`, `TRUNCATE` and `DELETE` without `WHERE`, sent through `psql`, `mysql` or `sqlite3`, are refused.
```

The proxy refuses a `Bash` call whose arguments contain `git push --force` or `rm -rf` (each `hook_rule` matches the tool name exactly, so list the shell tool of every harness you route, such as `shell` or `run_shell_command`), and `sql_guard: refuse` refuses destructive SQL against any database not named in an `sql_allow_dsns:` line. Secret leaks are not a SOP key: the proxy's DLP scanner catches them (see [Policies › Enforcement](https://docs.intutic.ai/guide/policies#enforcement)). See [SOP Front Matter](https://docs.intutic.ai/reference/sop-front-matter) for every key.

---

<!-- UNRELEASED:cloud
## 💬 Interactive Slash Commands

Because Intutic evaluates prompts pre-flight, you can run interactive governance commands directly inside your agent chat. The proxy intercepts them before they reach the model, and a connected control plane answers them (open core alone has none, so standalone they reply that the command is unavailable):

```bash
/intutic status   # View this session's spend and compliance score
/intutic sops     # List the workspace's active SOPs
```

---
-->

## 📚 Documentation & Community

* 📖 **Developer Portal & API Reference:** [docs.intutic.ai](https://docs.intutic.ai)
* 🏗️ **Architecture & Contributor Guide:** [info.md](info.md)
* 🛠️ **WASM Rules SDK:** [`packages/wasm-sdk/`](packages/wasm-sdk/)
* 📦 **NPM Package Suite:**
  * [`@intutic/cli`](https://www.npmjs.com/package/@intutic/cli) — Developer onboarding CLI
  * [`@intutic/proxy`](https://www.npmjs.com/package/@intutic/proxy) — Native Rust proxy binary wrapper
  * [`@intutic/clawde`](https://www.npmjs.com/package/@intutic/clawde) — Programmatic TypeScript client SDK
  * [`@intutic/gate`](https://www.npmjs.com/package/@intutic/gate) — In-process tool-call gates for SDK-gated TypeScript frameworks
  * [`@intutic/mcp-governance-proxy`](https://www.npmjs.com/package/@intutic/mcp-governance-proxy) — Stdio JSON-RPC MCP proxy
  * [`@intutic/shared-types`](https://www.npmjs.com/package/@intutic/shared-types) — Zod-validated shared TypeScript types
  * [`@intutic/logger`](https://www.npmjs.com/package/@intutic/logger) and [`@intutic/id`](https://www.npmjs.com/package/@intutic/id) — Structured logging and prefixed IDs used across the packages
* 🐍 **Python:** [`intutic-clawde`](https://pypi.org/project/intutic-clawde/) — Client SDK and in-process gates for Python agent frameworks (LangGraph, CrewAI, Google ADK, Pydantic AI and the rest of the SDK-gated list above)

---

## ⭐ Star Us On GitHub

If you find Intutic useful, please give us a star on GitHub! It helps us support more agent harnesses and policy engines.

<div align="center">

[![Star on GitHub](https://img.shields.io/github/stars/intutic/intutic?style=for-the-badge&logo=github&color=24292e)](https://github.com/intutic/intutic)

</div>

---

<!-- UNRELEASED:self-host
## 🏢 Enterprise & Commercial Licensing

For custom VPC deployments, enterprise-grade SSO/SAML, dedicated SLA support, or team compliance auditing, visit [intutic.ai](https://intutic.ai) or contact us at [support@intutic.ai](mailto:support@intutic.ai).

---
-->

## 📄 License

This project is licensed under the [MIT License](LICENSE).
