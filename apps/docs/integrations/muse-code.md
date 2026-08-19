# Muse Code

Integrate Intutic governance with [Muse Code](https://ai.meta.com/) — Meta's beta terminal coding agent (binary `muse`, model Muse Spark, beta since 2026-08-05).

::: tip Not live-verified — beta, no public release channel
The `muse` binary could not be installed in the environment this integration was built in (no `npm`/`pip`/Homebrew entry, no PATH-installable artifact, no documented fixture-runner to substitute for one). Everything below the hook block/deny wire contract in particular is stated as an **assumption**, not a confirmed fact — see TD-362 in `docs/TECH_DEBT.md` and the callout further down this page. This is the same honesty posture the Grok Build and Xirp pages already carry for their own unconfirmed pieces.
:::

## How it works

Muse Code reads project rules from `AGENTS.md`, falling back to `CLAUDE.md` if `AGENTS.md` is absent — the shared markdown rules-file convention this product already reuses for every text-rules harness (the same `buildMarkdownContent` builder Claude Code's own `CLAUDE.md` adapter calls, so Muse does not grow a second rules format).

The governance-critical half — hook registration and MCP proxy-wrapping — is written by the sync daemon's `museHooks.ts`, the same split Goose's plugin installer uses. Hooks are registered at **two tiers**:

- **Project-level:** `<repo>/.muse/hooks.json`
- **Managed (pre-approved) tier:** an Intutic-owned `~/.config/muse/intutic-managed-hooks.json`, referenced by a narrow merge into `~/.config/muse/settings.json`'s `managed_hooks_path` key. Per the phase brief this tier exists so a hook registered through it does not trigger a user trust/approval prompt the way a plain user-level `hooks.json` entry would — taken as given, not exercised against a real `muse` process.

Both tiers are written every sync cycle for defense in depth: `managed_hooks_path` is a single global setting, so a machine where it has not landed yet (first sync, or a failed settings.json write) still gets project-scoped coverage the same cycle.

Muse Code exposes twelve lifecycle hook events; only two are blocking, and both are registered against the same gate script:

- `PreToolUse`
- `PermissionRequest`

## Setup

### 1. Muse Code detection

Muse Code is detected by any of:
- A `.muse/` directory in the project, **or**
- `~/.config/muse/settings.json` existing (installed but never run in this workspace), **or**
- The `muse` binary being found in your `PATH`

No config file needs to exist beforehand.

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • muse-code → AGENTS.md
```

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect --harness muse-code` instead. It starts the same proxy and adds bidirectional config sync.

### 4. LLM egress — launcher/env-var only, not a persistent setting

Muse exposes a `META_API_KEY` env var and a `--base-url` CLI flag for routing model traffic, but **no persistent proxy base-URL key could be confirmed** in `settings.json` from available docs/source. This is a materially different situation from every SDK-gated framework on this site: there, the gap is "which provider is proxy-routable"; here, the gap is "whether Muse Code has a config-file-level proxy setting at all." Route via the launcher flag or the env var per-invocation if you want LLM egress governed; do not expect `intutic init`/`intutic connect` to write one into `settings.json` for you — nothing is written for egress today. The client hook (`PreToolUse`/`PermissionRequest`, both tiers) is the primary, confirmed enforcement surface regardless of how (or whether) egress is routed.

## What gets written

- **Rules file:** `AGENTS.md` — governance text, same shared builder every markdown-rules harness uses. Muse falls back to `CLAUDE.md` if `AGENTS.md` is absent from the project.
- **Hook registration:** `<repo>/.muse/hooks.json` (project tier) and `~/.config/muse/intutic-managed-hooks.json` (managed tier, referenced via `managed_hooks_path` in `~/.config/muse/settings.json`). Both are assumed to share the same `{ hooks: { <Event>: [{ matcher, hooks: [{ type, command }] }] } }` shape `codexHooks.ts` established for Codex's `hooks.json` — the closest architectural analog, not a confirmed Muse-specific schema.
- **Hook script:** `.intutic/hooks/muse-check.js` — the same shared gate evaluator (compiled protection floor + policy snapshot + ` WHERE `/argPattern rules) every other JavaScript-family harness in this product runs, registered for both `PreToolUse` and `PermissionRequest`.
- **`~/.config/muse/settings.json`:** narrow merge-write — only `managed_hooks_path` is set/updated; `schema_version` (defaulted to `1` if the file is new) and everything else (`mcp_servers`, any user-set key) is preserved.
- **MCP servers:** entries under `mcp_servers` in `settings.json` (both `stdio` and `streamable_http` transports) are proxy-wrapped the same way every other JSON-map harness's servers are — though the `streamable_http` entry shape itself is an assumption; see the callout below.
- **Skills:** `~/.agents/skills` is already covered by this product's existing skill-scanning feature — nothing Muse-specific was needed there.

## Pre-tool hooks (blocking, but the block contract is ASSUMED)

Muse's own documentation confirms that `PreToolUse` and `PermissionRequest` are blocking lifecycle hooks, but does not state **how** a hook signals a refusal. `muse-check.js` uses **exit code 2** — the same contract `codexHooks.ts` uses for Codex — because it is the closest architectural analog (a JS gate reading JSON on stdin, registered at a project-level and a user-scoped `hooks.json`), not because it has been observed against a real `muse` process. If the real contract turns out to be a JSON object on stdout instead, every Muse Code block today exits 2 with nothing on stdout — which a stdout-reading harness would treat identically to an ALLOW. State this plainly to anyone relying on this integration in production: it would look correct in every test this repository runs (which drives the emitted script directly and asserts on its exit code) while doing nothing against the real product.

Every decision is appended to `.intutic/events/hook-events.jsonl` and drained to the control plane, same as every other harness — that audit trail itself does not depend on which block contract turns out to be correct.

::: warning Four assumptions, not four facts — see TD-362
1. **The block/deny wire contract** — exit code 2, copied from Codex, not confirmed for Muse.
2. **The `hooks.json` schema** — the `{ hooks: { <Event>: [...] } }` shape is Codex's, assumed to transfer.
3. **`managed_hooks_path`'s actual behaviour** — whether it is additive to the project/user tiers or overrides them, and whether it is read once at startup or on every hook-eligible call, is unconfirmed.
4. **The `mcp_servers` entry shape for `streamable_http`** — assumed `url`/`headers`-keyed, matching every other JSON-map harness's remote-transport convention; if Muse nests it differently, the entry is silently left unwrapped rather than erroring.

Each is a small, isolated edit in `museHooks.ts`/`mcpAutoWrite.ts` once a real install is available to test against. See TD-362 in `docs/TECH_DEBT.md` for the full record and what would close it.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `muse-code` |
| Config file | `AGENTS.md` (falls back from/to `CLAUDE.md`) |
| Hook files | `<repo>/.muse/hooks.json`, `~/.config/muse/intutic-managed-hooks.json`, `~/.config/muse/settings.json` (`managed_hooks_path` merge), `.intutic/hooks/muse-check.js` |
| Detection | `.muse/` or `muse` in `PATH`, or `~/.config/muse/settings.json` present |
| Format | Markdown (rules), JSON (hooks/settings) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Block contract | Exit code 2 — **ASSUMED**, copied from Codex's confirmed contract, not verified against a real `muse` install |
| LLM egress | `META_API_KEY` env var / `--base-url` flag — launcher-only; no persistent `settings.json` key confirmed, nothing written by `intutic init`/`intutic connect` |
