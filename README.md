<div align="center">

# Intutic — Policy as Code for Continuous Compliance & Continuous Enforcement for AI Agents

**The circuit breaker for AI agents: your policies are files in git, enforced synchronously and in-process on every tool call across 39 agent harnesses.**

[![GitHub Stars](https://img.shields.io/github/stars/intutic/intutic?style=social)](https://github.com/intutic/intutic)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/Docs-docs.intutic.ai-6f42c1)](https://docs.intutic.ai)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)](https://github.com/intutic/intutic/actions)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/intutic/intutic/pulls)

[Quickstart](#-30-second-quickstart) • [Architecture](#%EF%B8%8F-architecture) • [Key Features](#-key-features) • [Supported Harnesses](#-supported-harnesses) • [Docs](https://docs.intutic.ai)

<br>

<img src="assets/demo.gif" alt="Intutic Hero Demo — Real-time AI Agent Circuit Breaker" width="100%">

</div>

---

## 💡 Why Intutic?

Existing AI observability tools (like LangSmith or Portkey) are **passive**. They record execution logs *after* an agent leaks a secret, deletes files, or loops into hundreds of dollars of API spend.

**Intutic is an active circuit breaker.** It sits in the tool-call path between your AI agents and local shell/production APIs. Every tool execution passes through an in-process policy evaluation chain — no model call, no network hop — blocking dangerous commands before they run and steering agentic loops in real time.

---

## 🏗️ Architecture

Intutic runs as a high-performance local or self-hosted proxy (written in Rust) alongside a lightweight bidirectional config sync daemon (`sync-daemon`):

```mermaid
flowchart TD
    subgraph DevEnvironment[" 💻 Developer Environment "]
        Agent["🤖 AI Coding Agent<br><i>(Claude Code, Cursor, Aider, LangGraph)</i>"]
        SOP["📝 Local SOP Rules<br><i>(CLAUDE.md / .cursorrules / SKILL.md)</i>"]
    end

    subgraph HotPathProxy[" ⚡ Intutic Hot-Path Proxy (:4000) "]
        Engine["🔒 WASM Policy Engine<br><i>(In-Process Evaluation)</i>"]
        DLP["🔐 Secret DLP & Masking"]
        PCAS["🛡️ PCAS Action Primitives<br><code>BYPASS</code> | <code>ENHANCE</code> | <code>HIJACK</code> | <code>REASK</code> | <code>KILL</code>"]
    end

    subgraph SyncDaemon[" 🔄 Sync Daemon "]
        Reconcile["Bidirectional Config Reconciler<br><i>(Harness Config Sync)</i>"]
    end

    subgraph UpstreamProviders[" 🌐 Upstream Providers "]
        Providers["Anthropic API / OpenAI / LiteLLM / Ollama"]
    end

    Agent -->|1. Tool Call / Prompt| HotPathProxy
    SOP -->|2. Rule Sync| Reconcile
    Reconcile -->|3. Hot-Reload Rules| Engine
    HotPathProxy -->|4. Clean Request| UpstreamProviders
    Engine -->|5. Block/Hijack Verdict| Agent
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

### 2. Connect Your Workspace
Run `intutic connect` inside your project folder. This boots the local high-speed Rust proxy on port `4000` and auto-detects installed coding assistants:
```bash
intutic connect
```

### 3. Route Any Agent to Intutic
Point your favorite LLM client or agent framework to the local proxy:
```bash
export ANTHROPIC_BASE_URL="http://localhost:4000/v1"
export OPENAI_BASE_URL="http://localhost:4000/v1"
```

That's it! Your agent is now governed by real-time safety guardrails.

---

## 🔥 Key Features

| Feature | Description |
| :--- | :--- |
| ⚡ **In-Process WASM Engine** | Policy evaluation runs in-process — no model call and no network hop — so it adds no round-trip to the tool-call path. |
| 🛡️ **Zero-Trust Tool Interception** | Intercepts dangerous commands (`rm -rf`, `git push --force`, `DROP TABLE`) before they touch your system. |
| 🔐 **Secret DLP & Masking** | Automatically redacts API keys (`[REDACTED_SECRET]`), AWS credentials, and tokens in prompts & tool payloads. |
| 💰 **Session Spend Ceilings** | Prevents "loop burn" by enforcing token spending ceilings per session (e.g. $5.00 limit). |
| 🔄 **39 Harness Adapters** | Pre-configured support for Claude Code CLI, Cursor, Windsurf, Aider, Antigravity, DeepSeek dsh, Spotify Xirp, DoorDash Agentic Orchestrator, AWS Bedrock AgentCore Runtime, and more. |
| 🤖 **Single & Multi-Agent Swarms** | Governs single developer tools as well as multi-agent graph/swarm workflows — LangGraph, LangChain, CrewAI, AutoGen, AG2, Google ADK, OpenAI Agents SDK, Pydantic AI, smolagents, and AWS Strands Agents each have a dedicated SDK-side gate (Python); Mastra and the Vercel AI SDK have the same on the TypeScript side (`@intutic/gate`). |

---

## 🛡️ The 5 PCAS Primitives

Every tool call and prompt evaluated by Intutic produces one of five **PCAS Action Primitives**:

```
 ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐
 │  BYPASS  │  │  ENHANCE  │  │   HIJACK   │  │  REASK   │  │   KILL   │
 └────┬─────┘  └─────┬─────┘  └─────┬──────┘  └────┬─────┘  └────┬─────┘
      │              │              │              │              │
      ▼              ▼              ▼              ▼              ▼
 Direct Pass    Inject Safety  Redact Secrets    Refuse &      Hard-Abort
 (In-Process)    Context SOP    or Swap Args    Bounded Retry  Runaway Loop
```

1. **`BYPASS`**: Standard safe execution passes through natively (in-process, no added network hop).
2. **`ENHANCE`**: Inject contextual SOP prompt rules or architectural guidelines.
3. **`HIJACK`**: Substitute dangerous tool parameters or redact secrets on the fly.
4. **`REASK`**: Refuse the attempt and hand the reason back to the agent, which may retry a bounded number of times before the finding escalates to a block.
5. **`KILL`**: Hard-abort execution thread if an agent attempts destructive file/git ops or hits loop caps.

---

## 🔌 Supported Harnesses & Frameworks

Intutic ships **39 harness adapters** that are auto-detected and config-synced without modifying your agent's source code. Anything else that speaks an OpenAI- or Anthropic-compatible API is governed the same way by pointing its base URL at the proxy:

| Category | Supported Tools & Frameworks |
| :--- | :--- |
| **Single-Agent Assistants** (native adapters) | **Claude Code CLI**, **Cursor**, **Windsurf**, **Aider**, **Antigravity**, **Cline**, **Roo Code**, **Codex**, **Continue**, **Claude Desktop**, **Goose**, **Pi**, **GitHub Copilot**, **OpenWebUI**, **Muse Code**, **Grok Build**, **dsh** (preview) |
| **Multi-Agent Swarms** (native adapters) | **LangGraph**, **OpenHands**, **OpenClaw**, **Hermes**, **n8n** |
| **Orchestrators** (delegate to already-gated harnesses, no gate of their own) | **Spotify Xirp**, **DoorDash Agentic Orchestrator**, **AWS Bedrock AgentCore Runtime** (hosts your own framework-SDK code unchanged; delegates to whichever already-supported framework adapter that code uses) |
| **SDK-gated frameworks** (dedicated in-process gate, `@intutic/gate`/`intutic-clawde`) | **LangChain**, **CrewAI**, **AutoGen**, **AG2**, **Google ADK**, **OpenAI Agents SDK**, **Pydantic AI**, **smolagents**, **AWS Strands Agents**, **Mastra**, **Vercel AI SDK**, **eve**, **AI SDK Harness**, **AI SDK Workflow** |
| **Any OpenAI-compatible framework** (no adapter needed) | Anything else honoring `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — launch it with `intutic exec` or export the base-URL env vars |
| **Server-side platform integrations** (call Intutic directly over HTTP; no `HarnessType`, not auto-detected by `intutic init`) | **QM** (`securityScreen` HTTP contract), **Anthropic Managed Agents** (session-confirmation responder), **AWS Bedrock AgentCore Gateway** (interceptor Lambda) |

---

## 📝 Write Your First SOP

Intutic governance rules are written in standard Markdown files inside your repository root (`CLAUDE.md`, `.cursorrules`, or `.windsurfrules`). Intutic automatically syncs and enforces them in real time:

```markdown
# Standard Operating Procedure (SOP): Safety Guardrails

## Rules
1. **No Secret Leaks**: Agents must never output raw API keys or passwords.
2. **File Boundaries**: Restrict file modifications to the current project directory.
3. **No Force Push**: Block `git push --force` on all branches.

## Denied Commands
- `rm -rf`
- `DROP TABLE`
- `TRUNCATE`
```

---

## 💬 Interactive Slash Commands

Because Intutic evaluates prompts pre-flight, you can run interactive governance commands directly inside your agent chat:

```bash
/intutic status   # View active session spend and compliance score
/intutic rules    # List active WASM & Markdown SOP rules
```

---

## 📚 Documentation & Community

* 📖 **Developer Portal & API Reference:** [docs.intutic.ai](https://docs.intutic.ai)
* 🏗️ **Architecture & Contributor Guide:** [info.md](info.md)
* 🛠️ **WASM Rules SDK:** [`packages/wasm-sdk/`](packages/wasm-sdk/)
* 📦 **NPM Package Suite:**
  * [`@intutic/cli`](https://www.npmjs.com/package/@intutic/cli) — Developer onboarding CLI
  * [`@intutic/proxy`](https://www.npmjs.com/package/@intutic/proxy) — Native Rust proxy binary wrapper
  * [`@intutic/clawde`](https://www.npmjs.com/package/@intutic/clawde) — Programmatic TypeScript client SDK
  * [`@intutic/mcp-governance-proxy`](https://www.npmjs.com/package/@intutic/mcp-governance-proxy) — Stdio JSON-RPC MCP proxy
  * [`@intutic/shared-types`](https://www.npmjs.com/package/@intutic/shared-types) — Zod-validated shared TypeScript types

---

## ⭐ Star Us On GitHub

If you find Intutic useful, please give us a star on GitHub! It helps us support more agent harnesses and policy engines.

<div align="center">

[![Star on GitHub](https://img.shields.io/github/stars/intutic/intutic?style=for-the-badge&logo=github&color=24292e)](https://github.com/intutic/intutic)

</div>

---

## 🏢 Enterprise & Commercial Licensing

For custom VPC deployments, enterprise-grade SSO/SAML, dedicated SLA support, or team compliance auditing, visit [intutic.ai](https://intutic.ai) or contact us at [support@intutic.ai](mailto:support@intutic.ai).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
