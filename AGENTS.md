# AGENTS.md — intutic (Open-Core Developer Sandbox)

This file is the **machine-readable** entry point for AI coding agents working in this repository. Humans should start at [`README.md`](README.md). Agents: read this top-to-bottom **before touching code**.

## Read these first

1. [`CLAUDE.md`](CLAUDE.md) — active governance SOPs and rules for this workspace.
2. [`README.md`](README.md) — project overview, quick start, tech stack.
3. [`apps/docs/`](apps/docs/) — Developer Portal & API documentation source.

## Layout (quick mental model)

| Path | What lives there |
|------|-------------------|
| [`packages/shared-types/`](packages/shared-types/) | TypeScript types, interfaces, enums shared across packages |
| [`packages/logger/`](packages/logger/) | Structured logging with trace context |
| [`packages/id/`](packages/id/) | `newId(prefix)`, `newIso()` — never use raw UUIDs or Date.now() |
| [`packages/theme/`](packages/theme/) | Central design system tokens, fonts, and assets |
| [`packages/proxy/`](packages/proxy/) | LiteLLM-Rust proxy wrapper, WASM filters, and protocol normalization |
| [`packages/clawde-sdk/`](packages/clawde-sdk/) | TypeScript SDK for Claude agent integration |
| [`packages/intutic-clawde/`](packages/intutic-clawde/) | Python SDK for Claude agent integration |
| [`packages/mcp-proxy/`](packages/mcp-proxy/) | Model Context Protocol governance proxy |
| [`packages/wasm-sdk/`](packages/wasm-sdk/) | Rust WASM SDK for custom proxy policy filters |
| [`services/sync-daemon/`](services/sync-daemon/) | Bidirectional config sync daemon (SOPs → harness) |
| [`tools/cli/`](tools/cli/) | Developer CLI tool (`@intutic/cli`) |
| [`apps/docs/`](apps/docs/) | Developer Portal — VitePress docs site (docs.intutic.ai) |

## Commands cheat sheet

```bash
# Install dependencies
pnpm install

# Start local dev stack (Valkey cache)
docker compose up -d

# Build all packages
pnpm run build

# Run unit tests
pnpm test

# Run Rust proxy tests
cargo test --package intutic-proxy

# Quality checks
pnpm run lint
pnpm run typecheck

# Generate docs site locally
pnpm run docs
```

## House rules (don't relearn the hard way)

- **Shared types:** All types used by 2+ packages go in `@intutic/shared-types`. Never duplicate.
- **API Contracts:** Always update Zod schemas and TypeScript type definitions in `@intutic/shared-types` when modifying payload schemas or query filters.
- **IDs:** Always use `newId(prefix)` from `@intutic/id`. Never use raw UUIDs or `Date.now()`.
- **Timestamps:** Always use `newIso()` from `@intutic/id`. Never use `Date.now()` directly.
- **Testing:** Zero `vi.mock` in core library unit tests where possible.
- **Design System Compliance:** All styling must strictly utilize CSS custom variables from `globals.css` and `glass.css`. Hardcoded hex codes and color functions are prohibited inside component CSS files.
- **Docker Compose Decoupling:** `docker-compose.yml` in this open-core repository must remain Valkey-only (`valkey:8` on port 6379).

## High-value `rg` patterns

```bash
# Find all CLI command definitions
rg "\.command\(" tools/cli/src -n

# Find proxy plugin implementations
rg "impl Plugin for" packages/proxy/src -n

# Find WASM filter exports
rg "pub fn evaluate" packages/proxy/src -n

# Find ID generation
rg "newId\(|newIso\(\)" -n
```

## Open-Core Contribution & Pull Requests

Community contributions, bug fixes, and improvements are welcome! Please ensure:
1. All TypeScript packages compile cleanly (`pnpm typecheck`).
2. Rust unit tests pass cleanly (`cargo test --package intutic-proxy`).
3. New features include corresponding unit tests under `__tests__` or Rust `tests/`.
