# Harness Security Matrix — Intutic Compliance Scope <Badge type="tip" text="Open-Core" />

> **Last updated:** Muse Code (20th), Grok Build (21st), dsh (22nd, developer preview), and Xirp (23rd harness) onboarding + worktree propagation (TD-390) complete  
> **Coverage:** 23 active harnesses

This document is the canonical reference for what Intutic enforces, how, and the gaps that remain per harness.

---

## Defense Vectors

| Vector | Mechanism | How it blocks | Scope |
|---|---|---|---|
| **A — Client Hook** | Pre-tool-use gate script; blocking contract varies by harness (exit code 2, `{"cancel":true}` on stdout, `{"decision":"deny"}` on stdout, a JS throw, a Python raise, or a Cordis waterfall `{kind:'deny'}` return) | Blocks before tool executes | 19 generated gates: Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Roo Code, OpenClaw, OpenHands, Goose, Antigravity, Hermes, Pi, Codex CLI, Muse Code, Grok Build, GitHub Copilot (agent hooks, Preview), Continue CLI, n8n (workflow-level, manual install), and Open-WebUI (prompt-level filter) — plus LangGraph's SDK-side gate (`intutic_clawde.gate`, not a generated file) and dsh's Cordis-plugin gate (`@intutic/gate/dsh`, a checked-in TypeScript module, also not a generated file). All 19 generated gates enforce ` WHERE ` (argPattern) rules against the serialized tool input; dsh's plugin enforces the same via `@intutic/gate`'s own Tier A1/A3. Xirp carries no gate of its own — it delegates entirely to whichever harness it wraps (`GateKind: 'delegated'`) |
| **B — Proxy Gate** | LLM request inspection at the API boundary | Blocks / audits before LLM sees the prompt | 17 of the 23 active harnesses (+ Windsurf via TLS MITM); see matrix. Muse Code is env-var/launcher-only (no persistent base-URL setting confirmed), dsh's `llm-pi-ai` route is selectable-but-not-default (see TD-370), and Xirp has no LLM egress of its own — none of these three are counted in this 17 |
| **C — Drift Guard** | File watcher + 30s poll cycle | Detects and restores tampered governance configs | 25 paths across all harnesses; every path is now also written into every discovered `git worktree` of a watched repo, not only the main checkout — see [Worktree Coverage](#worktree-coverage) |
| **D — Response Gate** | Proxy-side inspection of the LLM *response* before it is forwarded to the client | Withholds a model-emitted `tool_calls[]` naming a denied tool before the client's tool runner sees it | Every harness whose LLM traffic traverses the proxy (Vector B scope); harness-agnostic, no client hook required |

### Vector D — Response Gate

The response gate (`response_gate.rs`, open-core, default-on) is the product's only harness-agnostic **pre-execution** tool gate: because every response byte passes through the proxy before the client sees it, a denied tool call is refused before it ever reaches the harness's tool runner — no per-harness hook, no harness cooperation. It understands the Anthropic (`tool_use` blocks), OpenAI chat-completions (`tool_calls[]`), and OpenAI Responses (`function_call` output items) wire shapes, on both streaming and non-streaming paths. When a call is withheld, the agent receives an explicit in-band message that the call never ran, so it does not blindly retry.

It is fail-closed within a deliberate scope: the gate is inert unless the active role has a non-empty tool deny list; within that scope, a non-streaming body that will not parse as JSON is refused rather than forwarded (`fail_closed`, default `true`).

Known limits, stated precisely:

- **Streams are gated on tool NAME only.** OpenAI sends `function.name` on the first delta and dribbles the arguments out as JSON fragments across later chunks, so argument-level rules cannot be enforced mid-stream — argument-level matching is non-streaming-only.
- **Locally-originated tool calls are invisible to it.** A tool call that never traverses the proxy (e.g. issued directly by a local plugin or harness-internal logic) cannot be seen or withheld; Vectors A and C cover that surface.
- **Gemini's native `functionCall` parts are not matched** on either path; a request the proxy forwards to Gemini in its native shape is ungated by this vector.

---

## Worktree Coverage

Every project-tier governance file this product writes (Vectors A and C — the client hook/config
files themselves, and the drift guard that watches them) is untracked by convention: SOP content is
synced from the control plane, not committed to the repo. A `git worktree add`-created checkout has
its own independent working tree, so none of that untracked content existed in a worktree by
default — `writeConfigFiles`/`injectMcpServer` running against only the ONE `workspaceRoot` a daemon
instance was pointed at left every OTHER worktree of that same repo completely ungoverned, no matter
what the main checkout had configured. This predates and is broader than any single harness — Xirp
(row 22 below) is what surfaced it during this phase's research, because Xirp's whole model is
spawning CLI agents each inside its own tmux session + `git worktree`, but the fix benefits any
worktree-based workflow equally. See TD-390 for the full record.

**The fix:** `services/sync-daemon/src/lib/gitWorktrees.ts`'s `discoverWorktrees(repoRoot)` runs
`git worktree list --porcelain` every sync cycle (never cached across cycles) and the sync loop
writes the same project-tier files into every discovered worktree, in addition to the main checkout.
Locked worktrees are covered (locking only blocks git's own pruning, not ordinary file writes) and
prunable worktrees (git has flagged the directory itself missing) are excluded, so this cannot
resurrect a deleted worktree's folder. A worktree removed since the last cycle simply stops being
returned by `git worktree list` — no stale-entry cleanup logic is needed for removal to work.

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
| 8 | **Codex CLI** | ✅ codex-check.js | ✅ ~/.codex/config.toml | ✅ .env.intutic | Low | Blocking hook (exit 2) registered in `~/.codex/hooks.json` + `<repo>/.codex/hooks.json`; ` WHERE ` argPattern rules enforced against the serialized tool input. **Live-verified** (codex-cli 0.147.0, 2026-08-10): a real `codex exec` session fired the hook, the unpinned `kubectl apply` was refused before execution with the rule named, and the pinned/benign commands ran |
| 9 | **n8n** | ⚠️ Workflow-level gate | ✅ API-configurable | ✅ gatekeeper node | Medium | `n8n-governance-hook.js` via `EXTERNAL_HOOK_FILES` (manual, deployment-side): `workflow.preExecute` receives the full Workflow and **throws** to abort — genuinely blocking, but per workflow, not per tool call. Node type ≈ tool name; argPattern matches the serialized node parameters. **Live-verified** (official n8n image, 2026-08-10): a running server with `EXTERNAL_HOOK_FILES` aborted the offending workflow (HTTP 500, error naming node and rule) and passed the clean one — after two live-only bugs were found and fixed (the real `workflow.preExecute` passes `nodes` as an object keyed by name, not the documented array; and the product snapshot's space-padded patterns cannot match dot-namespaced node types) |
| 10 | **Continue** | ⚠️ continue-check.js (CLI, interactive mode only) | ✅ apiBase in config.yaml | ✅ config.yaml | Low | Blocking hook (exit 2) in `.continue/settings.json` for the CLI (`cn`); the IDE extension has no hook system. The CLI also reads `.claude/settings.json`. **Live-verified limits (cn 1.5.47):** headless `-p` runs do not execute PreToolUse hooks at all — a headless `cn` is proxy-governed only — and cn's hook dispatcher fails open on hook errors by its own design. argPattern rules enforced when the hook runs |
| 11 | **Goose** | ✅ Plugin PreToolUse | ✅ provider.host | ✅ Immutable plugin | HIGH | chmod 444 + OS immutable flags |
| 12 | **Antigravity** | ✅ antigravity-check.sh | ✅ Proxy native | ✅ .gemini/settings.json | Medium | Blocking hook (exit 2); drift guard added |
| 13 | **Claude Desktop** | ✅ claude-desktop-check.js | ❌ Locked to Anthropic | ✅ claude_desktop_config.json | Medium | Blocking hook (exit 2); drift guard detects rogue MCP servers |
| 14 | **Open-WebUI** | ⚠️ Prompt-level filter | ✅ Docker env | N/A | Low | intutic-governance-filter.py can refuse (Python raise), but filters see a prompt, not a tool call — only snapshot rules marked block refuse; the compiled floor flags |
| 15 | **OpenClaw** | ✅ openclaw-check.js | ✅ | ✅ openclaw.json | Medium | Full coverage |
| 16 | **Hermes** | ✅ hermes-check.sh | ✅ | ✅ config.yaml | Medium | Binds tool execution hooks |
| 17 | **Pi** | ✅ pre-tool hooks | ❌ | ✅ hooks.json | Medium | Intercepts at workspace root |
| 18 | **GitHub Copilot** | ⚠️ Preview hooks | ❌ | ✅ copilot-instructions.md | Low | `github-copilot-check.js` (exit 2) via VS Code agent hooks (`.github/hooks/*.json` + `~/.copilot/hooks`) — a **Preview** feature whose format may change; the gate refuses payloads it does not recognise, so a shift fails closed. Instructions file still merged. argPattern rules enforced. **Contract re-verified 2026-08-10** against the live VS Code docs (envelope, exit-2, both file locations, `chat.hookFilesLocations`); an end-to-end block inside a Copilot-subscribed agent session remains unverified — it needs an interactive editor with an entitlement |
| 19 | **LangGraph** | ✅ SDK-side (Python raise) | ✅ base_url / `intutic exec` | ✅ .env.intutic | Medium | Gate lives in the developer's code via `intutic_clawde.gate` (`guard_tools` / `@guard`), not a generated hook file — it sees the tool call's full arguments, so argPattern rules apply; traces attributed via `x-intutic-harness` |
| 20 | **Muse Code** | ⚠️ muse-check.js | ⚠️ env-var only | ✅ 3 paths | Medium | Blocking hook (exit 2, **ASSUMED contract — TD-362**) registered in `<repo>/.muse/hooks.json` AND via the pre-approved `managed_hooks_path` tier (`~/.config/muse/intutic-managed-hooks.json`, referenced from `~/.config/muse/settings.json`); covers both `PreToolUse` and `PermissionRequest`. No persistent proxy base-URL setting was confirmed — routing is `META_API_KEY`/launcher-flag only. The `muse` binary could not be installed to live-verify any of this (beta product, no public release channel found); see TD-362 |
| 21 | **Grok Build** | ✅ grok-check.js | ✅ config.toml `[model.*]` | ✅ .grok/hooks, config.toml, trusted_folders.toml | Medium | Blocking hook, `PreToolUse` with no matcher, registered in `.grok/hooks/intutic-governance.json` (project) and `~/.grok/hooks/intutic-governance.json` (user). **Confirmed** blocking contract: `{"decision":"deny","reason":"..."}` on stdout, exit 0 — a different stdout shape from Cline/Roo Code's `{"cancel":true}`, so this harness carries its own `stdout-decision-deny` contract rather than reusing theirs. **Double-gating note:** Grok Build also natively reads `.claude/settings.json` and `.cursor/hooks.json` if present, so a workspace already running either of those gates fires BOTH on a Grok Build tool call — expected, additive, not a bug (see [The gate backstop](/guide/mcp-governance#the-gate-backstop) for the same "both layers firing is expected" posture applied to the proxy+gate combination). **Not live-verified**: Grok Build was not installable in the environment this harness was implemented in, so the per-file hook-registration schema (`event`/`command`/`timeout` fields) is this integration's own reasonable design against the confirmed facts, not a byte-for-byte match against a real install |
| 22 | **dsh** <Badge type="warning" text="Preview" /> | ⚠️ `@intutic/gate/dsh` (Cordis plugin) | ⚠️ `llm-pi-ai` route only | ✅ .dsh/profiles, .dsh/settings.yaml | Medium | DeepSeek's "dsh" (developer preview since 2026-08-13) is plugin-first (Cordis) — the gate is a real, checked-in TypeScript module (`packages/gate-js/src/dsh.ts`), not a generated shell/JS string. Registers on the **confirmed** `tools/pre-execute` Cordis waterfall event (`@deepseek-ai/dsh-tools`'s shipped types), returning `{kind:'deny', reason}` to veto or calling `next()` to allow — genuinely novel among this matrix's contracts (`waterfall-reject`), not exit-code or stdout-JSON. Merge-written into EVERY existing `$DSH_HOME/profiles/*/cordis.patch.yml` (dsh has no single default profile — `--profile <name>` is required on every invocation). **Known gaps** (see TD-370): three of dsh's own packages (`dsh-permission`, `dsh-settings-local`, `dsh-fs-policy`) are npm-restricted and could not be inspected directly; `llm-pi-ai` (the settings.yaml route this integration merges into) is NOT dsh's default LLM route (`llm-deepseek` is) and mounts dormant until configured, so proxy coverage is selectable, not automatic; the plugin registration still needs a manual `dsh plugin --profile <name> add @intutic/gate` (or `pnpm install` in the profile directory) before it actually loads — a fail-loud gap, not fail-open; and a machine where dsh has never been run has no profile to register into until the user's first `dsh --profile <name>` run |
| 23 | **Xirp** | ⚪ N/A — delegated | ⚪ N/A — delegated | ⚪ N/A — delegated | Low | NOT itself an AI agent — a macOS orchestrator that spawns Claude Code/Codex/Gemini CLI, each in its own tmux session + `git worktree`, preserving each wrapped harness's native, unmodified config (per Xirp's own FAQ). No gate/config of its own to register: a tool call inside a Xirp session is governed by whichever wrapped harness's own row above is already running. What IS this harness's own contribution: it is what surfaced the [Worktree Coverage](#worktree-coverage) gap (TD-390) — before that fix, every wrapped harness's gate existed in the main checkout but not in the worktree the call actually ran in. **Not live-verified**: macOS-only beta with no installable artifact in this environment; detection paths (`~/.xirp`, `Xirp.app`) are this integration's own reasonable convention, not confirmed against a real install — see TD-391 |

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

### Muse Code
```bash
intutic connect --harness muse-code
```
Writes `AGENTS.md` (governance text — Muse falls back to `CLAUDE.md` if this is absent) and installs the `PreToolUse`/`PermissionRequest` gate at two tiers: `<repo>/.muse/hooks.json` (project) and the pre-approved `managed_hooks_path` tier — an Intutic-owned `~/.config/muse/intutic-managed-hooks.json`, referenced by a narrow merge into `~/.config/muse/settings.json` (`schema_version` and any other key you have set are preserved). MCP servers declared under `mcp_servers` in `settings.json` (both `stdio` and `streamable_http`) are proxy-wrapped the same way every other JSON-map harness's servers are. Skills under `~/.agents/skills` are already covered by the product's existing skill-scanning feature — nothing harness-specific was needed there. **The `muse` binary could not be installed to live-verify the block/deny wire contract, the `hooks.json` schema, or the `managed_hooks_path` semantics — see TD-362.**

### Grok Build
```bash
intutic connect --harness grok
```
Writes `AGENTS.md` (governance text) + `.grok/hooks/intutic-governance.json` (project) + `~/.grok/hooks/intutic-governance.json` (user) — a blocking `PreToolUse` hook with no matcher. Also merges `base_url` into every existing `[model.*]` table in `config.toml` at both project and user level (`XAI_API_KEY` remains the auth mechanism; only the endpoint is redirected). MCP servers declared under `[mcp_servers.*]` in either `config.toml` are proxy-wrapped the same way every other harness's `mcpServers` map is.

> **Double-gating:** Grok Build also natively executes `.claude/settings.json` and `.cursor/hooks.json` hooks if either is present in the workspace — so a project already connected to Claude Code or Cursor may already be partially governed under Grok Build before running `intutic connect --harness grok` at all. Connecting Grok Build natively adds its own gate on top; both firing on the same blocked call is expected (see the coverage matrix row above).

### dsh <Badge type="warning" text="Preview" />
```bash
intutic connect --harness dsh
```
Merge-writes an `intutic-governance` plugin row into every EXISTING `$DSH_HOME/profiles/*/cordis.patch.yml`, declares `@intutic/gate` in that profile's `package.json` dependencies, and merges an `intutic` route into `settings.yaml`'s `llm-pi-ai.providers`. See the [dsh integration guide](/integrations/dsh) for the manual `pnpm install`/`dsh plugin add` step this harness still needs before the gate actually loads, and TD-370 for what remains unconfirmed against DeepSeek's own npm-restricted packages.

### Xirp
```bash
intutic connect   # no --harness xirp step — see below
```
Writes nothing for Xirp itself. Connect the wrapped harness you actually use (Claude Code, Codex, …) against the **main checkout** of the repository Xirp will manage; the sync daemon's [worktree coverage](#worktree-coverage) then propagates that harness's own gate/config into every `git worktree` Xirp spins up from there, automatically, every sync cycle. See [apps/docs/integrations/xirp.md](/integrations/xirp) for the full detection/governance model and TD-390/TD-391 for what remains unconfirmed.

---

## Known Architectural Gaps (Permanent)

| Harness | Gap | Reason | Mitigation |
|---|---|---|---|
| **Cursor Agent/Composer** | No hook/proxy interception | Proprietary Cursor backend, hardcoded | Document-only: recommend Chat/Plan panel for governed workflows |
| **Claude Desktop** | No LLM proxy interception | Locked to Anthropic; no base-URL override | Blocking pre-tool hook (`claude-desktop-check.js`, exit 2) + drift guard watches config for rogue MCP servers |
| **Windsurf Cascade AI** | Cannot intercept without TLS MITM | No base URL field | TLS MITM via local CA (see windsurf-tls-mitm.md) |
| **n8n granularity & install** | Workflow-level, manual install | `EXTERNAL_HOOK_FILES` is read by the n8n server process at startup — the daemon cannot set another process's environment, and `workflow.preExecute` gates whole executions, not individual tool calls | `n8n-governance-hook.js` + INSTALL.md generated every sync; one offending node aborts the execution with an error naming the node and rule |
| **GitHub Copilot hook stability** | Agent hooks are Preview | The `.github/hooks/*.json` format may change between VS Code releases | The gate refuses stdin payloads it does not recognise (fail closed); instructions file remains as a fallback layer |
| **Muse Code proxy routing** | No persistent proxy base-URL setting confirmed in `settings.json` | Muse exposes a `--base-url` CLI flag and a `META_API_KEY` env var, but no equivalent persistent config key could be confirmed from available docs/source (beta product) | Document-only for now: route via the launcher flag or env var; the client hook (PreToolUse/PermissionRequest, both tiers) remains the primary enforcement surface regardless of egress routing |
