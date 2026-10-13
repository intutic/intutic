# Intutic Monorepo Contributor & Architecture Info

This document provides internal repository structure details, package directory sitemaps, and development instructions for contributors working on the open-source Intutic repository.

---

## 📦 Monorepo Package Sitemap

| Component | Directory | Purpose |
|---|---|---|
| **Proxy Gateway** | [`packages/proxy/`](packages/proxy/) | High-performance Rust proxy (`@intutic/proxy`) that intercepts LLM stream queries, checks active SOP rules, and returns warnings/blocks. |
| **Developer CLI** | [`tools/cli/`](tools/cli/) | CLI tool (`@intutic/cli`) to initialize workspaces (`intutic init`), run connection daemons, audit files, and execute benchmark suites. |
| **Sync Daemon** | [`services/sync-daemon/`](services/sync-daemon/) | Local background reconciliation loop that syncs central guidelines and updates workspace rules (`.claude/rules/intutic-governance.md`, `.cursor/rules/intutic-governance.mdc`). |
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
- [`packages/intutic-clawde/`](packages/intutic-clawde/): Python client SDK (`intutic-clawde` on PyPI).
- [`tools/cli/`](tools/cli/): TypeScript developer CLI (`@intutic/cli`).
- [`services/sync-daemon/`](services/sync-daemon/): Local settings reconciliation loop.
- [`apps/docs/`](apps/docs/): Static VitePress documentation.
- [`packages/shared-types/`](packages/shared-types/): TypeScript interfaces and typings.
- [`packages/theme/`](packages/theme/): Central design system tokens and variables.
- [`packages/vscode-extension/`](packages/vscode-extension/): VSCode editor integration.
- [`packages/logger/`](packages/logger/): Pino-based console logging helper.
- [`packages/id/`](packages/id/): Prefixed ID (`newId`, nanoid-based) and ISO timestamp (`newIso`) generators.
- [`tools/benchmarks/`](tools/benchmarks/): Context-compression benchmark (`compression_benchmark.go`) and its results; proxy latency benchmarks are Criterion benches in `packages/proxy/benches/`.

---

## 💻 Contributor Development Setup

### 1. Build Client Utilities
From the root of the monorepo, install dependencies using **pnpm** and compile workspace packages:
```bash
pnpm install
pnpm run build
```

### 2. Run Local CLI & Intercepting Proxy
Run the Rust proxy gateway from source on port `4000` (Valkey is optional; without one the proxy runs standalone):
```bash
VALKEY_URL="redis://127.0.0.1:6379" \
ANTHROPIC_API_KEY="sk-ant-..." \
cargo run --package intutic-proxy
```

> [!NOTE]
> The connect loop (`node tools/cli/dist/cli.js connect`) runs the sync daemon, which needs a control plane; open core does not include one. If you run one locally, add the `--dev` flag (for example `connect --dev --interval 1000`) to direct the CLI to it at `http://localhost:3001`.
