# Intutic Monorepo Contributor & Architecture Info

This document provides internal repository structure details, package directory sitemaps, and development instructions for contributors working on the open-source Intutic repository.

---

## 📦 Monorepo Package Sitemap

| Component | Directory | Purpose |
|---|---|---|
| **Proxy Gateway** | [`packages/proxy/`](packages/proxy/) | High-performance Rust proxy (`@intutic/proxy`) that intercepts LLM stream queries, checks active SOP rules, and returns warnings/blocks. |
| **Developer CLI** | [`tools/cli/`](tools/cli/) | CLI tool (`@intutic/cli`) to initialize workspaces (`intutic init`), run connection daemons, audit files, and execute benchmark suites. |
| **Sync Daemon** | [`services/sync-daemon/`](services/sync-daemon/) | Local background reconciliation loop that mirrors central guidelines and updates workspace rules (`CLAUDE.md`, `.cursorrules`). |
| **Developer Portal** | [`apps/docs/`](apps/docs/) | VitePress-based static documentation site served at `docs.intutic.ai`. |
| **VSCode Extension** | [`packages/vscode-extension/`](packages/vscode-extension/) | VSCode integration editor adapter. |
| **AssemblyScript WASM SDK** | [`packages/wasm-sdk/`](packages/wasm-sdk/) | SDK used to build high-performance custom filters compiled to WebAssembly. |
| **MCP Governance Server** | [`packages/mcp-proxy/`](packages/mcp-proxy/) | Model Context Protocol server (`@intutic/mcp-governance-proxy`) providing rule checks and tool interception hooks to MCP clients. |

---

## 🛠️ Monorepo Directory Layout

- [`packages/proxy/`](packages/proxy/): Pure Rust stream interception proxy.
- [`packages/mcp-proxy/`](packages/mcp-proxy/): Model Context Protocol governance server (`@intutic/mcp-governance-proxy`).
- [`packages/wasm-sdk/`](packages/wasm-sdk/): AssemblyScript rule development SDK.
- [`packages/clawde-sdk/`](packages/clawde-sdk/): Client programmatic interface library (`@intutic/clawde`).
- [`packages/intutic-clawde/`](packages/intutic-clawde/): Internal protocol client bridge for clawde integration.
- [`tools/cli/`](tools/cli/): TypeScript developer CLI (`@intutic/cli`).
- [`services/sync-daemon/`](services/sync-daemon/): Local settings reconciliation loop.
- [`apps/docs/`](apps/docs/): Static VitePress documentation.
- [`packages/shared-types/`](packages/shared-types/): TypeScript interfaces and typings.
- [`packages/theme/`](packages/theme/): Central design system tokens and variables.
- [`packages/vscode-extension/`](packages/vscode-extension/): VSCode editor integration.
- [`packages/logger/`](packages/logger/): Pino-based console logging helper.
- [`packages/id/`](packages/id/): UUID and ISO generators.
- [`tools/benchmarks/`](tools/benchmarks/): Benchmark scripts for testing proxy execution latencies and compression.

---

## 💻 Contributor Development Setup

### 1. Build Client Utilities
From the root of the monorepo, install dependencies using **pnpm** and compile workspace packages:
```bash
pnpm install
pnpm run build
```

### 2. Run Local CLI & Intercepting Proxy
Start the local connect loop which spins up the Rust proxy gateway on port `4000`:
```bash
VALKEY_URL="redis://127.0.0.1:6379" \
ANTHROPIC_API_KEY="sk-ant-..." \
pnpm --filter @intutic/cli connect --dev --interval 1000
```

> [!NOTE]
> Use the `--dev` flag during local development to direct the CLI to look for the local control plane at `http://localhost:3001`. Without the `--dev` flag, the CLI defaults to `https://api.intutic.ai`.
