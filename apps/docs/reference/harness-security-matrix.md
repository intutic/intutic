# Harness Security Matrix — Intutic Compliance Scope <Badge type="tip" text="Open-Core" />

> **Last updated:** Phase 3 implementation complete  
> **Coverage:** 18 active harnesses

This document is the canonical reference for what Intutic enforces, how, and the gaps that remain per harness.

---

## Defense Vectors

| Vector | Mechanism | How it blocks | Scope |
|---|---|---|---|
| **A — Client Hook** | Pre-tool-use script, exit code 2 | Blocks before tool executes | Claude Code, Cursor, Windsurf, Cline, OpenHands, Goose |
| **B — Proxy Gate** | LLM request inspection at the API boundary | Blocks / audits before LLM sees the prompt | All 14 active harnesses (+ Windsurf via TLS MITM) |
| **C — Drift Guard** | File watcher + 30s poll cycle | Detects and restores tampered governance configs | 17 paths across all harnesses |

---

## Coverage Matrix

| # | Harness | Hook (A) | Proxy (B) | Drift Guard (C) | Self-Mod Risk | Notes |
|---|---|:---:|:---:|:---:|---|---|
| 1 | **Claude Code** | ✅ PreToolUse | ✅ | ✅ settings.json | Medium | Full coverage |
| 2 | **Cursor Chat/Plan** | ✅ 3-level hooks.json | ✅ | ✅ 3 paths | HIGH | Agent/Composer mode: see §Gaps |
| 3 | **Windsurf** | ✅ Shell/MCP hooks | ✅ TLS MITM | ✅ 2 paths | HIGH | Cascade traffic via TLS MITM proxy |
| 4 | **Cline** | ✅ .cline/hooks/ | ✅ VS Code settings | ✅ hooks.json | HIGH | Dual proxy injection |
| 5 | **Roo Code** | ⚠️ Notify-only | ✅ VS Code settings | ✅ .roorules | HIGH | No blocking hooks in Roo Code yet |
| 6 | **Aider** | ❌ No hook system | ✅ openai-api-base | ✅ .aider.conf.yml | HIGH | test-cmd/lint-cmd suppressed |
| 7 | **OpenHands** | ✅ .openhands/hooks.json | ✅ llm.base_url | ✅ hooks.json | HIGH | Shell script hook, fail-closed |
| 8 | **Codex CLI** | ❌ No hook system | ✅ ~/.codex/config.toml | ✅ .env.intutic | Low | Two config files written |
| 9 | **n8n** | ⚠️ Mgmt-level only | ✅ API-configurable | ✅ gatekeeper node | Medium | Per-exec gate via IF/Code node |
| 10 | **Continue** | ❌ No hook system | ✅ apiBase in config.yaml | ✅ config.yaml | Low | Proxy-only |
| 11 | **Goose** | ✅ Plugin PreToolUse | ✅ provider.host | ✅ Immutable plugin | HIGH | chmod 444 + OS immutable flags |
| 12 | **Antigravity** | ❌ No hook API | ✅ Proxy native | ✅ .gemini/settings.json | Medium | Proxy-native; drift guard added |
| 13 | **Claude Desktop** | ❌ No hooks | ❌ Locked to Anthropic | ✅ claude_desktop_config.json | Medium | Drift guard detects rogue MCP servers |
| 14 | **Open-WebUI** | ❌ Docker service | ✅ Docker env | N/A | Low | Document Docker env pattern |
| 15 | **OpenClaw** | ✅ pre-tool-check | ✅ | ✅ openclaw.json | Medium | Full coverage |
| 16 | **Hermes** | ✅ hermes-check.sh | ✅ | ✅ config.yaml | Medium | Binds tool execution hooks |
| 17 | **Pi** | ✅ pre-tool hooks | ❌ | ✅ hooks.json | Medium | Intercepts at workspace root |
| 18 | **GitHub Copilot** | ❌ Instructions-only | ❌ | ✅ copilot-instructions.md | Low | Merge active SOP rules |

---

## Per-Harness Onboarding Guide

### Claude Code
```bash
intutic connect --harness claude-code
```
Writes `.claude/settings.json` + `~/.claude/settings.json` with `permissions.deny` rules and `PreToolUse` hooks. Hook script at `.intutic/hooks/pre-tool-check.js`. Drift guard watches both paths.

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
| **Claude Desktop** | No hooks, no proxy | Locked to Anthropic; no hook API | Drift guard watches config for rogue MCP servers |
| **Windsurf Cascade AI** | Cannot intercept without TLS MITM | No base URL field | TLS MITM via local CA (see windsurf-tls-mitm.md) |
| **Roo Code client hooks** | Notification-only | No blocking hook API in current release | Proxy + drift guard; update when Roo Code adds blocking hooks |
| **n8n per-execution hooks** | Management-level only | EXTERNAL_HOOK_FILES applies globally not per-execution | Inject IF/Code gatekeeper node into each governed workflow |
