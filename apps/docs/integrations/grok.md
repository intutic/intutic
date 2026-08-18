# Grok Build

Integrate Intutic governance with [Grok Build](https://x.ai/) — xAI's terminal coding agent (binary `grok`, GA since 2026-05, open-sourced 2026-07-15).

## How it works

Grok Build reads project rules from `AGENTS.md` — the same cross-tool rules-file convention Codex/Amp read — and executes `PreToolUse` hooks registered as individual JSON files under `.grok/hooks/`. Intutic writes a blocking hook there, plus merges the local proxy `base_url` into `config.toml`'s `[model.*]` tables so LLM traffic routes through governance without needing an env var sourced first.

## Setup

### 1. Grok Build detection

Grok Build is detected by any of:
- A `.grok/` directory or `AGENTS.md` in the project, **or**
- A `~/.grok/` directory (Grok Build installed and run at least once), **or**
- The `grok` binary being found in your `PATH`

No config file needs to exist beforehand.

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • grok → AGENTS.md
```

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

- **Rules file:** `AGENTS.md` — governance text, formatted the same `---`-separated way as `.cursorrules`/`CLAUDE.md`/`.windsurfrules`.
- **Hook registration:** `.grok/hooks/intutic-governance.json` (project) and `~/.grok/hooks/intutic-governance.json` (user) — a `PreToolUse` entry with no matcher, so every tool call is evaluated. Grok Build's hook directory is a glob of independent files, so this write never touches any other hook file you may already have there.
- **Hook script:** `.intutic/hooks/grok-check.js` — the same shared gate evaluator (compiled protection floor + policy snapshot + ` WHERE `/argPattern rules) every other JavaScript-family harness in this product runs.
- **LLM egress:** `base_url` merged into every existing `[model.*]` table in `config.toml`, at both `<repo>/.grok/config.toml` and `~/.grok/config.toml`. `XAI_API_KEY` remains the auth mechanism — only the endpoint moves.
- **MCP servers:** any `[mcp_servers.*]` table in either `config.toml` is proxy-wrapped the same way every other harness's `mcpServers` map is (stdio entries wrapped with `--`, remote/`url`-keyed entries bridged with `--remote-url`/`--remote-transport`).

## Pre-tool hooks (blocking)

Grok Build's `PreToolUse` hook contract is **confirmed**, not assumed: the hook process writes `{"decision":"deny","reason":"..."}` as JSON on **stdout** and exits 0 to signal a block — a different shape from Cline/Roo Code's `{"cancel":true}`, so Intutic's gate for this harness carries its own dedicated block contract rather than reusing theirs. An allow prints nothing and exits 0. The default hook `timeout` is 5s, ample for a local policy-snapshot evaluation.

Every decision is appended to `.intutic/events/hook-events.jsonl` and drained to the control plane, same as every other harness.

::: warning Double-gating with Claude Code / Cursor compatibility hooks
Grok Build also natively executes `.claude/settings.json` hooks and
`.cursor/hooks.json` hooks if either is present in the workspace — a
compatibility feature of Grok Build itself, not something Intutic adds. If a
project is already connected to Claude Code or Cursor, that gate may already
be evaluating Grok Build's tool calls *before* you ever run `intutic connect
--harness grok`. Connecting Grok Build natively adds a second, independent
gate on top of that: a call blocked by either fires that gate's own refusal,
and an operator may see the same block logged twice (once per gate). Neither
gate is aware of the other's decision — this is the same "additive, not
exclusive" posture the [MCP gate backstop](/guide/mcp-governance#the-gate-backstop)
already documents for the proxy+gate combination, applied here to two client
hooks instead of a proxy and a hook. It is redundancy, not a discrepancy to
reconcile, and it cannot silently under-enforce: a call is blocked if either
gate says so.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `grok` |
| Config file | `AGENTS.md` |
| Hook files | `.grok/hooks/intutic-governance.json`, `~/.grok/hooks/intutic-governance.json`, `.intutic/hooks/grok-check.js` |
| Detection | `.grok/` or `AGENTS.md` in the project, `~/.grok/`, or `grok` in `PATH` |
| Format | Markdown (rules), TOML (`config.toml`) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Block contract | `{"decision":"deny","reason":"..."}` on stdout, exit 0 — confirmed |

::: tip Not live-verified
Grok Build was not installable in the environment this integration was built
and tested in. The blocking contract above is independently confirmed from
Grok Build's own documentation; the exact per-file hook-registration schema
(the `event`/`command`/`timeout` fields Intutic writes into
`intutic-governance.json`) is this integration's own reasonable design
against those confirmed facts, not a byte-for-byte match pinned against a
real install.
:::
