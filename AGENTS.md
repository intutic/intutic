# AGENTS.md — intutic (Open-Core Developer Sandbox)

This file is the **machine-readable** entry point for AI coding agents working in this repository. Agents: read this top-to-bottom **before touching code**.

## Read these first

1. [`CLAUDE.md`](CLAUDE.md) — auto-synced governance SOPs (active enforcement rules for this workspace).
2. [`README.md`](README.md) — project overview, quick start, tech stack.
3. [`docs/open_source_research.md`](docs/open_source_research.md) — Open-Core Packaging Boundary & Licensing.
4. [`docs/lld/`](docs/lld/) — Low-Level Design documents.

## Layout (quick mental model)

| Path | What lives there |
|------|-------------------|
| [`packages/shared-types/`](packages/shared-types/) | TypeScript types, interfaces, enums shared across services |
| [`packages/logger/`](packages/logger/) | Structured logging with trace context |
| [`packages/id/`](packages/id/) | `newId(prefix)`, `newIso()` — never use raw UUIDs or Date.now() |
| [`packages/theme/`](packages/theme/) | Central design system tokens, fonts, and assets |
| [`packages/proxy/`](packages/proxy/) | LiteLLM-Rust proxy wrapper and protocol normalization |
| [`apps/docs/`](apps/docs/) | Developer Portal — VitePress docs site (docs.intutic.ai) |
| [`tools/cli/`](tools/cli/) | Developer CLI tool (`@intutic/cli`) |
| [`services/sync-daemon/`](services/sync-daemon/) | Bidirectional config sync daemon (SOPs → harness, configs → control-plane) |

## Commands cheat sheet

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Run unit tests
pnpm test

# Quality checks
pnpm run lint
pnpm run typecheck

# Generate docs
pnpm run docs
```

## Hybrid Open-Core Development Workflow

This repository (`intutic`) contains the **Open-Core Developer Sandbox** packages.

*   **Primary Workspace:** All features (both public sandbox and commercial control-plane/dashboard) must be developed in the private [the-downstream-tree](https://github.com/intutic/the-downstream-tree) monorepo first.
*   **Synchronization Flow:** After validating changes locally in the private workspace, copy and commit public-scoped code edits to the public `intutic` repository.
*   **Git Rules:** Never commit private business keys, GKE configs, control plane codes, or dashboard routes to this public repository.
*   **Docker Compose Decoupling:** `docker-compose.yml` in this open-core repository must remain Valkey-only (`valkey:8` on port 6379). Never copy the Postgres/pgvector docker-compose file from `the-downstream-tree`.

## House rules (don't relearn the hard way)

- **Shared types:** All types used by 2+ packages go in `@intutic/shared-types`. Never duplicate.
- **IDs:** Always use `newId(prefix)` from `@intutic/id`. Never use raw UUIDs or `Date.now()`.
- **Timestamps:** Always use `newIso()` from `@intutic/id`. Never use `Date.now()` directly.
- **Testing:** Zero `vi.mock` in unit tests for core libraries where possible.
- **Design System Compliance:** All styling must strictly utilize CSS custom variables from `globals.css` and `glass.css`. Hardcoded hex codes and color functions are prohibited inside component CSS files.

