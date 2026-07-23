# Intutic Governance Rules (Open-Core Developer Sandbox)

This file contains standard operating rules and governance constraints for AI coding agents working in the public open-core repository.

---

## 1. Scope & Access Boundaries

- **Target Scope**: Public open-core packages (`packages/*`), developer CLI (`tools/cli`), sync daemon (`services/sync-daemon`), and documentation site (`apps/docs`).
- **Enforcement Tier**: ACTIVE

---

## 2. Command Execution Restrictions

- **Dependencies**: Use `pnpm` exclusively for Node.js workspace management.
- **Rust Toolchain**: Use `cargo` for `packages/proxy` and `packages/wasm-sdk`.
- **Privileges**: No root privilege (`sudo`) or administrative execution permitted.

---

## 3. Security & Credentials Boundary

- **Credential Isolation**: All API keys and tokens must be loaded via environment variables (e.g. `INTUTIC_PROXY_KEY`). Never hardcode or echo raw secrets in logs or source files.
- **DLP Enforcement**: Ensure DLP scanner patterns in `packages/proxy/src/dlp.rs` continue to detect AWS keys, Anthropic tokens, and sensitive headers.

---

## 4. Observability & Logging

- **Structured Logging**: Use `@intutic/logger` for TypeScript packages and `tracing` crate for Rust proxy modules.
- **Trace Context**: Always forward trace IDs across protocol adapters and HTTP proxies.

---

## 5. Code Quality & Verification

- **TypeScript**: Must compile cleanly with 0 type errors (`pnpm typecheck`).
- **Rust**: Must compile cleanly with 0 warnings or errors (`cargo test --package intutic-proxy`).
