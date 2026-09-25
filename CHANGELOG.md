# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.10.1] - 2026-09-24

The first tagged release since 1.10.0: everything that reached `main` between
2026-07-29 and 2026-09-24, including the entries previously listed under
Unreleased.

### Added

- **Graph guardrails and anomaly detection on the proxy**: graph-aware node
  identity and a detector registry; graph-wide budget and orphan detection;
  broadcast findings to sibling nodes; trajectory recorded on every trace;
  broadcast safety valves, fan-out and schema-drift detectors; tool-description
  poisoning detection; a landmark cycle detector (period-3 cycles and
  `action:`-interleaved spins); a REASK rung between HIJACK and KILL; any detector
  can hold a run (`Disposition::Ask`); NOTIFY out-of-band; shadow mode (evaluate
  everything, enforce nothing, record it all); temporal policy primitives
  (time-windowed call rate, `tool_sequence` fold); a code-as-action detector;
  ordering rules declarable with the defaults as the floor; the first measured
  false-positive rate and anomaly-chain benchmark this product has had.
- **SOPs are enforceable**: `deny_tools`, role-scoped SOP subscription,
  `.intutic/sops` found by walking up from the working directory, an
  `INTUTIC_SOPS_DIR` override, a loud startup warning naming every detector an
  empty SOP set disables, `REFINED` treated as advisory.
- **Policy Clause Ledger**: the Guardrail IR, renderers and five-way vector
  parity; guardrail warn rules through the daemon and proxy; the shared SOP-file
  renderer and replay vectors; the guardrails CLI and wire types; the predicate
  evaluator and `compile --candidate`; `--token-file`; guardrails pull; anchored
  hook-rule exclusions and the ledger CLI.
- **WASM rules**: a rule can reask, with a starter rule library; the guest sees
  every field the host sends; a governance module can say why it blocked; hot
  reload of `~/.intutic/wasm/`; a 16 MB guest-memory ceiling; `denied_tool_sources`
  in the guest context; the guest SDK parses it.
- **Harness coverage**: LangGraph, Muse Code, Grok Build, `@intutic/gate`, the
  Python SDK adapters, dsh, Mastra, Vercel AI SDK, OpenAI Agents SDK, TrueForge
  (embedded and standalone-server modes), OpenCode (the 42nd governed harness,
  with a `throw` gate contract), AutoGen in-process workbench, Managed Agents
  `watch()` reconnects; four more harnesses get real pre-tool gates; gates
  enforce WHERE clauses; `hold` at every hook gate — one mechanism for
  `review_before` and REQUIRE_APPROVAL; local hold tokens; Windsurf's real
  Cascade hook events and the JetBrains plugin's AI traffic through the TLS
  MITM proxy.
- **MCP governance proxy**: injection, anomaly and WASM governance ported from
  the Rust proxy; MCP curation parity; the remote MCP bridge (streamable HTTP
  and SSE) and its daemon mode; the per-server MCP allowlist; workspace
  injection patterns and landmark fixtures; `read_referenced_file` resolver; a
  shared anomaly session window across a harness session's sibling proxies;
  `remote_bridge_ready` in the log once the bridge is serving.
- **Gateway and BYO keys**: a `vk_`-only front door with cache tenancy pin,
  render-guard and per-workspace SOP resolution; enforced BYO-key
  refuse-on-missing-key gate; in-proxy heartbeat, config-version ack and
  SOP-status piggyback; automatic self-rotation that survives Docker recreate
  and Kubernetes reschedule; a local judge for self-hosted gateways; a shared
  gateway mints a `gw_` instance id so the control plane never mistakes a pod
  for a developer's session; `GET /intutic/instance` (loopback-only) tells the
  daemon which proxy process it is talking to, so the workspace's git and task
  context lands on the proxy's own session row.
- **Multi-provider key wizard** (registry, proxy routing for Mistral and
  OpenRouter); org signup, team management, gateway registration and
  provider-credentials CLI commands; `ControlPlaneClient` in the SDKs; a
  per-key model allowlist intersection; org-creation region parameter.
- **Sandbox and egress**: mandatory egress enforcement and an on-demand secure
  sandbox runtime; central egress-policy distribution with a Firecracker
  in-guest e2e; require-sandbox policy and egress-denial observability; sandbox
  attestation as a proxy signal a rule can gate on; sandbox-usage telemetry;
  enterprise CA/MDM rollout and the device-enforcement CLI.
- **Streaming and DLP**: the stream is held back so a split secret cannot escape;
  `/v1/responses` as a first-class shape; a model-emitted tool call refused before
  the client runs it; the DLP pattern set operator-configurable; secrets redacted
  before forwarding upstream; tool definitions pinned per workspace with the input
  schema hashed; response-injection snippet capture and the response-echo corpus.
- **Routing**: a routing reward that can notice a worse answer; cache-honest
  counterfactual, workspace-isolated session scope and a warm-prefix guard;
  unservable-model recovery; guard-liveness probes; `GET /intutic/spend`
  (loopback-only) and a local spend-trajectory detector; cache-token fields on
  trace details; mirror original-side cost and latency.
- **Open-core CLI and daemon**: `intutic start` (one-command standalone, no
  Valkey), `intutic integrity`, `intutic doctor`, local traces reader, the
  policy snapshot, findings CLI with a Reason column, daemon `status|stop|start`
  for the proxy and MCP targets, a proxy service unit, `connect` exits when told
  to (exit deadline, second-signal exit, SIGKILL escalation); agent and session
  reporting from the daemon; `/fix` and `/draw` prompt commands with local
  Obsidian/Logseq/Foam vault search; OTel across the mcp-daemon and CLI; GitOps
  for SOPs (faithful push, round-trip pull, drift status); the model catalog and
  cohort wizard.
- **Docs**: Compliance Evidence guide, Kafka/CDC delivery guarantees for SIEM
  export, capability matrix, governance controls checklist, egress as a guardrail,
  sandbox platform guide, org/tenancy hierarchy, provider keys and self-hosted
  gateway coverage, five integration pages, the harness security matrix.

### Changed

- The proxy attributes traces to the harness that made the request; each proxy
  process carries a per-process instance id on every trace.
- Judge failures are reported `UNAVAILABLE`, never a fabricated clean pass;
  mid-stream judge chunking runs on same-provider streams; BYO workspace judge
  model; open-weight judge default with governance-card labeling.
- Advisory anomaly findings no longer block the request; the exfiltration rule
  fires on a one-line exfiltration; the tool pin is scoped per harness.
- `@intutic/anomaly-taxonomy` extracted as the single source of truth; a
  taxonomy value is not an identity — detectors carry `detector_id`.
- Requests are bound to the authenticated workspace and honour deactivation; a
  key is validated against the control plane on a cache miss; the proxy fails
  closed when a virtual key cannot be validated.
- The pricing bundle is pinned to a LiteLLM commit and re-pinned on drift (the
  drift check gates the deploy); Linux release binaries build against glibc 2.35.
- Published latency claims retracted where no benchmark stood behind them;
  hallucination and context-drift auto-resolution no longer claimed.

### Fixed

- Loop governance never fired: the circuit breaker's budget scalar was never
  written and the proxy had no run id to read; now verified live (403
  `LOOP_RUN_TERMINATED` after Kill, 403 `WORKFLOW_BUDGET_BREACH` over budget).
- Streaming responses accrued no spend, so the local cap never fired; the cost
  gate answered every request instead of forwarding it; five inert controls
  brought to life; the token-baseline key hardcoded a segment nothing produced.
- `intutic exec` sent agent traffic and API keys to a remote host (1.7.2); the
  CLI shipped a stale proxy binary (1.7.1); the proxy admitted a request on a
  published key prefix; a redactor that missed its own examples.
- The remote-bridge test harness charged the child proxy's boot to its 5 s
  request timer (the source of the CI timeouts); the MCP-allowlist refusal
  names its rule on the stdout-contract gates; the reask ladder keyed reasks
  across tenants; the MCP proxy never read the control-plane URL the daemon
  wrote; `install-hooks.js` failed inside a git worktree.
- `intutic doctor`'s daemon-log check read a path nothing writes; the daemon's
  dead ContextGraph scan and BrainIndexer removed with three dead wires.

- **Loop governance never fired.** A user could set a per-loop budget and press
  Kill in the dashboard, and the agent kept running. The control plane wrote loop
  state as a JSON blob at `intutic:loop:{id}` while the proxy read flat scalars
  `:budget` and `:spend`, nothing wrote the budget scalar at all, and nothing set
  the `x-loop-run-id` header the proxy needed to identify the run. The proxy now
  resolves the active loop from a workspace pointer when the header is absent, the
  budget is published as a bare decimal (it is parsed as `Option<f64>`, so a JSON
  value silently became `None`), and `store::valkey::loop_key_contract` pins the
  key strings in Rust so the two sides cannot drift apart again. Verified against
  a live cluster: 403 `LOOP_RUN_TERMINATED` after Kill, 403
  `WORKFLOW_BUDGET_BREACH` over budget.
- `intutic doctor`'s daemon-log check read `~/.intutic/daemon.log`, which nothing
  writes — the installer logs to `sync-daemon.log` and `mcp-daemon.log`.
- Dropped the sync daemon's dead ContextGraph scan and BrainIndexer, and three
  proxy/CLI wires that no longer connected to anything.

### Security

- CodeQL runs over the whole tree on PRs and main alike, with test code excused
  and counted; polynomial regexes replaced (gate-js, guardrailRender,
  providerVerification); cleartext-logging sites fixed or dismissed at the site
  with reasoning; Dependabot advisories cleared before 1.6.0 and js-yaml raised
  for CVE-2026-59870; contiguous credential-shaped test literals assembled at
  runtime.

### Documentation

- **Removed claims of Docker/V8 agent isolation.** The competitor-comparison
  pages carry no paid-tier badge, so they render in the public docs build, and all
  three asserted that agent execution is isolated in Docker containers or V8
  isolates. Nothing containerizes an agent: what ships is a wasmtime WASM sandbox
  for policy rules (16 MB, 1,000,000 fuel, 5 ms) and SOP hook scripts in a frozen
  `node:vm` context. Corrected in prose as well as the comparison tables.
  The 1.6.0 entry below claims this cleanup was already done — it was not; that
  sweep fixed some references and missed the comparison pages entirely.
- Also removed the outbound-block-list and container-interceptor claims, neither
  of which has an implementation.
- **`guide/drift-detection.md` rewritten.** It documented compliance-score drift
  windows, drift direction, `behavioral_drift_event` records and embedding-based
  vector drift — none of which exist; that work was removed when the product
  narrowed to circuit-breaker scope. The page now covers the three mechanisms
  that are real (SOP staleness, per-developer cost baselines, proxy sequence
  anomalies) and says plainly that the drift scoring was removed, so a reader who
  remembers it is not left guessing.

## [1.10.0] - 2026-07-29

### Added

- **DLP scanner expanded from 6 patterns to 19**, all prefix- or
  magic-substring-anchored (formats ported from the gitleaks default config
  and TruffleHog detectors): OpenAI, GitLab, Slack tokens and webhook URLs,
  Google, Stripe, SendGrid, npm, PyPI, Hugging Face, database connection
  credentials, JWTs — plus widened AWS (temporary `ASIA` credentials), GitHub
  (all five classic prefixes + fine-grained), and the full PEM private-key
  family (OpenSSH, PGP, PKCS#8). A RegexSet prefilter keeps the clean-body
  scan at a single traversal.
- **Streaming responses are now scanned by output DLP.** Each SSE line is
  scrubbed before it is forwarded and before it is parsed, so the client, the
  judge, the semantic cache and the trace all see redacted text. Previously
  the streaming branch bypassed output DLP entirely.
- **Forwarded request headers are scanned** with the body's doctrine:
  block-action findings refuse the request, the rest are redacted in place.

### Fixed

- `DlpEscalationDetector` (the credential-sweep kill) was unfireable: it
  counted block-action findings, which refuse the request before the detector
  registry runs. It now counts distinct pattern types, so an AWS key + GitHub
  token + SSN in one request kills even though each is individually redacted.
- Multibyte characters bisected by a network chunk boundary were corrupted in
  streamed responses (per-chunk lossy decoding); the stream buffer is now
  bytes, decoded per line.
- The claude-code hook forwards Claude Code's `session_id`, restoring
  per-user attribution for hook-gate blocks after the next `intutic connect`.

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
