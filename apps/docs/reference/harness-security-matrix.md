# Harness Security Matrix — Intutic Compliance Scope <Badge type="tip" text="Open-Core" />

> **Last updated:** Phase 3 implementation complete  
> **Coverage:** 19 active harnesses

This document is the canonical reference for what Intutic enforces, how, and the gaps that remain per harness.

---

## Defense Vectors

| Vector | Mechanism | How it blocks | Scope |
|---|---|---|---|
| **A — Client Hook** | Pre-tool-use gate script; blocking contract varies by harness (exit code 2, `{"cancel":true}` on stdout, a JS throw, or Python raise) | Blocks before tool executes | 17 generated gates: Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Roo Code, OpenClaw, OpenHands, Goose, Antigravity, Hermes, Pi, Codex CLI, GitHub Copilot (agent hooks, Preview), Continue CLI, n8n (workflow-level, manual install), and Open-WebUI (prompt-level filter) — plus LangGraph's SDK-side gate (`intutic_clawde.gate`, not a generated file). All generated gates enforce ` WHERE ` (argPattern) rules against the serialized tool input |
| **B — Proxy Gate** | LLM request inspection at the API boundary | Blocks / audits before LLM sees the prompt | 16 of the 19 active harnesses (+ Windsurf via TLS MITM); see matrix |
| **C — Drift Guard** | File watcher + 30s poll cycle | Detects and restores tampered governance configs | 19 paths across all harnesses |
| **D — Response Gate** | Proxy-side inspection of the LLM *response* before it is forwarded to the client | Withholds a model-emitted `tool_calls[]` naming a denied tool before the client's tool runner sees it | Every harness whose LLM traffic traverses the proxy (Vector B scope); harness-agnostic, no client hook required |

### Vector D — Response Gate

The response gate (`response_gate.rs`, open-core, default-on) is the product's only harness-agnostic **pre-execution** tool gate: because every response byte passes through the proxy before the client sees it, a denied tool call is refused before it ever reaches the harness's tool runner — no per-harness hook, no harness cooperation. It understands the Anthropic (`tool_use` blocks), OpenAI chat-completions (`tool_calls[]`), and OpenAI Responses (`function_call` output items) wire shapes, on both streaming and non-streaming paths. When a call is withheld, the agent receives an explicit in-band message that the call never ran, so it does not blindly retry.

It is fail-closed within a deliberate scope: the gate is inert unless the active role has a non-empty tool deny list; within that scope, a non-streaming body that will not parse as JSON is refused rather than forwarded (`fail_closed`, default `true`).

Known limits, stated precisely:

- **Streams are gated on tool NAME only.** OpenAI sends `function.name` on the first delta and dribbles the arguments out as JSON fragments across later chunks, so argument-level rules cannot be enforced mid-stream — argument-level matching is non-streaming-only.
- **Locally-originated tool calls are invisible to it.** A tool call that never traverses the proxy (e.g. issued directly by a local plugin or harness-internal logic) cannot be seen or withheld; Vectors A and C cover that surface.
- **Gemini's native `functionCall` parts are not matched** on either path; a request the proxy forwards to Gemini in its native shape is ungated by this vector.

---

## Coverage Matrix

| # | Harness | Hook (A) | Proxy (B) | Drift Guard (C) | Self-Mod Risk | Notes |
|---|---|:---:|:---:|:---:|---|---|
| 1 | **Claude Code** | ✅ PreToolUse | ✅ | ✅ settings.json | Medium | Full coverage |
| 2 | **Cursor Chat/Plan** | ✅ 3-level hooks.json | ✅ | ✅ 3 paths | HIGH | Agent/Composer mode: see §Gaps |
| 3 | **Windsurf** | ✅ Shell/MCP hooks | ✅ TLS MITM | ✅ 2 paths | HIGH | Cascade traffic via TLS MITM proxy |
| 4 | **Cline** | ✅ .cline/hooks/ | ✅ VS Code settings | ✅ hooks.json | HIGH | Dual proxy injection |
| 5 | **Roo Code** | ✅ .intutic/hooks/roo-check.js | ✅ VS Code settings | ✅ .roorules | HIGH | Blocking hook — refuses via `{"cancel":true}` on stdout |
| 6 | **Aider** | ❌ No pre-edit hook | ✅ openai-api-base | ✅ .aider.conf.yml | HIGH | test-cmd/lint-cmd suppressed. The only native mechanism is the opt-in `--git-commit-verify` pre-commit hook — post-edit and blind to `/run`, so no gate is built on it |
| 7 | **OpenHands** | ✅ .openhands/hooks.json | ✅ llm.base_url | ✅ hooks.json | HIGH | Shell script hook, fail-closed |
| 8 | **Codex CLI** | ✅ codex-check.js | ✅ ~/.codex/config.toml | ✅ .env.intutic | Low | Blocking hook (exit 2) registered in `~/.codex/hooks.json` + `<repo>/.codex/hooks.json`; ` WHERE ` argPattern rules enforced against the serialized tool input |
| 9 | **n8n** | ⚠️ Workflow-level gate | ✅ API-configurable | ✅ gatekeeper node | Medium | `n8n-governance-hook.js` via `EXTERNAL_HOOK_FILES` (manual, deployment-side): `workflow.preExecute` receives the full Workflow and **throws** to abort — genuinely blocking, but per workflow, not per tool call. Node type ≈ tool name; argPattern matches the serialized node parameters |
| 10 | **Continue** | ✅ continue-check.js (CLI only) | ✅ apiBase in config.yaml | ✅ config.yaml | Low | Blocking hook (exit 2) in `.continue/settings.json` for the CLI (`cn`); the IDE extension has no hook system. The CLI also reads `.claude/settings.json`, so claude-code users may already run that gate — the dedicated registration covers users without it. argPattern rules enforced |
| 11 | **Goose** | ✅ Plugin PreToolUse | ✅ provider.host | ✅ Immutable plugin | HIGH | chmod 444 + OS immutable flags |
| 12 | **Antigravity** | ✅ antigravity-check.sh | ✅ Proxy native | ✅ .gemini/settings.json | Medium | Blocking hook (exit 2); drift guard added |
| 13 | **Claude Desktop** | ✅ claude-desktop-check.js | ❌ Locked to Anthropic | ✅ claude_desktop_config.json | Medium | Blocking hook (exit 2); drift guard detects rogue MCP servers |
| 14 | **Open-WebUI** | ⚠️ Prompt-level filter | ✅ Docker env | N/A | Low | intutic-governance-filter.py can refuse (Python raise), but filters see a prompt, not a tool call — only snapshot rules marked block refuse; the compiled floor flags |
| 15 | **OpenClaw** | ✅ openclaw-check.js | ✅ | ✅ openclaw.json | Medium | Full coverage |
| 16 | **Hermes** | ✅ hermes-check.sh | ✅ | ✅ config.yaml | Medium | Binds tool execution hooks |
| 17 | **Pi** | ✅ pre-tool hooks | ❌ | ✅ hooks.json | Medium | Intercepts at workspace root |
| 18 | **GitHub Copilot** | ⚠️ Preview hooks | ❌ | ✅ copilot-instructions.md | Low | `github-copilot-check.js` (exit 2) via VS Code agent hooks (`.github/hooks/*.json` + `~/.copilot/hooks`) — a **Preview** feature whose format may change; the gate refuses payloads it does not recognise, so a shift fails closed. Instructions file still merged. argPattern rules enforced |
| 19 | **LangGraph** | ✅ SDK-side (Python raise) | ✅ base_url / `intutic exec` | ✅ .env.intutic | Medium | Gate lives in the developer's code via `intutic_clawde.gate` (`guard_tools` / `@guard`), not a generated hook file — it sees the tool call's full arguments, so argPattern rules apply; traces attributed via `x-intutic-harness` |

---

## Per-Harness Onboarding Guide

### Claude Code
```bash
intutic connect --harness claude-code
```
Writes `.claude/settings.json` + `~/.claude/settings.json` with `permissions.deny` rules and `PreToolUse` hooks. Hook script at `.intutic/hooks/claude-code-check.js`. Drift guard watches both paths.

### Cursor
```bash
intutic connect --harness cursor
```
Writes `.cursorrules` (governance text) + `.cursor/hooks.json` (project) + `~/.cursor/hooks.json` (user).

### Windsurf
```bash
intutic connect --harness windsurf
```
Writes `.windsurfrules` + `~/.codeium/windsurf/hooks.json` + `.windsurf/hooks.json`. Also configures `~/.codeium/windsurf/settings.json` with `http.proxy` pointing to the Intutic TLS MITM proxy (port 8877). Cascade AI traffic is governed via the proxy.

> **Important:** The Intutic CA cert must be trusted for TLS MITM to work:
> ```bash
> intutic init   # Generates CA cert and injects into user trust store
> ```

### Cline
```bash
intutic connect --harness cline
```
Writes `.clinerules` (governance text) + `.cline/hooks/hooks.json` (blocking PreToolUse hook). Also injects `cline.apiBase` and `cline.openAiBaseUrl` into VS Code settings + `~/.intutic/.env.intutic` sidecar.

### Aider
```bash
intutic connect --harness aider
```
Writes `.aider.conf.yml` with `openai-api-base` and `anthropic-api-base` set to the Intutic proxy. **Strips `test-cmd` and `lint-cmd` if present** (these are auto-executed on startup and represent the highest Aider privilege escalation risk). Strip events are logged to the control plane audit feed.

### OpenHands
```bash
intutic connect --harness openhands
```
Writes `config.toml` with `[llm] base_url` and `[intutic]` SOP section. Also writes `.openhands/hooks.json` with `PreToolUse` shell hook (fail-closed).

### Goose
```bash
intutic connect --harness goose
```
Writes `~/.agents/plugins/intutic-governance/hooks/hooks.json` + `scripts/intutic-check.sh`. Applies `chmod 444` + `chflags uchg` (macOS) or `chattr +i` (Linux) to make plugin files immutable. Also merges `provider.host` into `~/.config/goose/config.yaml`.

---

## Known Architectural Gaps (Permanent)

| Harness | Gap | Reason | Mitigation |
|---|---|---|---|
| **Cursor Agent/Composer** | No hook/proxy interception | Proprietary Cursor backend, hardcoded | Document-only: recommend Chat/Plan panel for governed workflows |
| **Claude Desktop** | No LLM proxy interception | Locked to Anthropic; no base-URL override | Blocking pre-tool hook (`claude-desktop-check.js`, exit 2) + drift guard watches config for rogue MCP servers |
| **Windsurf Cascade AI** | Cannot intercept without TLS MITM | No base URL field | TLS MITM via local CA (see windsurf-tls-mitm.md) |
| **n8n granularity & install** | Workflow-level, manual install | `EXTERNAL_HOOK_FILES` is read by the n8n server process at startup — the daemon cannot set another process's environment, and `workflow.preExecute` gates whole executions, not individual tool calls | `n8n-governance-hook.js` + INSTALL.md generated every sync; one offending node aborts the execution with an error naming the node and rule |
| **GitHub Copilot hook stability** | Agent hooks are Preview | The `.github/hooks/*.json` format may change between VS Code releases | The gate refuses stdin payloads it does not recognise (fail closed); instructions file remains as a fallback layer |
