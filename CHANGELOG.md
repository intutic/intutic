# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-07-29

### Changed

- **Advisory anomaly findings no longer block requests.** Six heuristic
  detection paths (tool-transition plausibility, tool-contract drift,
  diversity collapse, context growth, token-waste heuristics, a single
  prompt-injection technique) now advise — logged, broadcast to graph siblings
  and traced — while the request proceeds. Deterministic detectors (loops,
  forbidden successions, budget breaches, credential sweeps, denied tools)
  still return 403. Previously every finding blocked, which had six advisory
  detectors hard-refusing requests they were written to merely steer.
- **`trace:live` events carry real per-turn tool calls.** A `tools` array
  (the calls newly observed on that request) and `taskType` join the payload;
  `toolName` is deprecated — it has always carried the task type — and is kept
  only for older sync-daemons. The stored tool sequence no longer duplicates
  the conversation history into itself on every request.
- **All graph state is workspace-namespaced.** Graph membership, spend,
  broadcast budgets and notification queues now include the workspace in
  their keys, and the response cache's exact-match hash is workspace-salted —
  two tenants reusing a graph id on shared infrastructure are isolated by
  construction rather than by id uniqueness.

### Fixed

- `MissingPredecessorDetector` stopped evaluating at its first rule, so
  sessions that never ran `deploy` had the `publish` and `release` ordering
  invariants silently unchecked.
- Tool-sequence keys in Valkey never expired; they now carry a 24h sliding
  TTL refreshed on write.
- `@modelcontextprotocol/sdk` moved to `^1.30.0`, taking `@hono/node-server`
  to 2.x (GHSA-frvp-7c67-39w9).

## [1.8.0] - 2026-07-28

### Added

- **Graph guardrails.** Node identity from OpenTelemetry GenAI attributes over
  W3C Baggage (with `X-Intutic-*` fallbacks), an 18-detector hot-path anomaly
  registry covering 11 of the 12 runtime anomaly categories, sibling broadcast
  of findings with loop suppression and rate ceilings, graph coordinates on
  every trace, and role-scoped SOPs from `.intutic/sops/*.md` whose
  `deny_tools` front matter is enforced rather than advisory.
- **Tool-definition pinning.** SHA-256 over each tool's name, description and
  input schema, pinned per workspace and surviving restarts — the MCP
  rug-pull defence.
- New public package `@intutic/anomaly-taxonomy` (Apache-2.0): the 12-category
  runtime anomaly taxonomy as types and constants, declared once and drift-
  checked against the Rust proxy's copy at build time.

### Fixed

- **DLP redaction actually redacts before forwarding.** Secrets matching
  redact-action patterns (AWS keys, GitHub tokens, bearer tokens, SSNs) were
  detected and logged as redacted, but the original body was forwarded to the
  provider. The redacted body is now what leaves the machine, and a redaction
  that would produce invalid JSON refuses the request instead of forwarding
  either version.

### Breaking

- **`intutic-clawde` (Python) now requires Python >= 3.10** (was 3.9). The
  patched releases of `requests` (2.33.0) and `urllib3` (2.7.0) — carrying
  fixes for CVE-2026-25645, CVE-2026-44431 and CVE-2026-44432 — themselves
  require 3.10, so keeping the 3.9 floor meant shipping known-vulnerable
  transports. Python 3.9 reached end of life in October 2025.

## [1.7.2] - 2026-07-27

### Fixed

- **`intutic exec` sent agent traffic and API keys to a remote host.**
  `buildProxyEnv` pointed `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and the rest
  at a remote proxy unless `--dev` was passed, and injected `OPENAI_API_KEY`
  alongside them. The default path therefore routed an agent's prompts and its
  provider credentials off the machine. That host does not resolve, so the
  command could not work either way. It now uses the local proxy that
  `intutic start` binds on `:4000`; set `INTUTIC_PROXY_URL` to point elsewhere.
- **Onboarding printed the same wrong address.** The setup instructions the CLI
  prints after `intutic init` told you to point your agent at a remote host
  rather than the proxy you had just started.

## [1.7.1] - 2026-07-27

### Fixed

- **The CLI installed, and then kept, the wrong proxy binary.** Two halves of
  one bug:

  The release tag `intutic connect` fetched the binary from was pinned to a
  literal `1.6.0`, so every version since shipped a CLI that installed a proxy
  several releases behind itself. A 1.7.0 user got the 1.6.0 binary, which
  still required Valkey and had none of the standalone work. It now reads the
  version from its own `package.json`, the same fix `intutic --version` got in
  1.6.3.

  Worse, the download cached to a single unversioned `~/.intutic/bin/intutic-proxy`
  that nothing ever revalidated: the launcher used the first binary it found and
  only downloaded when there was none. So upgrading the package did not upgrade
  the binary, and anyone who had already run `intutic connect` or
  `npx @intutic/proxy` would have stayed on the old proxy no matter how many
  times they upgraded. The cache is now keyed by version, and the old
  unversioned entry is deleted on first run.
- **Every install path pointed at `intutic connect`.** The README, the docs
  landing page, the marketing site and 18 integration guides all opened with
  `intutic init` then `intutic connect`, which starts the sync daemon and
  requires credentials for a control plane, which open core does not include.
  Anyone without one hit a login wall on step 2 of a "30-second" quickstart.
  They all lead with `intutic start` now (#1).
- **`integrations/standalone.md` documented a flag that does not exist.**
  `intutic connect --upstream-url ...` — `--upstream-url` is an option of
  `start`, not `connect`, so the command exited with an unknown-option error.
- **Docs pointed every harness at a hosted proxy.** Twelve integration guides
  gave a remote base URL and never mentioned `http://localhost:4000`, so
  following them routed every LLM request — prompts and provider API keys
  included — off the machine, when the whole premise of open core is that the
  proxy runs locally. All of them now point at the local proxy.
- **The OSS docs build now fails on hosted-infrastructure references.** Section
  stripping was opt-in, so anything nobody remembered to wrap shipped. The
  build refuses to publish those terms and names the offending page.

- **"Not authenticated" told you to run a command that would also fail.**
  Eight commands emitted `Run \`intutic login\` first` with no indication of
  the command needed, or that `intutic start` needs nothing. They now say both.

## [1.7.0] - 2026-07-27

### ⚠️ Breaking

- **Valkey is no longer required.** The proxy runs standalone with an in-memory,
  file-backed store. Nothing to change for existing setups — a reachable Valkey
  is still used whenever one is found — but the boot behaviour differs:

  | Environment | Behaviour |
  |---|---|
  | `CONTROL_PLANE_URL` set, Valkey unreachable | **fatal** (was: fatal) |
  | no `CONTROL_PLANE_URL`, Valkey unreachable | **standalone** (was: fatal) |
  | `INTUTIC_STANDALONE=1` | standalone, no probe (new) |

- **Control-plane-managed deployments now fail closed on an unverifiable
  request.** Previously, if Valkey became unreachable *after* startup, the proxy
  admitted requests it could neither authenticate nor budget-check. Both gates
  now reject instead:

  - `503 AUTH_UNVERIFIABLE` — the virtual key could not be validated
  - `503 BUDGET_UNVERIFIABLE` — spend could not be verified against the cap

  Both are retryable; clients should back off rather than treat the key as
  invalid. This affects managed deployments only. Standalone has no control
  plane to be unreachable and is unaffected.

  Rationale: authentication and hard spend caps are security and financial
  controls, where wrongly allowing is unbounded and wrongly denying costs a
  retry. Rate limiting and feature flags continue to fail open.

### Added

- **Standalone open core.** `intutic start` no longer exits when Valkey cannot
  be provisioned — it warns and runs. Routing, policies, DLP, WASM rules and
  local spend caps all work without one. Closes the last dead-end in the
  documented install (#1).
- **Durable standalone learning.** Bandit arm state persists to
  `~/.intutic/bandit-state.json` and reloads on boot, so a per-session CLI proxy
  accumulates learning across restarts and reaches the 20-pull threshold at
  which Thompson sampling engages. Writes are atomic and merged under an
  exclusive lock, so two proxies sharing a home directory converge instead of
  clobbering each other. Provider credentials are held in memory only and are
  never written to disk.
- **Learning carries over on upgrade.** Connecting a control plane seeds Valkey
  from the local snapshot, so attaching a control plane does not reset the
  workspace to cold start. Only arms Valkey does not already have are seeded; existing
  control-plane state is never overwritten.
- **`INTUTIC_STANDALONE=1`** forces standalone regardless of what is listening
  on the Valkey port.

### Changed

- **The proxy's entire Valkey surface moved behind two traits** (`LocalStore`,
  `ControlPlaneCache`). All 20 per-call-site connection clones are gone, and
  `redis::` now appears in exactly two files. Wire format is unchanged: the
  arm-update Lua runs verbatim and cached responses keep their field names, so
  state written by this version stays readable by the control plane's crons.
- **The standalone Valkey probe is bounded at 1.5s.** Falling back previously
  waited on the client's full retry budget (~9s) before starting.

### Fixed

- The cost-prediction gate and notification reader no longer construct a Redis
  client per request; both read only control-plane-written keys and are inert
  without one.
- `apps/docs/guide/faqs.md` described the budget gate as failing closed while
  the code failed open. The code now matches the documentation.

## [1.6.3] - 2026-07-26

### Added

- **`intutic start`** — one command to run the proxy standalone: no
  control plane, no configuration file. The Valkey provisioning ladder
  (existing instance, then Docker, then a local `valkey-server`/`redis-server`)
  previously sat below `intutic connect`'s credential check, so the open-core
  users who needed it could never reach it.

### Fixed

- `intutic --version` reads the installed `package.json` instead of a literal
  that had reported 1.6.0 for three releases.

## [1.6.2] - 2026-07-26

### Fixed

- A missing `config.yaml` no longer stops the proxy starting. `npm i -g
  @intutic/proxy` installs a binary and nothing else, so anyone following the
  documented install had no config file and got a bare
  `No such file or directory`. Defaults are now a working standalone
  configuration; a file that exists but is malformed still fails.
- An unreachable Valkey reports what it was connecting to and how to start one,
  instead of a bare `Connection refused (os error 111)`.
- The sync daemon stops its drift watcher before tearing down the workspace it
  watches, rather than after.
- Documentation no longer describes a control plane that open core does not
  ship.
- LaTeX in the docs renders instead of printing as source.

## [1.6.1] - 2026-07-26

### Fixed

- Linux release binaries build against glibc 2.35 rather than 2.39, restoring
  compatibility with Ubuntu 22.04 and other still-supported distributions. The
  npm publish is now blocked on an old-glibc smoke test so this cannot regress
  silently.

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
