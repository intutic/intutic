# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-07-25

### ⚠️ Breaking

- **The proxy no longer rewrites Anthropic-bound requests to a fixed model.**
  Previously every request whose resolved provider was Anthropic was silently
  rewritten to `claude-opus-4-8`, regardless of the model the caller asked for.
  Requests now reach the model they name.

  If you relied on that pin, restore it explicitly in `config.yaml`:

  ```yaml
  intutic_settings:
    routing:
      anthropic_model_override: "claude-opus-4-8"
  ```

  Leaving `anthropic_model_override` unset (the default) means no rewriting.

### Added

- **Local Thompson-sampling model routing.** The bandit router that previously
  required a control plane now runs standalone. Enable it under
  `intutic_settings.routing` in `config.yaml`; the candidate pool is
  configurable via `candidate_models` (default: `claude-3-5-sonnet`,
  `gpt-4o`, `gemini-2.0-flash`).
- **Local deterministic reward loop.** Arm rewards are computed on your machine
  from signals the proxy already observes — upstream success, latency against
  `latency_slo_ms`, token anomalies, and routed-vs-requested cost ratio — with
  no LLM judge and no telemetry leaving the host. Tunable under
  `intutic_settings.routing.reward`.
- **Single-writer ownership contract** for bandit arms, tracked in Valkey at
  `bandit:reward_mode:{workspaceId}`. A standalone proxy claims `local`; a
  control plane taking over sets `cloud`, and the local writer stands down
  within ~60s. Arm state carries over without distortion because both sides
  apply the identical update rule.
- **Local WASM rule hot-reload.** Compiled rules dropped into `~/.intutic/wasm`
  are picked up within ~5s on the request path — no restart, no control plane.
  Files follow an `NN_name.wasm` convention where `NN` sets evaluation
  priority. Override the directory with `INTUTIC_WASM_DIR` or
  `intutic_settings.wasm_local_dir`.
- **`intutic policy compile | install | list-local`** — compile AssemblyScript
  rules with `asc`, validate them by instantiation before install, and inspect
  what is installed locally. `install` refuses a rule that cannot instantiate,
  because the sandbox fails open and a broken rule would enforce nothing.
- **`intutic-rule-author` agent skill**, distributed to workspaces by the sync
  daemon (write-if-missing), teaching any coding agent to turn a plain-English
  business rule into a compiled, dry-run-verified, installed WASM policy.

### Changed

- Local WASM rules and centrally-synced rules are merged into one
  priority-ordered chain. `BLOCK` short-circuits and nothing overrides it, so
  the union is most-restrictive-wins: a local rule can add restrictions but can
  never neutralize a centrally-synced one.
- Blocked requests now report which rule fired (`policy_id` is attributed from
  the rule registry rather than left empty).
- Proxy binaries are downloaded from GitHub Release assets instead of a
  self-hosted mirror, so the download always matches the released tag.

### Fixed

- **`npm install -g @intutic/cli` failed with E404.** The published CLI
  depended on `@intutic/logger` and `@intutic/sync-daemon`, which were marked
  private and never published; `workspace:*` resolved to versions that did not
  exist on npm. Both are now published ahead of their dependents.
- **Quickstart docs misrouted Anthropic traffic.** `ANTHROPIC_BASE_URL` was
  documented with a `/v1` suffix, producing `/v1/v1/messages`, which failed
  route matching, was misclassified as OpenAI, and was forwarded to the wrong
  vendor with the wrong auth header. The Anthropic base URL is host-only.
  (`OPENAI_BASE_URL` correctly keeps `/v1`.)
- **Linux proxy downloads could never succeed.** The release workflow built
  `intutic-proxy-linux-amd64` while the CLI requested `intutic-proxy-linux-x64`.
  Names now match, and a native `linux-arm64` build target was added.
- A missing Valkey binary now produces actionable install instructions instead
  of a bare HTTP status.
- The managed proxy no longer defaults to Valkey port `6380` (the isolated test
  stack) when `VALKEY_URL` is unset; it uses the documented `6379`.
- Local WASM rule loading is fail-safe: an unreadable rules directory retains
  the previously loaded rules instead of silently dropping every local rule,
  and directory rescans no longer hold a lock across compilation.
- Streaming responses that fail or truncate mid-flight are no longer recorded
  as successful pulls in the bandit reward loop, and judge/cache overhead is no
  longer charged against a model's latency SLO.

### Documentation

- Removed references to endpoints and features that do not exist
  (SCIM provisioning, `POST /api/v1/auth/register`, Prompt Library,
  Docker/V8 sandboxing, CFO Ledger).
- The intelligent-routing guide is now reachable in the open-source docs build,
  with its dashboard-only steps marked enterprise-only.
- `reference/configuration.md` documents the full `intutic_settings` surface;
  `reference/cli.md` documents the shipped `policy`, `doctor`, and `budget`
  commands.
- Corrected sandbox limits (16 MB memory / 1,000,000 fuel / 5 ms), the wasmtime
  version (29), and the harness adapter count (18) across README, package
  READMEs, and `AGENTS.md`/`CLAUDE.md`.

[1.6.0]: https://github.com/intutic/intutic/releases/tag/v1.6.0
