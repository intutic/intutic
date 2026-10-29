# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.9] - 2026-10-29

### Security

- **Dependency updates for open advisories.** `rustls` 0.23.46 in the proxy crate's own
  lockfile (the workspace lock already had it), `systeminformation` 5.33.18, `qs` 6.17.0,
  `@hono/node-server` 2.1.5 and `re2js` 2.9.1 in the npm lock, and `authlib` 1.9.1 and
  `langgraph` 1.2.18 in the Python SDK's lock. The published packages resolve from their own
  constraints; the lock files are what the repository's builds and tests use. The `mcp` and
  `opentelemetry-api` advisories in the Python SDK's lock stay: `strands-agents` and
  `google-adk` cap those packages below the fixed versions.

### Changed

- **Promotional email waits for a postal address.** The two onboarding emails (day 3 and
  day 7) carry a one-click unsubscribe link and, as CAN-SPAM requires, the sender's postal
  address. While `COMPANY_POSTAL_ADDRESS` is unset they are now not sent, with a
  `email_postal_address_missing` warning naming the template, where they used to go out
  without an address. Self-host operators who want the emails set `COMPANY_POSTAL_ADDRESS`.
  A workspace created while it is unset does not get them later. Transactional email
  (verification, sign-in, billing, alerts) is unaffected.
- **Shipped docs and source name no private paths.** A few comments, a test fixture and the
  repository's check scripts named files in a tree this repository does not contain. The
  scripts now read where that tree is from a file only the full checkout has.

## [3.0.8] - 2026-10-28

### Added

- **`INTUTIC_UPSTREAM_WIRE=passthrough` sends every request to a shared gateway as it
  arrived.** The proxy picks a request's provider from its model name, which behind a
  gateway such as LiteLLM (`UPSTREAM_URL`), whose model names are its own, refused or
  rerouted requests the gateway serves: `qwen3-coder` on `/v1/messages` was refused
  with 400 `unsupported_route`, `claude-*` on `/v1/chat/completions` and
  `/v1/responses` was translated to Messages and back, `gemini-*` on
  `/v1/chat/completions` was sent to the Gemini API (402 without a Gemini key), and a
  gateway route name such as `vertex/claude-opus-4-1` went to Vertex AI directly. With
  the setting, each request on `/v1/messages`, `/v1/chat/completions` and
  `/v1/responses` goes unchanged, in its own format and with its model, to that
  format's upstream. Credentials, DLP, SOPs, the response gate and budgets apply as
  before. Unset (or `model`) nothing changes; another value stops the proxy at startup.

### Fixed

- **A `/v1/responses` request for a Claude model keeps its input.** Translated to
  Anthropic Messages, the request was read as Chat Completions: the system prompt in
  `instructions`, a string `input`, `input_text` / `output_text` parts and the
  `function_call` items were dropped, `function_call_output` became a user message with
  no result, and the Responses API's flat function tools were not sent, so Codex reached
  the model with empty messages and no tools. All of them are now translated, a
  `function_call` paired with its output as `tool_use` and `tool_result`. A
  non-streamed answer comes back as a Responses body (`output` with `output_text`
  messages and `function_call` items) rather than Chat Completions `choices`; a streamed
  one still comes back as Chat Completions chunks.

- **Goose can run its gate.** The plugin's `hooks/hooks.json` runs `intutic-check.sh` by its
  path, and hardening set every plugin file to 444, so Goose's `sh -c '<script>'` failed with
  exit 126 and, with `on_failure: block`, Goose refused every tool call. The script is now 555:
  read-only still, and executable. (#393)

- **OpenClaw runs the plugin gate.** OpenClaw (2026.10.7) lists a plugin from `plugins.load.paths`
  as enabled but registers it only when the config enables it by name, so the gate never ran and
  every tool call went through. The writer now sets `plugins.entries.intutic-governance.enabled` to
  `true`; disconnect puts the entry back as it was, or removes it. (#395)

- **Antigravity CLI runs the calls the gate allows.** The gate answers an allowed call with `{}`,
  no decision, which Antigravity's desktop app leaves to the user's permission settings, but
  Antigravity CLI (1.4.7) reads as a denial: every tool call failed with "tool call denied by
  pre-tool hook". Under the CLI, recognised by its hook payload's paths under
  `~/.gemini/antigravity-cli/`, the gate now answers `{"decision":"allow"}`. (#394)

- **Streamed Chat Completions chunks the proxy writes are well formed, and in time.** With output
  DLP on (the default), the chunks the proxy writes into a stream (the held text and tool-call
  arguments, the judge's, decide's and governance notes, a refusal's tail) had no `created` or
  `model` and an id of their own or none; strict clients (Grok Build) failed the turn on them. They
  now carry the stream's `id`, `created` and `model`, from the upstream's chunks or, before the
  first, the request's model. A tool call's held arguments, and held text, now go out before the
  chunk that finishes the choice, not at `[DONE]`: a client that assembles its calls there (Goose)
  ran them with no arguments. The proxy's whole answers to a command (`chatcmpl-intutic-cmd`) carry
  `created` and `model` too. (#392)

### Documentation

- **Two limits of the harnesses' own hooks.** Gemini CLI driven over ACP (`gemini --acp`) runs no
  hooks, so its own tools are not gated there (#396). A Cline gate's refusal ends the whole task,
  and the Cline CLI reports only that the run was aborted; the reason is in
  `~/.intutic/events/cline-hook-events.jsonl` (#397). Both are on the integration pages and in the
  harness matrix's gaps.

## [3.0.7] - 2026-10-28

### Fixed

- **The standalone CLI binaries start on every platform.** They are built on Linux for macOS and
  Windows too, and `pkg` could not produce V8 bytecode for another OS, so the binary shipped without
  its source and exited at start. They now ship as plain source. 3.0.6 was tagged but its release
  stopped at the macOS smoke test, so only its PyPI package went out; 3.0.7 carries everything it
  described.

## [3.0.6] - 2026-10-28

### Changed

- **The commands that only work against a control plane are no longer in `@intutic/cli`.**
  `login`, `logout`, `whoami`, `connect`, `sync-context`, `sops`, `guardrails`, `keys`, `org`, `team`,
  `gateway`, `credentials`, `loop`, `budget set` and the rest (42 in all, hidden from help until now)
  load from an optional plugin package, `@intutic/cli-control-plane`, when it is installed next to the
  CLI. Without it, running one prints what it is, that the plugin provides it, and how a control
  plane is named, and exits 1. Everything open (`init`, `start`, `gates`, `decide`, `policy`
  `compile`/`test`/`install`, `traces`, `budget`, `exec`, ...) is unchanged.
- **The proxy compiles in its control-plane clients only with `--features control-plane`.**
  A plain `cargo build` is the open-core proxy: standalone, with no code that calls a
  control plane (the gateway heartbeat, key and policy lookups, the judge, decide uploads,
  holds, the `/intutic` slash commands). It refuses to start when `CONTROL_PLANE_URL` (or
  `intutic_settings.policy.control_plane_url`) is set, rather than serve a deployment that
  expects authentication and budgets without them. Standalone behaviour is unchanged. A proxy
  built with the feature behaves as before; Intutic's own images are built with it. A release
  binary built without it cannot be pointed at a control plane, which includes the proxy
  `intutic connect` starts with `CONTROL_PLANE_URL` set.

- **`@intutic/shared-types`, `@intutic/mcp-governance-proxy` and `@intutic/sync-daemon` use zod 4.**
  The response schemas keep their shape on the wire. Code that imports a schema from
  `@intutic/shared-types` needs zod 4 (`^4.6.6`) for `.parse`, `.safeParse` and `z.infer`: a
  `ZodError`'s `issues[].path` may now hold symbols, and a schema that keyed a record by an
  enum is a partial record, as before.

### Fixed

- **The standalone `cli-*` release binaries run every command.** They were `pkg` packages of the
  compiled CLI, and `pkg` cannot run a lazily imported module: `intutic status`, `intutic init` and
  every other command crashed with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, while `--version` and
  `--help` worked, which is all the release smoke test checked. The binary is now the CLI bundled
  into one module (`pnpm --filter @intutic/cli run build:binary`) and the macOS smoke test runs
  `intutic status`.

- **`POST /api/v1/plans/capture` answers 409 for a session the platform has not seen,**
  with `UNKNOWN_SESSION` and what to do, in place of a 500 that echoed the query. The
  generated API catalog documents the response.

### Security

- **Dependencies moved past the 2026-10-26 advisories** with overrides, because
  Dependabot's security jobs ended in `update_not_possible` for each (every one is reached
  through another package's range): undici 7.30.1, body-parser 2.4.0, fast-uri 3.1.9,
  ip-address 10.7.4 and @vitest/mocker 4.1.12, and zod 4.6.6 for the 4.x copies in gate-js's
  dev-only trees. zod 3.x has no patched release; `@intutic/shared-types` and
  `@intutic/mcp-proxy` use it and stay flagged until they move to zod 4.

### Changed

- **The open-source docs build refuses plan names in running text** (the paid plans),
  as it already refused hosted-service terms, and the pages that named them now keep those
  sentences in the paid-only blocks.
- **`SECURITY.md` lists 3.0.x as the supported line.** Package descriptions and footers no
  longer describe the open-core packages as a control plane.

## [3.0.5] - 2026-10-26

### Fixed

- **The Python SDK gate applies a snapshot rule's WHERE clause.** The `.rules` file
  carries a SOP rule's `WHERE` clause as an optional seventh column, and the bash and
  JavaScript gates fire the rule only when the clause also matches the serialized call.
  The Python reader ignored the column, so a rule such as `shell WHERE kubectl
  +apply(?!.*@sha256:)` acted as "every `shell` call" and refused `ls` and `make test`.
  A clause that does not decode or compile still downgrades that rule to name-only,
  as in the other gates, rather than dropping a block rule.
- **`GateClient.from_env()` reads the OS keychain.** With CLI 3.x `credentials.json`
  holds the marker `keychain` instead of the token, and the client sent it as the
  bearer token, so every control-plane tier answered 401. It now reads the token the
  CLI stored (macOS Keychain, `secret-tool` on Linux), as the VS Code extension does.
- **`plan_approval:` exempts `read_file` and `list_directory`,** the LangChain and
  LangGraph names for the read and listing tools, in every gate (shared types,
  `@intutic/gate`, the Python SDK and the Python gate the daemon writes). Without them a
  LangGraph agent could not read its way to a plan.

## [3.0.4] - 2026-10-21

### Changed

- **The Python SDK has no `crewai` extra.** Install crewai alongside it:
  `pip install intutic-clawde crewai`. Every crewai release pins `uv` below
  0.13.4, the fix for GHSA-hq85-5cpj-mr62, so the extra put a vulnerable uv
  in the SDK's lockfile. The CrewAI adapter is unchanged.
- **The `autogen` and `smolagents` extras require Python 3.11.** Both pull in
  Pillow, every Pillow up to 12.3.0 is vulnerable (2026-10-20 advisories),
  and the fix, 13.0.0, requires Python 3.11. The SDK itself and its other
  extras still support Python 3.10.

### Security

- **Dependencies moved past the 2026-10-20 advisories:**
  - follow-redirects 1.16.1, markdown-it 14.3.3 and hono 4.13.13.
  - vite 6.4.4. The docs site's vitepress moves off vite 5 too: no patched
    5.x exists, and the docs render identically on 6.4.4.
  - certifi 2026.10.19 and Pillow 13.0.0.
  - mcp 2.1.1, past GHSA-84m7-p3x7-pcfv. crewai's `mcp~=1.28.1` pin had held
    it back.

## [3.0.3] - 2026-10-19

### Changed

- **The hook gates refuse more ways for an agent to switch governance off.**
  `intutic daemon stop` and `intutic daemon uninstall` (and `uninstall-daemon`),
  which take down the sync-daemon or, with `--proxy` or `--mcp`, the governing
  proxies; `intutic logout`, which stops policy sync and the audit-trail
  upload; any read or write of `~/.intutic/credentials.json`; and
  `intutic disconnect` run as `node …/cli.js`, which 3.0.2 missed. You can
  still run them yourself. The Kitkat skill lists them.

## [3.0.2] - 2026-10-19

### Added

- **`intutic gates install` installs the bundled agent skills** (Kitkat and
  rule authoring) where the workspace has none, so an agent learns how to work
  under governance without a control plane. Before, only `intutic connect`
  wrote them. `--dry-run` lists them, and `intutic disconnect` removes them.

### Changed

- **The hook gates refuse an agent switching governance off.**
  `intutic decide disable`, `intutic decide configure` (and `judge
  configure`), `intutic disconnect`, setting `INTUTIC_GUARD_DISABLE`, and any
  read or write under `~/.intutic/decide/` are refused when an agent runs
  them. You can still run them yourself.
- **The Kitkat skill is current for 3.0.** It covers working with no control
  plane, the 3.0 refusals (`PREREQUISITE_UNMET`, `OUT_OF_SCOPE`,
  `PLAN_NOT_APPROVED`, lane holds, `NODE_KIND_DENIED`, decide escalations and
  outages) and what to do about each, and it tells an agent never to get past a
  refusal by changing governance. It no longer says the hook gates block
  destructive commands: they flag them.

### Fixed

- **Saving a SOP warns about gateways too old for its keys.** 3.0.0 said the
  control plane warned when a SOP used a key the workspace's gateway could not
  read, but nothing did. `POST` and `PUT /api/v1/sops` now return a
  `sop_key_needs_newer_gateway` warning naming each such key and each of the
  organization's registered gateways older than the key's release (or that has
  never reported its version). The save still succeeds.
- **A `mode: shadow` SOP's decide rules run as shadow at a local proxy too.**
  The hook gates and SDKs already did, as 3.0.0 said; the proxy ignored the
  SOP's mode when no control plane served the rules, so a pinned rule in a
  shadow SOP enforced there.
- **dsh profiles get `@intutic/gate` 3.** A profile with no `@intutic/gate`
  declaration was given `^2.0.0`, which cannot evaluate 3.0 rules and refuses
  what they cover. A profile set up by an earlier version keeps its
  declaration; upgrade it with `pnpm add @intutic/gate@^3` in the profile.
- **`/intutic start` without `--sops` keeps every local SOP in the rules
  files.** The empty selection it sends was read as "select nothing", so the
  rules files left out every folder and flat file you wrote, while the daemon
  logged "all". Enforcement was unaffected.
- **The MCP governance proxy treats a blank `INTUTIC_HOST` or
  `INTUTIC_WORKSPACE_ID` in `runtime.env` as unset**, so it falls back to the
  documented default instead of an empty control-plane address.
- **Terraform provider 0.7.1:** `intutic_workspace_settings` manages
  `loop_review` field by field, as the API stores it, so a configuration
  naming one field no longer shows a change on every plan.

## [3.0.1] - 2026-10-19

### Fixed

- **The Apple silicon CLI binary runs.** `cli-macos-arm64` shipped unsigned,
  and macOS kills an unsigned arm64 binary at launch, so the download did
  nothing (exit 137); `npm install -g @intutic/cli` was unaffected. The release
  pipeline now ad-hoc signs both macOS binaries and runs the arm64 one before
  publishing it.

## [3.0.0] - 2026-10-19

### Added

- **Loops, graphs and gates.** New SOP front-matter keys, every one opt-in:
  nothing changes until a SOP or the workspace sets one.
  - **`requires_before: action:run_tests[ok] -> X`:** X needs a passing test
    run in the session, not just any run. The gateway pairs tool results with
    their calls and withholds X before it runs; the hook gates read the
    harness's post-tool hook where its payload carries an exit code or error
    flag (Claude Code, Gemini CLI), and refuse with a "not observable" reason
    elsewhere. A later file change, by a write tool or a shell command such as
    `sed -i` or `git checkout`, makes a pass stale.
  - **`scope_paths_mode: enforce`** refuses a file change outside
    `scope_paths` at the gateway (in band) and at every hook gate;
    **`plan_steps_mode: enforce`** re-asks on any off-plan step at the gateway.
  - **`plan_approval: required | strict`** refuses calls at the hook gates and
    SDKs until the session's plan is approved; `strict` also refuses tools the
    plan does not name.
  - **Reversibility lanes:** `closed_lanes: irreversible | reversible_wide`
    holds every action of the lane for a person, at the gateway and every
    gate; top-level `open_actions:` reopens one action. The workspace setting
    `closedLanes` closes a lane for everyone. New action tokens:
    `action:migrate`, `action:prod_write`, `action:destroy` (including a
    forced recursive `rm` outside the working tree), `action:force_push` and
    `action:payment`.
  - **Revert lane:** `revertLane` holds a wide but reversible action whose
    recent revert or rejection rate reached a threshold.
  - **`on_reask_exhausted: pause`** pauses a loop run for review when
    correction is exhausted, instead of refusing the request.
  - **Graph keys:** `context_isolation:` flags sibling workers given the same
    brief; `node_kind:` / `node_kind_allow:` limit what a splitter, worker,
    code or gate node may do.
- **Loop verify** checks a run's changes against `scope_paths` and its tool
  sequence against `plan_steps` before any judge is asked, and
  `loop_review.requireVerifiedCompletion` makes completing a run need a
  passing, current verify (`E_LOOP_NOT_VERIFIED`, `E_LOOP_UNVERIFIABLE`,
  `E_LOOP_VERIFY_STALE`).
- **Structured refusals:** a refusal carries `scope` (paths, tools, step,
  detector, rule) and `evidence` so an agent can retry outside it; exit-code
  hook harnesses get a `[Intutic] Retry scope:` line. OPAQUE workspaces get
  only the code.
- **New refusal codes:** `PREREQUISITE_UNMET`, `OUT_OF_SCOPE` (gateway, gates
  and hooks), `OFF_PLAN`, `PLAN_NOT_APPROVED` (gates and hooks),
  `NODE_KIND_DENIED` (gateway, 403) and `LOOP_RUN_PENDING_REVIEW` for a
  paused run.

- **Decide rules: decision guardrails on a self-hosted model.** SOP front
  matter accepts `decide:` lines, one JSON rule per line. A rule asks a
  self-hosted decision model a few yes/no or multiple-choice questions about
  a proposed tool call and combines the answers: true refuses, false allows,
  unknown escalates. See the Decide guide.
  - **Every gate evaluates them,** after its deterministic rules and only on a
    call those rules allow, so a decision can add friction but never lift a
    refusal. The exception is OpenCode 2.x, whose gate refuses the tools an
    enforcing rule names.
  - **Escalation asks the person where the harness can ask:** Claude Code,
    Cursor (shell and MCP hooks), GitHub Copilot, Antigravity 2.0, Hermes,
    OpenClaw and dsh. Everywhere else it refuses with `DECIDE_ESCALATED`.
  - **Shadow until proven:** a rule enforces only after a pre-registered
    `intutic decide eval` passes and pins it to the engine's model digest.
    A known-answer canary must also pass. Otherwise the rule runs in shadow
    and says why.
  - **`intutic decide`:** `test`, `eval` (with `--preregister` and
    `--adversarial`), `calibrate`, `models`, `check --stdin`, `configure`,
    `disable`/`enable` and `lint`.
  - **`doctor` and `start`:** `intutic doctor` checks the engine, its model,
    the canary and each harness's time budget. `intutic start` warms the
    model and runs the canary.
  - **The decide log and its drift alarm,** kept on the machine: 30 days,
    uploaded only when switched on.
  - **The engine is always self-hosted:** an OpenAI-compatible server with
    token log-probabilities, a System One server, or an OpenAI
    Decisions-format server. Hosted decision APIs are refused. No default
    model ships, because no laptop-sized model passed our evaluation.
  - **SDK `decide()`** in `@intutic/gate`, `@intutic/clawde` and
    `intutic-clawde`, through the same guard.
  - **New refusal codes:** `DECIDE_REFUSED`, `DECIDE_ESCALATED` and
    `GOVERNANCE_UNAVAILABLE`. An enforcing rule whose engine is unavailable
    refuses.
  - **Older gates:** a gate older than this release refuses the tools a decide
    rule names, through a fallback line in the policy snapshot.
  - **Response rules at the gateway:** the proxy evaluates `on: response`
    rules on model responses, and decide rules on the tool calls in a
    response. A refused response gets a violation note, and an unreadable
    `decide:` line refuses responses.
    - `intutic decide test` and `intutic decide eval` build the same response
      state the gateway sends, so a pin measures what the gateway asks.
    - The gateway writes the decide log.
    - On a shared gateway it uses the pins its policy serves, and uploads
      decisions when the workspace turns that on.
  - **`intutic decide eval --calibration <id>`** pre-registers a served
    calibration's band. When logged in, `decide eval` registers and uploads
    its runs.
  - **Reserved:** the `last_user_turn` context is read but not supplied yet.
  - **A `mode: shadow` SOP** now runs its decide rules in shadow on a local
    machine too.
- **Governance of calls to decision models.** The proxy recognises System One
  (`POST /v1/systemone`) and OpenAI Decisions (`POST /v1/decisions`) traffic
  and governs it like an LLM call.
  - **Before the call:** DLP on the state or input, the egress allowlist, and
    a refusal of moving aliases such as `jev-latest` in enforce mode.
  - **After the call:** a confidence floor and a `consequential` header that
    tell the app to abstain or ask a person.
  - **Records:** each call is one Governed Request and gets a record in the
    decision-traffic log.

### Changed

- **Hook gate body v23.** A policy snapshot that carries any of the new rule
  records is written in format 3; one without them is unchanged.
- **Older gates fail closed.** A gate older than v23 (and the 2.9 SDKs) cannot
  evaluate the new rules, so it refuses what each covers through a
  `<kind>-fallback:` line in the snapshot: the gated call for a qualified
  `requires_before`, every file change for `scope_paths_mode: enforce`, every
  call for `plan_approval:`. Lane holds use phrase rules every gate since v12
  reads, so older gates hold them too (a force push by the partial phrase
  `git push --force`); one approval releases a held call at every gate. A
  gateway older than 3.0.0 ignores the new keys; the control plane warns when
  a SOP uses a key the workspace's gateway is too old to read.

### Deprecated

- **The local judge environment variables:** `INTUTIC_GATEWAY_LOCAL_JUDGE`,
  `LITELLM_LOCAL_URL`, `LITELLM_LOCAL_API_KEY`, `LITELLM_LOCAL_JUDGE_MODEL`,
  `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`/`_HI` and
  `LITELLM_LOCAL_TYPED_JUDGE_MODEL`. They are read until 4.0.
  - **With a typed band,** the gateway maps them to an equivalent decide rule.
    It decides inside the band as `AMBIGUOUS`, without asking the free-text
    judge.
  - **`intutic judge configure`** now writes the decide engine
    configuration.

### Fixed

- **The SDK gates no longer let a shadow or warn match hide a later block.**
  `@intutic/gate` and the `intutic-clawde` gate returned on the first
  matching snapshot rule, so a `shadow` or `warn` rule earlier in the
  snapshot stopped a later `block` or `hold` from ever being checked. The
  harness gates already kept looking. Both SDKs, and the managed-agents
  sandbox gate, now decide as the harness gates do: every shadow and warn
  match is recorded, the first block or hold decides, and after an approved
  hold the remaining rules still apply. `snapshot.evaluate()` returns the
  recorded matches as `advisories`.

## [2.9.1] - 2026-10-17

### Fixed

- **A nested `mode: shadow` no longer switches a whole SOP to shadow.** The
  front-matter parsers read `mode:` on any line, at any indentation, so an
  indented `mode: shadow` inside some other block put the entire SOP,
  `deny_tools` included, in shadow: evaluated and logged, never enforced. Keys
  that can only weaken a SOP (`mode:`, `roles:`, `risk_tier:`, `sql_guard:`,
  `sql_allow_dsns:` and `intutic_enforced:`) now count only at the top level,
  in the proxy, the sync daemon and the shared parser. Keys that add a rule
  still count at any indentation.
- `intutic disconnect` no longer says a setting "was removed rather than
  restored: an earlier Intutic version set it" for a file Intutic itself
  created, such as `~/.gemini/config/hooks.json` after `intutic gates
  install` on a clean machine. The file is deleted when nothing else is in
  it; the note is kept for files an older version wrote without a record.

## [2.9.0] - 2026-10-16

### Added

- **`intutic gates install`: harness gates without a control plane.** Until
  now only `intutic connect` wrote the harness hook gates and rules files, and
  it needs a control plane, so the open core ran the proxy alone. The new
  command compiles the SOPs in `.intutic/sops/` into a local policy snapshot
  and writes each recorded harness's gate and rules file from it, with no
  account and no network. `--harness <id>` limits it to one harness,
  `--dry-run` prints what it would write, and `--route` also points the
  harnesses' LLM traffic at the proxy (off by default, so a harness keeps
  working when the proxy is not running). It refuses on a machine that is
  logged in to a control plane, where `connect` installs the gates.
  `intutic disconnect` takes everything out again and restores the files it
  changed.
  - `intutic init` offers to install the gates (`--gates` / `--no-gates`).
  - `intutic start` refreshes installed gates before the proxy starts and
    whenever `.intutic/sops/` changes (`--no-gates` skips it).
  - `doctor` checks the local policy snapshot and that each recorded harness
    has its gate; `status` says whether gates are installed locally or by
    `connect`.
  - With no control plane, a `review_before:` token makes the gate refuse
    the call, saying that holding it for approval needs a control plane.

### Fixed

- `intutic disconnect` left an empty `"permissions": {"deny": []}` in a
  Claude Code settings file that had none before.
- The Claude Code hook command quotes the gate's path, so a workspace whose
  path contains a space works.
- Open-core messages (`status`, the git hooks, `doctor`) no longer point at
  commands that need a control plane.
- The docs, READMEs and the Kitkat skill describe the open-core path
  (`intutic init`, then `intutic gates install`, then `intutic start`), and
  say what the destructive-command tier does: the hook gate flags
  `rm -rf /`, `mkfs` and similar rather than blocking them, while the proxy
  refuses them in a model's code-execution tool call.

## [2.8.1] - 2026-10-16

### Changed

- **No default control plane.** Only the open core is released, so nothing
  points at a hosted control plane by default any more. The CLI, `@intutic/clawde`,
  `@intutic/gate`, `intutic-clawde` and the Terraform provider use a control
  plane only when one is named: `INTUTIC_CONTROL_PLANE_URL`,
  `--control-plane-url`, `--dev`, the URL `intutic login` saved, or the
  provider's `endpoint`. A command or client that needs one and has none says
  so and stops: the CLI exits 1, `ControlPlaneClient` and a keyed
  `GateClient` throw on construction, `checkBudget()` /
  `check_budget()` raise `ClawdeConnectionError`, and the provider reports
  "Missing control-plane endpoint". A `GateClient` with no API key is
  local-only, as before. Generated hook scripts carry the address `connect`
  used, or none.
- **The CLI's help lists the open-core commands.** The commands that need a
  control plane (`login`, `connect`, `keys`, `org`, `team`, `guardrails`,
  `gateway`, `siem` and the rest) and the on-prem `judge configure` and
  `enterprise install` are hidden from `--help`; they still run. `doctor` on a
  machine with no login skips its control-plane checks instead of failing
  them, and points at `intutic start`.
- **The docs build in the open-core edition by default.** The docs image
  takes `DOCS_EDITION` (`oss` by default, `full` for a bundle that ships the
  control plane). The open-core edition leaves out every section whose heading
  carries a plan badge, as it already left out such pages, and a link to a
  page it leaves out renders as plain text.
- Release flags live in `packages/shared-types/src/release.ts`, with copies in
  the Python SDK and the Terraform provider;
  `node tools/scripts/release-content.js --check` (in `pnpm lint:claims`)
  fails when they disagree.

## [2.8.0] - 2026-10-15


### Added

- **API keys from the CLI and the SDKs, scopes included.** `intutic keys
  list`, `intutic keys create --label <label> [--scopes <a,b>]
  [--expires-in-days <n>] [--service-account]`, `intutic keys update <keyId>
  --scopes <a,b>` and `intutic keys revoke <keyId>` list, create, re-scope and
  revoke API keys (`/api/v1/keys`); scopes are checked against `API_SCOPES`
  before anything is sent. `ControlPlaneClient` gains `listApiKeys`,
  `createApiKey`, `updateApiKey` and `revokeApiKey` (`@intutic/clawde`), and
  `list_api_keys`, `create_api_key`, `update_api_key` and `revoke_api_key`
  (`intutic-clawde`). Until now only the dashboard and Terraform could set a
  key's scopes.
- **The SOP Optimizer's Approval mode from the CLI, the SDKs and Terraform.**
  Since `featureFlags.ff_metaclaw_auto_apply` was removed in 2.5.1, the
  Approval mode (`manual` or `auto`, with its auto-apply threshold) could only
  be set on the SOP Optimizer page. `intutic optimizer settings` and
  `intutic optimizer set --mode <manual|auto> [--auto-threshold <n>]` read
  and set it (`set` keeps the current threshold unless given one);
  `getOptimizerSettings` / `updateOptimizerSettings` (`@intutic/clawde`) and
  `get_optimizer_settings` / `update_optimizer_settings` (`intutic-clawde`)
  do the same; and the Terraform provider (0.5.0) adds
  `intutic_sop_optimizer_settings` (destroy sets the mode back to `manual`).
  `GET` and `PUT /api/v1/dream-cycle/settings` publish their response schema.
- **Task-management connections from the CLI, the SDKs and Terraform.**
  `intutic tasks list`, `intutic tasks add --provider <jira|linear|pagerduty>
  --base-url <url> --project-key <key> [--account-email <email>]
  (--token <token> | --token-file <path>)`, `intutic tasks test
  <connectionId>` and `intutic tasks remove <connectionId>` manage the
  Jira, Linear and PagerDuty connections, which only the dashboard could
  before; the token is never echoed. `ControlPlaneClient` gains
  `listTaskConnections`, `createTaskConnection`, `testTaskConnection` and
  `deleteTaskConnection` (`list_task_connections`, … in `intutic-clawde`),
  and the Terraform provider (0.5.0) adds `intutic_task_connection`: the API
  token is a sensitive argument the API never returns, every argument
  replaces the connection (there is no update route), and an imported
  connection is replaced on its first apply, which sends the configured
  token. The four task-management routes publish their response schemas.
- **Notification rules on `plan.rejected` and `plan.closed`.** The control
  plane sent both, and no rule could name them; the API, the CLI and the
  Terraform provider accept them.

### Changed

- **The gate SDKs name a key that lacks the hook gate's scope.** A key without
  `gateway:use` (or `*`) gets `403 INSUFFICIENT_SCOPE` from
  `POST /api/v1/hook-gate`. `@intutic/gate` and `intutic_clawde.gate` read it as
  an unreachable control plane: refused, with a reason that never named the
  scope, under `failClosed`, and let through ungoverned with `failClosed` off.
  It is now refused whatever `failClosed` says, with the code
  `INSUFFICIENT_SCOPE` and the scopes the key needs, like `INVALID_REQUEST`. The
  refusal the gate throws carries `INSUFFICIENT_SCOPE` (a new gate refusal
  code), and the AgentCore interceptor denies such an answer the same way,
  whatever `INTUTIC_FAIL_OPEN` says.

### Removed

- **Four notification event types nothing emitted**: `incident.escalated`,
  `sop.status_changed`, `session.ended` and `calibration.threshold_breach`,
  from `NOTIFICATION_EVENT_TYPES` and the Terraform provider (0.5.0). A rule on
  one could never deliver; the API refuses them, and the control plane's
  migration 246 deletes existing rules on them. `tools/scripts/check-feature-surfaces.js`
  now fails when a listed event type has no emitter, when an event the
  router sends is not listed, or when the dashboard's rule picker or the
  settings guide leaves one out.

### Fixed

- **`@intutic/clawde`: `signupOrg` accepts `acceptTerms`.** 2.7.0 made the
  signup routes require `acceptTerms: true`, but the TypeScript
  `OrgSignupParams` had no such field, so a call that passed it did not
  compile and one that left it out was refused with 400
  `TERMS_NOT_ACCEPTED`. The field is now part of the type, and required.
  (The Python `signup_org(accept_terms=...)` was already right.)
- **`POST /api/v1/auth/resend-verification` answers 404 and 409 as documented.**
  An address with no account got `500` instead of `404` (`E_NOT_FOUND`), and an
  address already verified `500` instead of `409` (`ALREADY_VERIFIED`). Both
  answers now carry `code`. The API reference names `E_NOT_FOUND`, the code the
  route returns, where it said `USER_NOT_FOUND`.
- **The control plane's Valkey subscribers honour `VALKEY_TLS`.** The
  subscribers that read proxy traces and mirror pairs from Valkey opened their
  own connection without TLS, so against a TLS-only Valkey they could not
  connect unless `VALKEY_URL` was also written as `rediss://`. They now connect
  with the same settings as the control plane's other Valkey connection.
- **The Kitkat skill explains `INVALID_REQUEST`**, the code the hook gate
  answers when it cannot read the request a gate SDK sent: a refusal whatever
  the fail-open setting, and an integration fault to report rather than retry.
- **The rule-author skill no longer says `intutic skill audit` catches secrets
  in rule sources.** The audit reads skill directories and root rule files such
  as `CLAUDE.md`, not WASM rule sources or mock contexts.
- **The proxy and `intutic connect` read the same SOP files.** The proxy read
  only the `.md` files directly in `.intutic/sops/`, while `intutic connect`
  read only the files one folder down (`.intutic/sops/<set>/*.md`), so a SOP
  was enforced by the proxy or written into the harness rules files, never
  both. Every reader now takes both layouts: the proxy (a file in a folder is
  titled `<set>/<name>`), `intutic connect`, the gate's local `review_before`
  holds, `intutic sops status` and the agent report. Folders whose name starts
  with `.` are skipped, so a Kubernetes ConfigMap mount is not read three
  times. `intutic connect` leaves out `guardrail-*.md` files and pulled copies
  of SOPs it already receives from the control plane, so the rules files do
  not hold a SOP twice.
- **A session's `--sops` selection no longer switches enforcement off.** It is
  made from inside the agent's own chat, yet it decided which local SOPs'
  `review_before:` holds the gates applied. It now narrows only the text
  written into the harness rules files; every gate holds on every local SOP,
  and the proxy enforces every file.
- **A pulled SOP is enforced locally only when the control plane enforces
  it.** `intutic sops pull` writes drafts and SOPs in shadow too, and the
  proxy and `intutic connect` enforced every file it wrote. Each pulled file
  now records `intutic_enforced: true` (an active `VALIDATED` SOP) or
  `intutic_enforced: false` (any other state, or a SOP no longer active), the
  key follows the server on every pull, and every local reader skips a file
  marked `false`. While a file edits a draft forked from an approved SOP, the
  approved version stays enforced locally in `<name>.approved.md` beside it
  (written by `push` and kept by `pull`, never sent by `push`); the first pull
  after the draft is promoted removes it, leaving one enforced file.
- **Single-file SOPs are selectable rule sets.** `/intutic initialize`,
  `/intutic start --sops` and `intutic loop start --sops` offered folders only;
  a file directly in `.intutic/sops/` is now a rule set too, listed after the
  folders as `.intutic/sops/<name>.md` and selected by name with or without
  `.md`. Copies of workspace SOPs (files recording an `intutic_id:`) are not
  listed.
- **The README's first SOP enforces what it shows.** Its commands sat under a
  "Denied Commands" heading that no gate reads. The sample now declares them
  in front matter the proxy enforces (`hook_rule:` lines and
  `sql_guard: refuse`), and a proxy test parses the sample from the README and
  checks each refusal.
- **The SOP Optimizer's routes work with an API key.** Every
  `/api/v1/dream-cycle` route (the queue, approving and rejecting a
  proposal, the manual trigger and the settings) answered 400 "Missing
  x-workspace-id header" to a caller that did not send the header, which
  only the dashboard does; they now fall back to the caller's workspace.
- **Revoking an API key you have no live key for is a `404`.**
  `DELETE /api/v1/keys/:id` answered `200 { "revoked": true }` for an id
  that did not exist, belonged to another member or was already revoked, so
  a mistyped id read as a revocation (and a second revoke rewrote the
  revocation time). It now answers `404` with
  `{ "error": "API key not found", "code": "E_NOT_FOUND" }` and changes and
  records nothing; `intutic keys revoke` says so and exits 1, and the SDKs'
  `revokeApiKey` / `revoke_api_key` raise. The Terraform provider already
  treats a `404` on destroy as gone.
- **An owner or admin can revoke any member's API key.** `DELETE
  /api/v1/keys/:id` looked only among the caller's own keys, so an
  administrator offboarding someone, or a Terraform destroy run with
  another admin's key, could not withdraw it. An OWNER or ADMIN now revokes
  any live key in the workspace (a DEVELOPER or VIEWER still only their
  own; a key in another workspace is a `404`), and the credential change
  records the key's owner beside who revoked it (`owner_id` in SIEM export,
  `ownerId` on the audit timeline). `intutic_virtual_key` (Terraform
  provider 0.5.0) keeps such a key in state and revokes it on destroy: its
  refresh read only the caller's keys and dropped it.
- **Six notification events reached no rule.** `sop.cascade.alert`,
  `sop.cascade.invalidated`, `finops.tokens.classified` and the three
  `org.cells.*` events were emitted without naming a workspace, and the
  notification router can only dispatch an event to the rules of the
  workspace it names, so a rule on any of them was accepted and never fired.
  The cascade events name the root guideline's workspace (and carry the
  fields the router reads), `finops.tokens.classified` the workspace whose
  traces were classified, and each `org.cells.*` event every workspace of the
  org. `identity.offboarding.completed` was emitted and never routed; it now
  reaches its rules, HIGH when a step of the offboarding failed and INFO
  otherwise.

## [2.7.0] - 2026-10-15

### Added

- **Signup records acceptance of the Terms and the Privacy Policy.** The
  signup and org-signup request schemas (`SignupInputSchema`,
  `OrgSignupInputSchema`) require `acceptTerms: true`, the signer's
  confirmation that they are 18 or older and agree to the Terms and the
  Privacy Policy; a request without it is refused with 400 and the new error
  code `TERMS_NOT_ACCEPTED`. `AcceptTermsInputSchema` is the body for accepting
  an updated version later. The documentation describes the signup box, the
  members an administrator adds (covered by their organization's agreement)
  and how updated terms are announced and accepted.

### Changed

- **Breaking (SDKs):** `signupOrg` takes `acceptTerms: true` in its params
  (TypeScript), and `signup_org` takes a required keyword argument
  `accept_terms` (Python). Without it the control plane refuses the call.
- **The corrective-card dataset is opt-in.** The workspace setting
  `governanceCardLabelingEnabled` now defaults to `false`. When an owner or
  admin turns it on, corrective cards and whether they were followed are kept
  and used only to improve Intutic's own self-hosted judge models, never for
  training without a policy update.
- **Retention periods for sign-in, billing and audit records.** These were
  kept with no end. A connected workspace's sign-in records (time, method,
  IP address, user agent) are now deleted after 12 months, and with the
  account when it is erased; expired refresh tokens 12 months after expiry.
  Billing records are kept for 7 years, including after the workspace is
  deleted, then deleted. Deleting a workspace still deletes its traces, audit
  records, findings and policies with it; the rows that outlived that delete
  (sign-in records, the notification log, derived statistics, policy text no
  other workspace shares) are now deleted within 90 days. A daily sweep
  applies each period, and the append-only guards let it delete only rows
  past their period.
- **A workspace with a budget alert can be deleted.** The alert held a
  reference that refused the delete; it is now deleted with the workspace.

### Fixed

- **A workspace moved to the free plan gets the free plan's spend caps.** A
  personal workspace downgraded by a cancelled subscription, or by the third
  failed payment, kept the paid plan's daily cap and monthly budget.
  Cancellation now sets the free plan's caps and clears the
  billing interval and term; the failed-payment downgrade lowers the caps to
  the free plan's (never raises them) and restores the exact earlier caps,
  including any an administrator set, when the payment is made. Organisations
  already worked this way.

- **Anthropic Managed Agents: a webhook delivery no longer re-answers old
  pauses.** `poll()` (TypeScript `IntuticSessionConfirmer`, Python
  `IntuticSessionConfirmer`) read a session's events oldest first and answered
  each pause before seeing its later confirmation, so a fresh confirmer, which
  a webhook handler creates on every delivery, re-sent a confirmation for every
  pause the session had ever had; Anthropic accepted the duplicate without
  applying it, but it woke the idle session. `poll()` now reads every
  confirmation before answering anything. Verified against the live API.

- **Change records stored before 2.6.0 are withheld.** The targets in a
  trace's change manifest (commands, paths, URLs) have been redacted for
  secrets and personal data since 2.6.0; those stored earlier are replaced
  with `[WITHHELD]` when the control plane upgrades, keeping each entry's
  tool, operation, kind, risk and size. Integrity roots sealed over those
  traces still verify: `POST /api/v1/integrity/roots/:rootId/recompute`
  lists them in the new `redactedTraceIds`, and any later edit to such a
  trace is still reported in `changedTraceIds`.

## [2.6.0] - 2026-10-14

### Added

- **Response schemas for the routes the machine clients call.** Nine more
  control-plane operations publish their response body in `openapi.json`,
  171 in all: `GET /api/v1/policy/resolve`, `GET /api/v1/auth/key-context`,
  `GET /api/v1/decisions/:entryId`, `POST /api/v1/judge/chunk`,
  `GET /api/v1/sync/report`, `GET /api/v1/workspace/egress-policy`,
  `GET /api/v1/workspace/decisions-digest`,
  `POST /api/v1/mcp/servers/observe` and
  `POST /api/v1/integrations/agentcore/gateway-check`. The clients that read
  them are pinned to the schemas: the MCP proxy and the sync daemon read
  their answers as `WireFields<…>` (new in `@intutic/shared-types`: every
  field the schema declares, each `unknown` until checked), `@intutic/gate`,
  the AgentCore interceptor and the VS Code extension check their own types
  against the schemas at compile time, and the LLM proxy's tests read
  captured key-context and workspace-policy answers
  (`packages/shared-types/fixtures/responses/`) that are held to their
  schemas.
- **Unsubscribe from the onboarding emails.** Every email the control plane
  sends is now classified as transactional or promotional in one table. The
  promotional ones (the day-3 and day-7 onboarding emails) carry a one-click
  unsubscribe link and the `List-Unsubscribe` / `List-Unsubscribe-Post`
  headers (RFC 8058), are skipped for a recipient who unsubscribed, and print
  the sender's postal address from the new `COMPANY_POSTAL_ADDRESS` setting
  (Self-host: `.env` or the chart's `companyPostalAddress`). Unset, they still
  send and the control plane logs the gap at start-up. Sign-in, billing and
  alert emails are unaffected.
- **Notification event types for failed payments.** `billing.dunning.downgraded`
  (the third failed payment moved the account to the free plan) and
  `billing.dunning.restored` (the plan is back); notification rules and the
  Terraform provider's `intutic_notification_rule` accept both.

### Security

- **The sync daemon's config no longer carries the workspace's storage
  credentials.** `POST /api/v1/sync/config`, and the config the sync
  WebSocket pushes, went to every member's machine with the workspace's own
  trace bucket settings in full: the access key id and the stored (encrypted)
  secret access key or service-account credentials, which
  `GET /api/v1/workspace/settings` shows as `__redacted__`. The daemon reads
  none of them, so they are no longer sent; the rest of `byocStorage`
  (provider, bucket, prefix, project, region, mode) is unchanged.
- **The VS Code extension's panels escape what they render.** The SOP,
  incident and WASM rule panels put titles, names and other API values into
  the webview's HTML as they were, so a SOP titled
  `<img src=x onerror=…>` became markup. Every value is now escaped, badge
  classes come from a fixed list, and each panel carries a strict
  Content-Security-Policy (`default-src 'none'`, styles by nonce, no scripts).
- **chromadb advisories under the `crewai` extra, re-checked.** `crewai`
  requires `chromadb`, and every chromadb release up to 1.5.9, the latest,
  is affected by CVE-2026-45829, CVE-2026-45830, CVE-2026-45831 and
  CVE-2026-45833; none has a fixed release, so the lockfile stays at
  chromadb 1.1.1 (moving to 1.5.9 would fix none of them). All four need a
  running ChromaDB server; the CrewAI integration only uses the embedded
  `PersistentClient`, and the two code-injection paths also need
  `sentence-transformers`, which no extra installs. The CrewAI integration
  page now covers current crewai releases (chromadb 1.5.x) and warns against
  exposing the `chroma run` server chromadb installs.

### Fixed

- **`GET /api/v1/auth/me` answers 404 for a member that no longer exists.** A
  valid token for a member removed since it was issued answered 500
  `Internal server error`; it now answers 404 with
  `{ "error": "Member not found", "code": "E_NOT_FOUND" }`.
- **A guardrail write never answers success without the guardrail.** Create,
  update and promote read the guardrail back after the write and answered
  `{ "ok": true, "guardrail": null }` when the read found nothing, which a
  client such as the Terraform provider stored as an empty resource. Such a
  write now answers 500 `GUARDRAIL_READ_BACK_FAILED` with the `guardrailId`,
  and `guardrail` is no longer nullable in the response schemas or the SDK
  types.
- **`intutic sops pull` writes no `risk_tier:` for a SOP without a tier.** It
  wrote `risk_tier: null`; the key is now left out, and a pull over a file
  whose SOP lost its tier removes the line. `sops status` and `sops push`
  read such a file as untiered and send no tier.
- **Terraform: a SOP's null columns read as null.** `intutic_sop` decoded
  `riskTier`, `complexityTier`, `versionCounter` and `contentHash` into plain
  strings and integers, so a SOP written without tiers imported with
  `risk_tier = ""`, and one without a version counter was updated with
  `version_counter = 0`, which the API refuses. They now read as null, and an
  update sends no counter when there is none.
- **The VS Code incidents panel shows incidents.** It read `items`, while
  `GET /api/v1/incidents` sends its rows under `data` (TOON-encoded from 20
  rows, which the panel's request of 20 always got), and named fields the
  route never sends. It now asks for 19 and shows each incident's type,
  status, severity and date; the SOP panel shows the risk tier in place of a
  score the route never sent.
- **A plan downgraded for a failed payment comes back once it is paid.** The
  third failed payment moved the account to the free plan, and nothing moved
  it back: a customer who fixed the card kept paying for the subscription
  while on free. Paying the overdue invoice while the subscription is still
  open now restores the plan its price sells. Events delivered out of order
  are judged by when they happened: a failure older than the payment that
  cured it does not downgrade, an update older than the downgrade does not
  undo it, and a cancelled subscription is never restored. An invoice that
  bills no subscription no longer changes the plan.
- **The proxy no longer writes the Valkey password to its log.** A
  `VALKEY_URL` with credentials (`redis://user:password@host:6379`) was
  printed whole in the startup lines that name the Valkey it connected to, or
  failed to reach. The password is now shown as `***`.

### Removed

- **Workspace DLP patterns in the MCP proxy.** The proxy read `dlpPatterns`
  from `GET /api/v1/sop/rules`, which never sent it, and from
  `GET /api/v1/policy/resolve`, which always sent `[]`: no workspace setting
  holds custom DLP patterns, so the field and the scanner path it fed carried
  nothing. Both routes and the proxy drop it. Custom DLP patterns stay a
  setting of the LLM proxy's own configuration (`dlp.patterns`).
- **Enforcement policies, ahead of their December 1 sunset.** Nothing ever
  enforced a policy's tool pattern, action or conditions, and no one depends
  on them yet, so they go now rather than after a deprecation window. Gone:
  the policies API (`/api/v1/policies`: list, create, update, delete,
  versions, enable, disable, rollback) and
  `POST /api/v1/policies/:policyId/convert-to-guardrail`, which now answer
  `404`, along with their `Deprecation` and `Sunset` headers; the dashboard's
  **Policies › Enforcement Policies** page; `intutic policy
  enable|disable|rollback|export|convert` (the rule and snapshot commands,
  `intutic policy snapshot|test|compile|install|list-local|replay`, stay);
  `listPolicies`, `enablePolicy`, `disablePolicy`, `rollbackPolicy`,
  `CompliancePolicy` and `PolicyChangeResult` from `@intutic/clawde`, and
  `list_policies`, `enable_policy`, `disable_policy`, `rollback_policy` and
  `PolicyChangeResult` from `intutic-clawde`; the `Policy*Response` schemas in
  `@intutic/shared-types`; Terraform's `intutic_policy` (provider 0.4.0); and
  the `pcas_policies` and `pcas_policy_versions` tables with
  `policy_guardrails.converted_from_policy_id` (migration 239, which refuses
  to run while either table holds a row, so it never deletes a policy).
  **Instead:** write a per-tool rule as a `hook_rule`
  [policy guardrail](https://docs.intutic.ai/guide/policy-guardrails)
  (`intutic guardrails`, `intutic_guardrail`), which the gates enforce once it
  is promoted, and set what a refused agent is told with the
  `interventionMode` workspace setting.
- **The intervention-mode fallback to a policy.** The `interventionMode`
  workspace setting is the only source of the mode; a workspace that has not
  set it, or holds a value that is not a mode, is `TRANSPARENT`. The mode is
  no longer read from the lowest-priority active policy, and the
  once-per-workspace warning about it is gone. **Instead:** set
  `interventionMode` (Settings › Security › Intervention mode, `intutic
  settings set interventionMode OPAQUE`, `intutic_workspace_settings`).
- **Full access for API keys with unrecognised scopes.** A key whose stored
  scopes are all outside the scope registry (free-form strings such as
  `["read"]`, written before scopes were enforced) no longer works as `*`: it
  grants nothing, and every request with it is refused with `403
  INSUFFICIENT_SCOPE`, like any key lacking a scope. The `apikey_legacy_scopes`
  log line, the `legacyScopes` field on `GET /api/v1/keys` and the dashboard's
  **Legacy scopes** badge are gone. **Instead:** give the key registry scopes
  with **Edit scopes** or `PATCH /api/v1/keys/:keyId`, or replace it.

## [2.5.1] - 2026-10-14

### Added

- **Response schemas in the OpenAPI document.** 162 control-plane operations
  now publish their response body in `openapi.json`
  (`x-intutic-response-schema: zod`): every one the SDKs (`@intutic/clawde`,
  `intutic-clawde`, `@intutic/gate`), the CLI and the Terraform provider call,
  apart from the evidence download, which answers with a file. The schemas live in
  `@intutic/shared-types` (`src/responses/`, exported as zod schemas with
  their inferred types), and each route declares the one it answers with, so
  the document is generated from the code, not written beside it. CI holds
  them true: the compiler checks each handler's body against its schema, a
  test makes a real request to every declared route and fails on a field the
  schema lacks, does not list, or types differently, and the SDK operations
  fixture's mock bodies are checked against the same schemas. The TypeScript
  SDK's response types are pinned to the schemas at compile time, and the
  Python SDK's TypedDicts and the Terraform provider's response structs by a
  test, so none can name a field the control plane does not send.

- **The LLM proxy enforces hook-rule policy guardrails.** A hook rule now
  reaches the proxy as a `hook_rule:` line in the SOP the workspace policy
  serves (and the file `intutic guardrails pull` writes). The response gate
  withholds a call an enforcing rule refuses before the client sees it, with a
  `TOOL_DENIED` refusal naming `guardrail.<id>`, on streams and off them: a
  rule that names only the tool decides on the call's first event, and one
  that constrains arguments holds the call's block until its arguments are
  complete. A request whose latest turn reports a refused call is refused too.
  A shadow rule is reported on the trace and refuses nothing. A rule line the
  proxy cannot read, or arguments that are not JSON under a rule that
  constrains them, refuse rather than let the call through. The proxy tests
  the rule's literals as substrings of the serialised input, which is what the
  rendered pattern the other layers use means.
- **One decision for every layer, pinned.**
  `packages/shared-types/fixtures/guardrail-layer-vectors.json` holds
  guardrails, what is served for them, a tool call and the expected decision;
  the emitted hook gates, `@intutic/gate`, `intutic-clawde`, the MCP proxy and
  the LLM proxy each run it, and the proxy now also runs the hook-rule vectors.
- **Hook rules scoped to roles are enforced.** A hook-rule guardrail that names
  workspace roles applies only to members holding one of them, at every layer,
  by the role of the member behind the caller's key. The LLM proxy reads it
  from the key context and applies the rule's `roles`; the hook gates, the SDK
  gates and the MCP proxy are served only their member's rules. A caller whose
  role is not known is held to every rule. A role change applies on the
  member's next call, and on a connected machine at its next sync at the
  latest. A hook rule may name only workspace roles (owner, admin, em,
  developer, viewer): any other name is refused when the rule is created or
  its rule edited, by the API, the CLI, Terraform at plan time and the
  dashboard. A rule written before that keeps being served and is flagged on
  its review card.

- **An OpenAPI 3.1 document for the control plane's REST API.**
  `apps/docs/public/openapi.json` lists every route with its auth, plan badge,
  path parameters, and the schema of every request body and query string:
  each route that reads one validates it, and the generator refuses a handler
  that reads either without a schema. A new OpenAPI Reference docs page renders it (vitepress-openapi
  0.2.5, loaded only on that page, no third-party requests). It is generated
  from the route source with the route catalog in `reference/api.md`, and CI
  fails while either is stale. Like the REST API page, the open-source docs
  build leaves the page and the file out.
- **SDK API reference on the docs site, generated from the source.**
  `/reference/sdk/` documents every export of `@intutic/gate` (each subpath in
  its `exports`), `@intutic/clawde` and the Python `intutic-clawde` package
  (each public module's `__all__`), built by `pnpm gen:sdk-reference` with
  TypeDoc and a griffe-based Markdown renderer. CI fails when the committed
  pages are stale: the TypeScript half in `lint:claims`, the Python half in
  the Python SDK job. The clawde and Tool Gate SDK pages stay as guides and
  link to it; their hand-kept option tables and `ControlPlaneClient` method
  table are gone. The options of `GateConfig`, `GateClientOptions`,
  `ClawdeClientOptions` and `ControlPlaneClientOptions` now carry their
  defaults in their doc comments, and every framework adapter module in
  `intutic_clawde.gate.adapters` declares `__all__`.

### Security

- **The MCP daemon's shared policy cache is per caller.** Its Valkey entry
  was keyed by workspace only, while the policy it holds is the calling key's
  member's (their role's hook rules, their SSO groups): two daemons with
  different members' keys on one Valkey could be served each other's entry,
  so a member could get a less restrictive rule set. Entries are now keyed by
  workspace, a policy generation and a hash of the daemon's key, and a policy
  change bumps the generation, which retires every caller's entry at once.

### Changed

- **Behaviour change: a request body or query string that does not match its
  route's schema is a `400`.** Every control plane route that reads one now
  validates it. A value of the wrong type that a handler used to drop or
  replace with its default (`?limit=abc`, `firewall.active: "yes"` in a device
  report, a loop budget of `"lots"`), and a body that crashed a handler into a
  `500` (a JSON `null`, a SCIM user without `userName`, a SCIM user PATCH
  without `Operations`), is refused with the route's own `400`; SCIM answers
  `invalidSyntax`, or `invalidValue` for paging. A numeric limit out of range
  is still clamped, and attributes and parameters a route does not read are
  still ignored. The requests the CLI, the SDKs, the dashboard and the
  Terraform provider send all pass.
- **Behaviour change: replay contexts keep tool-call argument keys, not
  values.** The context the proxy samples onto 5% of traces
  (`WASM_CONTEXT_SNAPSHOT_RATE`) carried every tool call's full arguments.
  Each call now keeps its name, `argument_keys` (the top-level keys) and
  `argument_bytes`, and the context says `tool_arguments: "keys_only"`. A
  workspace that replays rules reading `tool_calls[].arguments` can opt in
  with the new `storeToolArguments` setting (off by default); the values are
  then kept as `tool_arguments: "redacted"`. Snapshots from older proxies are
  reduced to keys and sizes when they are ingested, the ones a control plane
  already stored are reduced when it upgrades, and `intutic policy replay`
  says how many contexts withheld arguments.
- **What the proxy keeps is redacted for every PII detector, email and phone
  included.** Live defaults are unchanged (card, IBAN and SSN redact; email and
  phone off, because an agent shown a redacted address writes the placeholder
  back into the file). The copies the proxy keeps are another matter: replay
  contexts and change-manifest targets are redacted for every secret pattern
  and all five detectors, whatever their live actions, recorded as each
  detector's new `stored_action` in `pii_detectors.json`.
- **The response cache does not store an exchange DLP matches.** An entry holds
  the prompt text and the answer for 24 hours; a prompt or answer with a secret
  or any PII match is now served without being cached. The cost posture
  descriptions, which all turn exact caching on, say what the cache keeps.

- **Breaking for SIEM rules: traces, detector findings and device events get
  their own CEF classes.** All of them went out over syslog as
  `AGENT_TOOL_CALL` (device events as `AGENT_TOOL_CALL_UPDATE`) at severity 5,
  though none is a tool call. Now `execution_traces` is
  `AGENT_MODEL_REQUEST` (severity 1), `detector_findings` is
  `DETECTOR_FINDING` (severity from the finding: 10, 7, 4 or 1), a disabled
  firewall is `DEVICE_ENFORCEMENT_DISABLED_UPDATE` (7) and a device that
  stopped reporting is `DEVICE_ENFORCEMENT_STALE` (4). The CEF header's
  device version goes from `1.0` to `2.0`, so a rule can tell the two apart.
  The stopped-reporting alert changes no record, so it is no longer labelled
  "(Updated)": its `mutationType` is `INSERT` at every destination, and one
  already in the dead-letter queue is retried as an `INSERT`. A source with
  no class is refused instead of sent under a default, and a test fails when
  an exported source has none. Update Sentinel, Splunk or ArcSight rules that
  match the old classes; the SIEM export guide's "Changed in 2.5.1" lists
  old and new.
- **The gate SDKs report every hook-gate answer with its decision id.** The
  control plane's hook gate (`POST /api/v1/hook-gate`) now names each verdict
  it gives (allow, refusal, degraded allow) with a `decisionId`, an additive
  response field, and its own SIEM `gate_decisions` record carries it as
  `decision_id`. `@intutic/gate` and `intutic_clawde.gate` read it
  (`GateResponse.decisionId` / `decision_id`; a `GOVERNANCE_UNAVAILABLE`
  refusal keeps it only while failing closed) and send the `tool_blocked` or
  `tool_allowed` event that reports the call with it as `gateDecisionId`
  (`GateClient.emit(..., gateDecisionId)` / `emit(..., gate_decision_id=)`),
  so the control plane files the decision's incident once and exports the
  decision to SIEM once. The report of a DLP refusal, whose incident the hook
  gate files itself, no longer files a second one, and the refusal's
  `incidentId` now names the stored incident. In an OPAQUE workspace the incident filed from the
  report names the rule, not the generic sentence. Both SDKs run the updated
  shared `hook-gate-response-vectors.json`.
  **Upgrade note:** an SDK older than this release sends no
  `gateDecisionId`; each hook-gate decision it reports still reaches a SIEM
  destination twice (once from the hook gate with a `decision_id`, once from
  the report without one), and a DLP refusal it reports is still filed as a
  second incident, as before. Upgrade both SDKs for one record and one
  incident per decision.
- **Behaviour change: API key scopes are enforced.** A key's `scopes` were
  stored and never read, so every key could do everything its owner's role
  allowed, and an attenuated child key that "narrowed" its parent kept the
  full role. A request made with a key now needs both the owner's role and a
  scope covering the route, or it gets `403` with code `INSUFFICIENT_SCOPE` and
  `requiredScopes`. The scopes form one fixed registry
  (`API_SCOPES` in `@intutic/shared-types`): `*` (everything, the default
  and what existing keys hold), `gateway:use` (agent traffic: LLM calls
  through the proxy, hook gates, hook events, trace sync-back, holds, the SOP
  rules and policy snapshot) and `<area>:read` / `<area>:write` for thirteen
  areas of the REST API, `write` covering `read`. Creating or editing a key
  with an unknown scope is refused with `400` naming the valid ones; a key
  cannot grant a scope it does not hold. The proxy refuses LLM traffic from a
  key without `gateway:use`. Child keys (`intutic attenuate --caps`) take
  registry scopes, must descend from the caller's own key, and are held to
  every ancestor's scopes on each request. The Terraform provider validates
  `scopes` at plan time. **Compatibility:** a key whose stored scopes are all
  outside the registry (free-form strings such as `["read"]`) keeps working as
  `*` until **2.6.0**, when it is refused; the control plane logs
  `apikey_legacy_scopes` on each use and the dashboard marks the key. See
  [API key scopes](https://docs.intutic.ai/reference/api#api-key-scopes).

- **Behaviour change: `withIntuticProxy()` points providers at the proxy's
  `/v1` routes.** `@intutic/gate/vercel` (and its `@intutic/gate/eve`
  re-export) passed the bare proxy URL as `baseURL`, and `@ai-sdk/openai` and
  `@ai-sdk/anthropic` append `/chat/completions`, `/responses` or `/messages`
  to it, so every request missed the proxy's `/v1/*` routes. It now passes the
  proxy URL plus `/v1`, leaving a URL that already ends in `/v1` (or
  `/v1beta`) unchanged. The new `intuticProxyBaseUrl()` returns the same value.
  Tests drive the real provider SDKs and assert the path each one requests.
- **Behaviour change: a gate SDK client with no API key is local-only.**
  `GateClient.fromEnv()` (`from_env()`) with no key in the environment or
  `~/.intutic/credentials.json` built a client whose hook-gate call got a 401,
  which failing closed turned into a refusal of every tool call that is not
  read-only. Such a client now sends nothing: the SOP register and hook gate
  are skipped, the hook gate's answer is an allow with code `LOCAL_ONLY` that
  says so, and events and holds are not sent, while the SSO group, policy
  snapshot, MCP server and image tiers still decide, as the integration pages
  already said. A configured key the control plane refuses still fails closed.
  `GateClient.localOnly` (`local_only`) reports it. Both SDKs run the shared
  `gate-client-credentials-vectors.json`.
- **`resolveContext()` (`resolve_context()`) reads the environment once
  `intutic init` has run.** It read every field from `~/.intutic/config.json`
  as soon as that file existed, and the file `intutic init` writes has none of
  them, so the workspace, session, branch, CI pipeline and incident came back
  empty. Each field now comes from the file when it carries it and from its
  environment variable otherwise, in `@intutic/clawde` and `intutic-clawde`.
- **Behaviour change: the SOP Optimizer applies a change without review only
  when it strengthens the guideline.** With `ff_metaclaw_auto_apply` on, a
  manually started run applied any proposal that cleared the auto-approve
  threshold, a weakening rewrite included, and did it by retiring the reviewed
  guideline and putting an unreviewed draft in force. Now a proposal is applied
  only when the change classification is `STRENGTHEN` (it adds a safety rule,
  removes none, and is not more than a fifth shorter). Every other proposal,
  and any the classifier could not classify, waits for review with its
  classification and the reason. An applied change becomes the next version of
  the guideline in the same lifecycle state, with an audit row naming
  `system:metaclaw`. A `WEAKEN` edit needs an Owner whoever makes it: no caller
  is exempt for not declaring a role.
- **Behaviour change: the SOP Optimizer's Approval mode is its only switch,
  and the optimizer now runs.** It looked for guidelines in a lifecycle state
  that does not exist, so it never proposed anything; it now works on enforced
  guidelines (validated and active), at most 5 a cycle, one proposal each, and
  none for a guideline with a pending proposal or one proposed in the last 24
  hours. `featureFlags.ff_metaclaw_auto_apply` is removed (a settings `PUT`
  that sends it is refused, and the Terraform provider rejects it): Approval
  mode **manual** applies nothing, **auto** lets a run an Owner or Admin
  starts apply a strengthening proposal, and the hourly sweep only proposes.
  Each workspace keeps what it had without loosening: the flag on becomes
  auto, and auto without the flag becomes manual. Incident mining is
  proposal-only in both modes; auto no longer marks its drafts auto-approved.
- **Behaviour change: editing a guideline past draft keeps it enforcing.**
  Editing a SOP that is not a draft, or approving an amendment against it,
  retired the version you edited at once and put the edit in a new draft, so
  a validated guideline stopped enforcing until the draft was carried through
  review and shadow. The edited version now keeps its state until the new
  version is promoted to validated, which is when it is retired.

### Deprecated

- **Enforcement policies, sunset December 1, 2026.** No gate or proxy ever
  read a policy's tool pattern, enforcement action, conditions or risk
  category, so a policy never refused or changed a tool call; the docs,
  dashboard and Terraform provider said otherwise and now say what is true.
  A policy's one effect, the workspace's intervention mode, is now the
  `interventionMode` workspace setting (dashboard Settings › Security, `intutic
  settings set interventionMode`, `intutic_workspace_settings`). Every gate
  reads the setting first; until 2.6.0 a workspace that has not set it still
  takes the mode of its lowest-priority active policy, and the upgrade copies
  that mode into the setting for every workspace with an active policy, so
  nothing changes. `intutic policy convert <id>`, the dashboard's **Convert
  to guardrail** and `POST /api/v1/policies/:policyId/convert-to-guardrail`
  turn an active `KILL` or `REASK` policy on one tool into a `hook_rule`
  guardrail in shadow (its `argContains` / `argNotContains` conditions carry
  over), never enforcing, since the policy never blocked anything; converting
  twice returns the same guardrail. The policies API answers with
  `Deprecation`, `Sunset` and `Link` headers, `intutic policy
  enable|disable|rollback|export` print a notice on stderr, and the Terraform
  provider (0.3.0) deprecates `intutic_policy` and its fields, makes
  `target_tool_pattern` and `enforcement_action` optional, and accepts
  `interventionMode` in `intutic_workspace_settings`. The "no force push"
  examples are `intutic_guardrail` hook rules now.

### Fixed

- **Security: SCIM deprovisioning from Microsoft Entra ID now offboards the
  member.** Entra writes the PATCH `op` capitalised and booleans as strings
  (`{"op": "Replace", "path": "active", "value": "False"}`, or the path-less
  `{"op": "Replace", "value": {"active": "False"}}`); the user PATCH matched
  `replace` and `false` exactly, so the member stayed active with every API
  key and session while Entra recorded the user as deprovisioned. `op` and
  attribute names are now matched in any case (RFC 7644 §3.5.2), a SCIM
  boolean may be `"true"`/`"false"` in any case, and each form runs the
  offboarding cascade, as a PUT with `"active": "False"` does. An emails
  replace takes the address whose `primary` is `"True"`. Members an Entra
  sync should have deprovisioned before this release are still active and
  need deprovisioning again.
- **Client response types that disagreed with the control plane**, found by
  the response schemas (the route is right in each case):
  - `intutic login` with a password read the workspace and email from the top
    of the login answer, which nests them under `member`, so it saved neither
    and printed "Authenticated as undefined".
  - `@intutic/clawde` and `intutic-clawde`: `SopCreateResult` is the created
    SOP the route returns (it never sent `ok`); `BundleUploadResult` drops
    `error` and `detail`, which only a failed upload carries (and a failed
    call raises); `SiemDestinationList.items` are `SiemDestinationSummary`
    rows, which carry no `config` or `signingSecret`; a SIEM destination's
    `lastHeartbeatAt` and `lastError` are optional (the create answer has
    neither); `GatewayStatus`'s heartbeat fields are optional (a live gateway
    omits what it did not report); a guardrail write or transition's
    `guardrail` and a readiness's counters may be `null`; `SopDetail.riskTier`
    may be `null`; `createTeam` and `createWorkspace` return only the fields
    the routes send.
  - The CLI: `gateway status` printed "undefined" for heartbeat fields a
    gateway did not report; `guardrails sources add` read the new source's id
    from a wrapper the route does not send; SIEM destination and SOP record
    types follow the routes.
  - The VS Code extension's SOP browser showed "undefined" for every SOP: it
    read `name`, and the route sends `title`.
- **A refusal now wins over an earlier flag-only rule.** `@intutic/gate`,
  `intutic-clawde` and the MCP proxy took the first SOP rule matching a call,
  so a `warn` rule (a shadow guardrail, or the high-risk reminder) listed
  before a matching `block` rule let the call through with only a flag. They
  now take the most severe match: block, then require-approval, then warn,
  ties in list order.

- **A proxy with Valkey and no control plane accepts your provider key.**
  `intutic start` runs a local Valkey whenever Docker is up, and a proxy that
  found one looked every token up in Valkey's auth cache, which nothing writes
  without a control plane: every request got `401 Virtual API key is invalid,
  expired, or revoked.` There is now one rule for a proxy with no control
  plane configured, whether or not Valkey is up: it behaves as standalone. A
  provider key passes through, and a virtual key is accepted with the provider
  key from the proxy's environment used upstream. A managed proxy is
  unchanged.
- **Slash-command and `/intutic predict` answers stream when the client
  streams.** An `/intutic` command's answer came back as one JSON body even on
  a `"stream": true` request, which a streaming client (Claude Code, Cursor)
  reads as nothing. The proxy's own answers now use the route's SSE format on
  a streaming request (Anthropic Messages, OpenAI chat completions and the
  Responses API) and name the request's model: the streamed cost prediction
  always said `claude-3-5-sonnet`.
- **A custom rule cannot allow a call by returning HIJACK or ENHANCE.** The
  proxy's merge of WASM and Rego verdicts ignored both, which would have let
  the call through. No runner produces them, and a rule has no way to supply
  a rewrite or guidance, so a rule that ever returned one is now refused as
  one that reached no verdict (`GOVERNANCE_UNAVAILABLE`). The docs no longer
  say a WASM rule can rewrite a request, and the SDK guide says what to
  return instead.
- **`phi()` is not a taint.** The taint detector matched a `phi()` that the
  SOP parser, the guardrail IR and the control plane's replay all refuse;
  the dead branch is gone. `pii()` covers custom `phi` patterns, and the
  parser's error now says so.
- **A skill's semantic verdict covers the whole file.** With
  `semanticSkillAnalysisEnabled`, `intutic skill audit` sends the first 65,536
  characters of each `SKILL.md`, and the verdict was keyed by the hash of that
  text, so a skill judged clean could gain any tail past the cap and keep its
  verdict; the judge also read only the first 16 KiB of what it was sent. The
  CLI and the sync daemon now send the SHA-256 and length of the whole file
  (`fullSha256`, `fullLength`), and the verdict is keyed by the whole file. The
  judge reads everything it is sent, in up to four overlapping windows, each
  counted against the daily judge cap; a flag in any window flags the skill. A
  file longer than 65,536 characters is never reported clean: it is
  `partially_scanned` and needs review ("Only the first 64K (65,536) characters
  were checked"), and `intutic skill audit` names it in a warning. The
  deterministic pattern scan still reads the whole file.
- **Terraform provider 0.2.1: import, refusal and example fixes.** An
  imported `intutic_mcp_server_decision` that leaves `disabled_tools` unset
  plans clean (`disabled_tools` now shows the server's switched-off tools);
  `intutic_workspace_budget` refuses an import id other than the key's
  workspace ("Wrong workspace"); an API refusal shows the explanation it
  carries in `detail` (a 403 names the roles the route allows) instead of a
  bare `Forbidden`; and the `intutic_member_budget` example uses the `mbr_…`
  member id shape. See `packages/terraform-provider-intutic/CHANGELOG.md`.
- **Subpath types for `moduleResolution: node`.** `@intutic/gate` and
  `@intutic/sync-daemon` pointed `typesVersions` at `src/*.ts`, which their
  tarballs do not contain, so a consumer on `moduleResolution: node` got no
  types for `@intutic/gate/vercel` and the other subpaths. They now point at
  the published `dist/*.d.ts`, and `@intutic/sync-daemon` gains the missing
  `lib/atomicWrite` entry. `tools/scripts/check-package-entrypoints.js`, run
  in CI after the build and before packing a release, fails when any `main`,
  `types`, `bin`, `exports` or `typesVersions` path of a published package is
  not in its `npm pack` tarball.
- **`intutic_clawde.gate` exports what `@intutic/gate` does.** `fetch_register`,
  `parse_register`, `SopRegister` and `READ_ONLY_TOOLS` (which the docs already
  listed as exported) are importable from `intutic_clawde.gate` and in its
  `__all__`.
- **The clawde SDKs default to the API host.** With no `controlPlaneUrl`
  (`control_plane_url`) and no `INTUTIC_CONTROL_PLANE_URL`, `ClawdeClient`'s
  budget check and session registration and `ControlPlaneClient` called
  `https://app.intutic.ai`, the dashboard, which does not serve `/api/v1`.
  Both SDKs now default to `https://api.intutic.ai`, as `@intutic/gate`, the
  Python gate client and the CLI already did, from one constant per language
  (`DEFAULT_CONTROL_PLANE_URL`).
- **The rule-author skill describes what the proxy does.** It said a rule that
  breaks the sandbox limits is silently disabled (every request it cannot
  judge is refused with `GOVERNANCE_UNAVAILABLE`) and that a KILL from any rule
  ends the request (WASM rules return BLOCK). The download, the copy
  `intutic connect` writes and the repo's own copy are fixed, and
  `tools/scripts/check-rule-author-skill-copies.js` (`lint:claims`) fails when
  the download or the embedded copy differs from `.agents/skills/`.
- **Docs drift gates.** `lint:claims` gains `check-docs-code-blocks.js` (a
  fence line with text after it, which leaves a code block open, and
  `intutic init` samples that show relative paths: 21 integration pages did,
  now fixed) and `check-doc-tables.js` (enforcement-action tables and counts
  against `EnforcementAction`, SOP lifecycle tables and diagrams against
  `VALID_SOP_TRANSITIONS`, the graph-guardrails detector table against the
  proxy's detector registry, the clawde SDK's "What's covered" against the
  operations fixture, and the tier matrix against the plan map), and
  `check-harness-counts.js` reads "N supported agent tools", "36 of the 43"
  and the other phrasings it missed. The MCP coverage table now matches the
  gate registry, which had Windsurf as unconfirmed.

- **`sudo intutic enforce apply` exempts you, not root.** Under `sudo` the
  firewall's default `--uid` was root's, so the proxy you run with
  `intutic start` was denied egress. The CLI and `intutic-proxy enforce` now
  default to the invoking user (`SUDO_UID`) when running as root under sudo.
  The Jamf and Intune firewall manifests run as root with no sudo, so their
  script now passes the console user's uid (`stat -f %u /dev/console` on
  macOS, seat0's active session on Linux).
- **`intutic doctor` finds the CA `intutic connect` trusted on Linux.** It
  looked only for `intutic-ca.crt`; connect installs `intutic-connect-ca.crt`.
- **`intutic loop start`, `complete`, `kill` and `list` exit 1** when the
  control-plane call fails or is refused, instead of printing the error and
  exiting 0.
- **`intutic policy snapshot`** no longer says the previous snapshot is
  untouched when a refused key rewrote it, and `intutic policy replay` names
  the plan rather than your role when the plan refused it.
- **`intutic guardrails`:** `list --limit` help states the server's default
  200 and cap 1000; `sources list` shows a source's last failed sync; `docs
  extract` reports an unreachable cap store (503) as such and exits 1.
- **`intutic integrity chain`** says older roots were not walked rather than
  printing the endpoint's one-row probe as a count.
- **`intutic judge configure`** prints docs links instead of paths into
  Intutic's own source tree.
- **`intutic sops push` updates the SOP a file came from instead of creating
  a duplicate.** `sops pull` now records each file's SOP in its front matter
  (`intutic_id:`, `intutic_revision:`), and push edits that SOP through the
  dashboard's edit path: a DRAFT in place, an approved SOP as a new DRAFT
  version while the approved one keeps enforcing. The recorded revision is
  the precondition, so a SOP edited on the control plane since the pull is
  refused (`--force` overwrites); an unchanged file is a no-op; a deleted SOP
  needs `--create`; a WEAKEN edit's Owner refusal is printed. A file with no
  record is created and then recorded. Push also takes a single file, the
  layout pull writes, as well as a folder; pull and status read both layouts,
  match files by the recorded id, and pull keeps a file's other front-matter
  keys. The SOP listing and detail now carry `priorVersionId`.
- **The AutoGen `.env.intutic` comment leads with `IntuticWorkbench`**, which
  governs `AssistantAgent`'s own tool calls, as the integration page does.

### Removed

- **`ClawdeBudgetExceededError` (`@intutic/clawde`).** Nothing threw it: a
  budget refusal (`BUDGET_EXCEEDED`, `OVERAGE_HARD_CAP_EXCEEDED`) has always
  been a `ClawdeBlockedError` carrying that `code`, which is what to catch.
  Code that imports the class must drop the import.
- **`_internal` from `@intutic/gate/harness`.** A test hook exported from the
  public subpath. The tests now read the hook script through
  `intuticSandboxBootstrap()`.
- **`CreateScimTokenSchema` and `CreateScimTokenInput` (`@intutic/shared-types`).**
  Nothing used them, and they disagreed with the API (a 255-character label,
  365 days): the control plane validates a new SCIM token with its own schema
  (label 1–128 characters, required; 1–3650 days), which the OpenAPI document
  describes. `ScimTokenInfo` goes too: no API response or client used its shape.

## [2.5.0] - 2026-10-13

Everything that reached `main` since 2.4.0. Check these behaviour changes
before upgrading: the control plane's hook gate (`POST /api/v1/hook-gate`) now
fails closed, so an integration that counted on it answering `allowed: true`
when a check errored, or when it could not read the body, is refused (403
`GOVERNANCE_UNAVAILABLE`, 400 `INVALID_REQUEST`); the gate SDKs and the
AgentCore interceptor refuse a `GOVERNANCE_UNAVAILABLE` unless set to fail open,
and a 400 whatever that setting says. A workspace whose intervention mode is
`OPAQUE` now gets what the mode promised: its refusals on workspace policy no
longer name the rule. The sync daemon regenerates every hook gate as gate body
v21 (`GATE_VERSION` 21) on its next cycle. No LLM judge runs on a plan that does
not include it (Free). Code that imports the `@intutic/shared-types` exports
listed under Removed, names `github` or `asana` as a `TaskProvider`, calls
`TaskManagementAdapter.createTask` or `updateTask`, or implements
`IntuticPlugin::priority` must change, as must any notification rule or
Terraform `intutic_notification_rule` naming `ssl.enforcement.violation`,
`context_gap.auto_injected` or `adapter.write_back.failed`: the API refuses
those event types, and the control plane's migrations delete existing rules on
them. A Jira connection added without the account email stops working; add it
again with the email.

### Added

- **Agent chaos engineering.** `intutic chaos run <experiment>` runs an agent
  in the sandbox with a known fault injected by the component already on that
  path, checks what the agent did next and scores it. The LLM proxy injects
  rate limits, upstream errors and stream cuts, context trims, silent model
  downgrades, and DNS and 401 failures on a host; the MCP proxy injects tool
  errors, stale data, tool-set changes and planted tool-result text; the hook
  gates inject permission denials and delays and built-in tool errors. Faults
  apply only to calls governance allowed, every injected error carries a
  canary, and deterministic probes (task success across repetitions,
  destructive attempts, whether the failure was surfaced, policy hits, cost
  multiplier, recovery) give a weighted resilience score. A run whose baseline
  fails, or in which no fault fired, is reported as invalid. Chaos runs record
  no routing rewards, write nothing to the local trace log and never report to
  a workspace. `intutic chaos validate` and `intutic chaos list` check an
  experiment and print the fault catalog; three example experiments ship with
  the CLI. See the chaos engineering guide.
- **The gate SDKs take part in chaos runs.** `@intutic/gate` and
  `intutic_clawde.gate` honour a chaos plan like the hook gates; an injected
  failure refuses with the new gate code `CHAOS_FAULT`. A permission delay
  works like an approval hold: the first matching call is refused as held
  (`HELD`) and the identical retry passes once `delay_s` has elapsed, or is
  refused for `hold_then_deny`.
- **A Node sandbox image**, `intutic/sandbox:<version>-node`, built on demand
  as the base for agents that need Node; and `intutic chaos run` carries a
  project's generated gates, snapshot and hook settings into each repetition,
  rewritten for `/work`, so a real harness finds its gates in the sandbox.
- **Behavioural drift alerts are routable.** `anomaly.drift.detected` is a
  notification event (**Guideline Compliance Drifted**): sent once per drift
  when an enforced guideline's compliance moves 0.15 or more from its baseline
  in the hourly check, HIGH when it fell and INFO when it rose. The dashboard
  offers it, and the Slack and email alerts name the guideline and both
  numbers.
- **The integrity probe checks that foreign keys are enforced.** The hourly
  `audit_log_integrity` probe fails when any foreign key in the schema has an
  internal trigger that is disabled or replica-only (left behind by
  `DISABLE TRIGGER ALL`, for example after an interrupted restore), and
  `governance.integrity.failed` gains the kind `foreign_key_unenforced`. See
  Trace Integrity for the fix.
- **`fetchRegister` / `parseRegister`** in `@intutic/gate` (with the
  `SopRegister` type) and `fetch_register` / `parse_register` in
  `intutic_clawde.gate.soprules` read the SOP register with the workspace's
  intervention mode beside the rules (`GET /api/v1/sop/rules`).
- **`TaskSearchFilters`** and `TaskProviderCredentials.accountEmail` in
  `@intutic/shared-types`.

### Changed

- **Behaviour change: the `OPAQUE` intervention mode is enforced.** In a
  workspace whose mode is `OPAQUE`, every refusal on workspace policy tells
  the agent only "Blocked by workspace policy. Ask a workspace admin if you
  need this action." instead of the rule's name, text, matched pattern or
  remediation. Refusal codes, HTTP statuses and exit codes are unchanged; a
  held call still names its hold id. It applies in the hook gates, the gate
  SDKs (from the policy snapshot, or from the SOP register when there is no
  snapshot), the control plane's hook gate, the LLM proxy (which drops the
  `x-intutic-refusal-rule` header) and the MCP proxy (whose `error.data.ruleId`
  is empty); a gate's JSON decision carries a null `ruleId`. Hook events,
  traces, findings, incidents and the SIEM export keep the full reason.
  `OPAQUE` does not hide SOP guidance the agent is meant to read
  (`intutic_list_sops`), the MCP registry status tool, or the LLM proxy's
  refusals while it fails open during a control-plane outage. `TRANSPARENT`
  and `SILENT_LOG` are unchanged; the policies guide and the Terraform
  `intutic_policy` docs describe each mode as built, `SILENT_LOG` as local-gate
  only.
- **A policy change reaches every gate at once.** Creating, editing, enabling,
  disabling, deleting or rolling back a policy moves the config version, so the
  LLM proxy reads the new mode on its next request, running MCP proxies on
  their next poll and connected sync daemons refresh the policy snapshot
  immediately.
- **Gate bodies are v21** (`GATE_VERSION` 21; 2.4.0 shipped v18). v19 and v20
  added the chaos fault injection and v21 the `OPAQUE` record in the policy
  snapshot, inside its digest. The sync daemon regenerates every hook gate on
  its next cycle; outside a chaos run and an `OPAQUE` workspace the gates
  decide exactly as before.
- **Behaviour change: the control plane's hook gate (`POST /api/v1/hook-gate`)
  fails closed.** It used to answer `allowed: true` whenever a check errored.
  Now a check that could have refused the call and could not run (the SOP
  rules, the SSO group policy, the MCP server registry and allowlist, image
  provenance, promoted repeat findings) refuses it with HTTP 403 and
  `code: GOVERNANCE_UNAVAILABLE`, unless another check refuses it first with
  its own reason. A check the workspace has not configured refuses nothing. A
  workspace in shadow mode (`ff_shadow_enforcement`) is allowed through with
  `degraded: true`; one whose flag cannot be read counts as enforcing. A body
  the gate cannot read is refused with HTTP 400 and `code: INVALID_REQUEST`,
  where it used to be allowed.
- **The gate SDK clients decide `GOVERNANCE_UNAVAILABLE` as an unreachable
  control plane.** `@intutic/gate`'s and `intutic_clawde.gate`'s `GateClient`
  refuse it under `failClosed` / `fail_closed`, whose default stays `true`
  (fail closed) in both, and allow it only with that setting off. A 400
  `INVALID_REQUEST` is refused whatever the setting (with the setting off it
  used to be allowed), and an answer with no boolean `allowed` counts as no
  verdict (it used to be read as an allow). Both clients are held to the
  shared `hook-gate-response-vectors.json`.
- **The AgentCore interceptor decides `GOVERNANCE_UNAVAILABLE` the same
  way.** The control plane's AgentCore gateway check now refuses with a 403
  `GOVERNANCE_UNAVAILABLE` when its DLP scan or SOP rules cannot run (a
  degraded allow in shadow mode), and the interceptor Lambda decides that by
  `INTUTIC_FAIL_OPEN`, closed by default; a 400 `INVALID_REQUEST` is denied
  whatever that setting says. The QM security screen answers the same outage
  with a strict score, since QM's client lets any non-2xx through as
  unscreened.
- **Behaviour change: LLM judging runs only on plans that include it.** The
  key-context answer carries `llmJudgeEnabled`; on `false` the LLM proxy makes
  no `/judge/chunk` or `/judge/finalize` call and passes the response through
  unjudged, with no note, still stripping an `/intutic judge` prefix. An absent
  or null field, an unreachable control plane and a refused key keep judging as
  before. On a plan without it (Free) `/judge/chunk` and `/judge/finalize`
  answer 403 `FEATURE_NOT_AVAILABLE`, agent judge scores are refused, and the
  trajectory monitor's review of an ambiguous window is skipped: the heuristics
  decide, as when the review model is unreachable, and the alert's
  `trajectoryWindow.judge` says `not_in_plan`. `PASSIVE` and `ACTIVE` and the
  monitor's deterministic checks run on every plan, and any plan's owner or
  admin can set the mode.
- **Task Management reads Jira, Linear and PagerDuty only.**
  `TaskManagementAdapter` is read-only and `TaskProvider` is
  `'jira' | 'pagerduty' | 'linear'`. A ticket key in a branch or commit is
  matched to the connection with that project or team key, case-insensitively,
  so Linear's lower-case branch names resolve. With PagerDuty connected, a
  session that names no ticket picks up the newest triggered or acknowledged
  incident assigned to its member, found by email, instead of the newest
  incident on the whole service. `searchTasks` takes `TaskSearchFilters`, must
  apply `assigneeId`, and rejects when the provider cannot be asked, so a
  caller can tell "nothing open" from "could not ask".
- **Jira connections take the Atlassian account email.** Jira Cloud signs an
  API token in as `email:token`; **Add Connection** asks for the account email
  for Jira and saves a connection only once the provider accepts its
  credentials.
- **`/intutic initialize` lists open Jira and Linear tickets** (up to 10 per
  connection, newest first, in parallel), names a tracker it could not reach
  within 5 seconds, and marks the ticket the git branch names as Recommended,
  with no model call. PagerDuty incidents are not listed.
- **The trajectory spool drops a summary a retry cannot deliver.** A summary
  the control plane refuses with a non-retryable 4xx (malformed, a VIEWER key,
  another workspace's session) is dropped, on first submission or in the drain,
  with one warning naming the session and status, never the payload. 401, 408,
  429, 5xx and network errors keep retrying.

### Fixed

- **Gate scripts and harness settings are replaced atomically.** The sync
  daemon and the CLI wrote them in place, so a harness could run a
  half-written gate; for Claude Code a gate that crashes with an exit code
  other than 2 does not block, so the call could proceed ungoverned. Gate
  scripts are also executable from the moment they appear (a Cline gate was
  briefly in place without its mode, which switched the hook off), and
  `runtime.env` is created owner-only instead of being narrowed afterwards.
- **A project's own Claude Code deny rules survive a sync.** The project's
  `.claude/settings.json` deny list was replaced by Intutic's on every cycle;
  only rules an earlier sync wrote are swapped now.
- **No false tamper reports from the daemon's own writes**: regenerating the
  hardened goose plugin no longer files a SECURITY override incident, also on
  a machine where the plugin cannot be made immutable (Linux without root), and
  the policy snapshot self-heal no longer "restores" a refresh in progress.
- **`rm -rf ~` and `rm -rf $HOME` are in the destructive tier** (rule
  `destructive.rm_rf_home`); a subdirectory of home is not matched.
- **Tool-description poisoning catches an order to run a destructive
  command** (recursive delete of `/` or home, `mkfs`, `dd` to a device,
  `DROP DATABASE`, a download piped into a shell, a fork bomb), with no new
  false positives on the 10,753-description benign corpus.
- **A chaos run keeps the agent's own provider keys.** On a machine logged in
  to Intutic the runner replaced `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` with
  the workspace key, which a repetition's standalone proxy cannot resolve, so
  every baseline failed and every run with a real agent was invalid. The MCP
  proxy also records a blocked or held chaos call before answering it, so the
  runner never reads the events file ahead of the event.
- **The Terraform provider release pushes with the provider repository's
  token.** The checkout's persisted token overrode it, and the push was
  refused.

### Removed

- From `@intutic/shared-types`, exports nothing produced or read:
  `Attribution4D`, `DriftEvent`, `DriftDirection`, `PromptEstimateInputSchema`,
  `PromptEstimateInput`, `PromptEstimateResult`, `CostHistoryEntry`,
  `CostHistoryResult`, `DriftReportResult`, `SslStepReport`,
  `GovernanceNotification`, `NotificationConfig`, `NotificationPriority`,
  `NotificationCategory`, `PromptQualityScore`, `PromptQualityContext`,
  `ContextGap`, `DedupHint`, `HarnessConfigSnapshot`, `ConfigEditWithTarget`,
  `ConfigCapturePayload`, `CreateTaskPayload`, `CreateTaskResult`,
  `UpdateTaskPayload` and `UpdateTaskResult`. Drift is the
  `anomaly.drift.detected` event; cost estimates are `POST
  /api/v1/predict-cost`.
- **`TaskManagementAdapter.createTask` and `updateTask`**, which nothing
  called, and the `github` and `asana` `TaskProvider` values, which had no
  adapter. The docs and skill files list Jira, Linear and PagerDuty.
- **Three notification event types nothing emitted**:
  `ssl.enforcement.violation`, `context_gap.auto_injected` and
  `adapter.write_back.failed`, from `NOTIFICATION_EVENT_TYPES` and the
  Terraform provider. A rule on one could never deliver; the API refuses new
  ones and the control plane's migrations delete existing ones.
- **`IntuticPlugin::priority`** from the proxy: nothing read it, since each
  gate is called at its own site. The proxy README lists the governance steps
  that run, and where, instead of a plugin chain that did not exist.
- **`/intutic config quality-gate`**, which replied that a prompt quality gate
  was on and stored nothing; no such gate exists.

### Documentation

- `/intutic review` is described as the quick heuristic check it is: four
  fixed rules (prompt length, action verbs, naming an SOP or policy), no model.
- `sop://` comments in generated config are for traceability only; nothing
  parses them back.
- The chaos engineering guide records the first run with a model-backed agent
  and says to weight `failure_surfaced`, `no_policy_hits` and
  `no_destructive_attempt`, not `task_success`, when the fault is a permission
  denial.
- Source comments: `ff_metaclaw_evolution` is settable, a fail-closed proxy
  policy refusal is a 403 (not 503), and the trajectory monitor runs in the
  `intutic connect` process.

## [2.4.0] - 2026-10-11

Everything that reached `main` since 2.3.0. Upgrade the proxy before the
control plane: stored provider keys are now encrypted at rest under
`ENCRYPTION_KEY`, which the proxy now needs to open them (the Helm chart and
Compose file pass it); with Helm, roll out the new proxy image and wait for it
before `helm upgrade`. Check these behaviour changes before upgrading: upstream
retries are on by default, so a client's own retries for 429, 5xx, 529 and
dropped connections are no longer needed; `incident.created` notifications
carry the incident's own severity instead of always CRITICAL, so a rule
filtered on CRITICAL no longer receives HIGH, MEDIUM or LOW incidents; a
refused custom rule is filed as `WASM_RULE_REFUSED` and other proxy system
reports as `SYSTEM_ANOMALY` (incidents filed before 2.4.0 keep
`SCOPE_VIOLATION`); `PUT /api/v1/budget` is a partial update in which `null`
returns a field to its default; and smart routing's default candidates are now
`claude-sonnet-5-5`, `gpt-4.1` and `gemini-3.8-flash`, so a proxy with a
non-empty `model_list` must name them.

### Security

- **Provider keys are encrypted at rest.** AES-256-GCM envelope encryption,
  a data key per value, under `ENCRYPTION_KEY`. Rotating `ENCRYPTION_KEY`
  (with `ENCRYPTION_KEY_PREVIOUS` set to the old key) re-encrypts every stored
  secret, Slack tokens included. Every change to a provider key is recorded as
  a credential change, streamed as a SIEM source and sent as
  `credential.changed`.
- **Credential exchanges refuse plain HTTP.** A token, identity or workload
  identity federation URL that is not `https` is refused before any credential
  is sent; only loopback and the cloud metadata addresses may use `http`.

### Added

- **Upstream retries and fallbacks.** 429, 5xx, 529 and connection errors are
  retried up to three calls per model with full-jitter backoff inside a
  30-second budget, honouring `Retry-After`, never after a stream has started
  and never for a spend-limit 429. Ordered fallback targets per model can
  change the model, the provider or both, including the same Claude model on
  Anthropic's API, Bedrock or Vertex AI; each target is checked against the
  spend budgets. Attempts are recorded on the trace and returned as
  `x-intutic-upstream-*` headers and the SDKs' `upstream` field; set per
  workspace with `upstreamRetry`.
- **Spend budgets per key and per member.** Daily and monthly budgets, hard or
  soft, per virtual key and (on paid plans) per member, an enforceable monthly
  workspace cap, and key rate limits: requests per minute exact across proxy
  replicas, tokens per minute from usage (`RATE_LIMITED`). CLI
  `intutic budget keys|key|members|member`, the `budget_alerts` SIEM source,
  and Terraform `intutic_workspace_budget` / `intutic_member_budget`.
- **AWS Bedrock, Google Vertex AI and Azure OpenAI / AI Foundry upstreams**,
  with SigV4, application default credentials and workload identity
  federation, and Entra; credential verification; AWS SSO and assume-role
  profiles; Terraform `intutic_provider_credential`.
- **First-party Gemini routes.** Gemini requests on the Messages, Chat and
  Responses routes are translated to Gemini's API, so Gemini is shown as
  routable again (2.3.0 marked it not routable).
- **Provider model discovery.** Checking a provider key records the models it
  lists: `GET /api/v1/workspace/provider-credentials/:provider/models`, "Models
  this key can reach" in the dashboard, `intutic credentials models`, and the
  SDKs' `listProviderModels` / `list_provider_models`. The Anthropic check now
  lists models instead of sending a one-token message.
- **The MCP proxy enforces the workspace's uploaded WASM and Rego rules**, and
  its shadow evaluations count toward promotion; a refused rule version files
  one incident across both proxies.
- **Incidents by type** in the API (400 on an unknown type), the dashboard, the
  CLI (`intutic incidents list|show`), the SDKs (`listIncidents` /
  `list_incidents`, `getIncident` / `get_incident`) and the MCP tool
  `intutic_list_incidents`.
- **The SDKs cover every CLI operator API** (124 methods each), and verify
  evidence archives and sealed trace roots offline.
- **Smart routing per workspace.** `routingCandidates` sets the candidate list
  (dashboard, `intutic settings set`, SDKs, Terraform); a dated snapshot or
  `-latest` alias of a candidate enters routing; Shadow Routing has its own
  toggle; routing is marked experimental; `routing_targets_skipped` counts
  candidates a request could not reach.

### Changed

- **Smart routing only picks a model the request can reach**: one whose wire
  format has a translation both ways (Claude Code requests are never sent to
  OpenAI models), that the model allowlists and spend budgets allow, that has a
  provider credential and that the workspace key lists. A session lock outside
  the request's pool is ignored, and a routed pick that fails releases the lock
  instead of pinning the scope to it for 24 hours. Requests on Gemini's
  `/v1beta/models/…` route, and any request whose model's format cannot be
  translated, are refused with `400 unsupported_route` instead of being
  forwarded untranslated.
- **Mirror copies go to the candidate's own provider** with its own
  credential; an unreachable candidate is skipped and counted.
- **`intutic budget set`** sends only the flags given; `--daily default`
  returns the daily cap to its default.

### Fixed

- The hard-coded `gemini-1.5-pro` cross-provider URL is gone; Gemini picks are
  sent under the chosen model.
- The documented routing allowlist claim is corrected, and the fictional "Model
  Routing Tiers" section is removed from the docs.

## [2.3.0] - 2026-10-10

Everything that reached `main` since 2.2.0. Self-hosted gateway operators
should upgrade promptly (see Security). Check these behaviour changes before
upgrading: the sync daemon regenerates every hook gate as gate body v18
(`GATE_VERSION` 18) on its next cycle, and the gates refuse with new codes:
`COMMAND_TOO_LARGE` for a command over 256 KiB or arguments over 1 MiB,
`GATE_DEADLINE` when a gate is still deciding a second before its harness's
hook timeout (9 seconds for most harnesses, 4 for Windsurf and Muse Code), and
`POLICY_SNAPSHOT_UNVERIFIED` for every MCP call while the policy snapshot fails
its integrity check, observe-only (`SILENT_LOG`) workspaces included; the gates
also apply the MCP server registry, so under `mcpDefaultPolicy: deny` a
harness's own servers (Claude Code's `mcp__ide__…`) are refused until approved.
In `@intutic/gate` and `intutic_clawde.gate` a `.rules` file with no `#digest`
line now counts as unverified, and a hold rule raises `IntuticGateHold` (a
subclass of `IntuticGateRefusal`, code `HELD`) instead of blocking. The clawde
SDKs raise `ClawdeBlockedError` on every in-band proxy refusal, and with a
`vk_` key they register a session on the first call that carries the working
directory's repository, branch and commit (`autoContext: false` /
`auto_context=False` turns it off). The proxies redact payment card numbers and
IBANs by default, and a workspace's `piiDetectors` setting is the baseline that
local config may only tighten; a proxy that fails closed refuses a request when
it cannot read that setting. `intutic connect` now wraps Gemini CLI's and
Antigravity's MCP servers (an SSE-only remote server written as `url` needs
`"type": "sse"`), reports the machine's AI inventory and the repository each
session works in, writes rule sets only to the file each harness reads (never
`CLAUDE.md`), and sets VS Code's `chat.useHooks` and `chat.hookFilesLocations`
back when they would switch off the GitHub Copilot gate. A custom WASM or Rego
rule that reaches no verdict (its deadline, its fuel, a trap or an unreadable
result) now refuses the call with `GOVERNANCE_UNAVAILABLE` in both proxies,
whatever the fail-open settings say, and Rego rules are on by default; the
shipped Rego examples refuse input cut to fit the 64 KB cap, so the
deny-writes example refuses a `Write` over about 64 KB. Destructive-SQL and action
matching catch more spellings, and `DROP DATABASE` and `DROP SCHEMA` are now
`action:db_write`, so expect more holds and refusals. The workspace settings
API now answers `400` for an unknown key inside `featureFlags`,
`imageProvenance`, `anomaly_enforcement`, `banditKeywords` or `byocStorage`
(they were silently dropped), and for a notification rule `eventType` that is
not one of the published event types. `intutic compliance verify` exits `3`
for a file it cannot read. A workspace that never saved a daily cap is held to
$100 a day, enforced as before, and Settings › Billing, `intutic budget` and
`GET /api/v1/budget` (`daily_budget_is_default`) now say when the cap is that
default; save your own on Settings › Billing › Budget Limits or with
`PUT /api/v1/budget`. The control plane now refuses to start (outside
`NODE_ENV=test`/`development`) when `JWT_SECRET` or `ENCRYPTION_KEY` is missing,
a placeholder or under 32 characters, or when the database password or another
shared secret is a placeholder such as `changeme`; the Compose file no longer
defaults `POSTGRES_PASSWORD` to `changeme_prod` and requires it, `JWT_SECRET`
and `ENCRYPTION_KEY` (a Compose install that kept the old default must change
the Postgres role's password first; see the Compose guide). The provider
settings show Gemini as not yet routable: its requests were never translated
to Gemini's format, and Gemini routing arrives in 2.4.0.

### Security

- **Placeholder secrets are refused at boot.** A deployment that kept a
  template value for `JWT_SECRET` let anyone sign a login token for any user.
  The control plane now refuses to start with placeholder or short secrets
  (`JWT_SECRET`, `ENCRYPTION_KEY`, the database URL passwords,
  `SLACK_ENCRYPTION_KEY`, `SLACK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET`,
  `INTUTIC_ADMIN_TOKEN`), and the Kubernetes manifest check fails any overlay or
  chart that renders a placeholder Secret value. Generate secrets with
  `openssl rand -hex 32`. If yours was ever a placeholder, rotate it. A new
  `JWT_SECRET` signs everyone out. A new `ENCRYPTION_KEY` makes the SSO,
  connector and notification secrets sealed under the old one unreadable unless
  they are re-encrypted first; 2.4.0 adds `ENCRYPTION_KEY_PREVIOUS` and a
  re-encryption command for that.
- **Terraform provider dependencies.** `golang.org/x/crypto`, `golang.org/x/net`
  and `google.golang.org/grpc` are updated past their advisories, and the
  provider is built with Go 1.26.9.
- **Advisory for self-hosted deployments: provider API keys are stored
  unencrypted in Valkey.** A workspace's provider credentials live in Valkey,
  which persists them to disk and replicates them to every region's Valkey.
  Until 2.4.0, which encrypts them at the application layer, keep Valkey
  reachable only from the control plane and proxies (network policy or
  firewall), require a password or ACL and TLS, and keep its data volume on an
  encrypted disk.
- **The workspace PII setting could be switched off by a machine.** A proxy
  whose local config turned DLP off (`dlp.enabled: false`, or both scan
  directions off) skipped the workspace's PII detector setting. The workspace
  baseline now always applies, in both directions; local config can only add
  to it. An unreadable setting is refused as `GOVERNANCE_UNAVAILABLE`.
- **A daily spend cap could silently become $100.** The cap was stored with a
  24-hour expiry and the proxy fell back to $100 when the copy expired. Caps
  no longer expire; a proxy whose copy is missing reads it from the control
  plane and refuses with `BUDGET_UNVERIFIABLE` if it cannot.
- **Editing a notification rule could replace its PagerDuty key with the
  mask.** A key that is left out or sent back masked now keeps the stored key.
- **The SDKs sent repository details before confirming the key.** With the
  workspace taken from `INTUTIC_WORKSPACE_ID` or the daemon config, the
  session carrying the repository, branch and commit was registered without
  first checking the key. Both SDKs now always confirm it with
  `GET /api/v1/auth/me`.
- **A redacted reply could be served unredacted from the response cache.**
  Without streaming, a reply that output DLP had redacted was stored in the
  exact cache before redaction, so the next identical request got the
  credential back. Redacted replies are no longer cached.
- **Provider keys reached the control plane.** On a passthrough proxy the
  request's bearer can be the caller's own provider key, and several
  control-plane calls sent it as it came: `/fix` memory enhancement, the
  tool-call substitution report, the judge, slash commands and the
  `/intutic/attest-sandbox` forward used it as their bearer, and the policy
  check sent its first 12 characters, which traces and logs also recorded as
  the virtual key id. Every control-plane call now takes a typed virtual key
  that only a `vk_` bearer produces (`RequestCredential`), so a provider key
  goes to its provider and nowhere else. Requests made with a provider key are
  answered locally where the control plane used to refuse them (the policy
  check under the configured fail mode, the judge as unavailable) and record no
  key id.
- **Pre-authentication credential overwrite in the proxy.** The session
  credential capture ran before authentication, so an unauthenticated caller
  could replace a workspace's stored Anthropic credential. It now runs after
  authentication. Self-hosted gateway
  operators should upgrade, and run with virtual keys required
  (`INTUTIC_GATEWAY_REQUIRE_VK=true`, or `requireVk` in the gateway config) so
  any other bearer is refused with `401`.
- **WASM rule modules are checked against their SHA-256.** A rule module from
  the control plane is loaded only when its bytes hash to the SHA-256 its
  descriptor names. A mismatch is logged and raised once as an incident, and
  the version of the rule already running stays in force.
- **Gates that never ran.** The Goose, Hermes and OpenHands registrations were
  in shapes those harnesses skip (Hermes ignored `hooks.preToolUse` as an
  unknown event), so their gates never fired. They are now written in the
  schemas each harness loads, with its fail-closed switch where it has one
  (Goose `on_failure: "block"`, Hermes `fail_closed: true`) and a 10 second
  timeout. OpenClaw's gate was an internal hook that never sees a tool call; it
  is now a plugin whose `before_tool_call` hook blocks. Pi's gate and model
  routing were written to files Pi does not read; the gate is now an extension
  in `~/.pi/agent/extensions/` and routing goes to `~/.pi/agent/models.json`.
  Continue's CLI never runs `PreToolUse` hooks, so Continue is reclassified as
  having no gate and is governed by the proxy and its rules file.
- **A slow gate allowed the call.** Most harnesses run a tool call whose hook
  outlives its timeout. Every hook gate now refuses with `GATE_DEADLINE` a
  second before the timeout its own harness applies, at most 9 seconds (a
  watchdog in the bash gates, an interrupting `vm` timeout in the JavaScript
  gates, and a deadline from the start of each call in the in-process
  OpenCode, Pi and OpenClaw gates). `connect` sets a 10 second hook timeout
  wherever a harness has a key for one, now including Cursor and Grok Build;
  Windsurf and Muse Code document none, so their gates assume 5 seconds and
  refuse at 4. One table in `@intutic/shared-types` (`HOOK_GATE_TIMEOUTS`)
  holds every harness's timeout, and a test checks each written hook entry
  against it. The bash gates screen each subject with one `grep` holding every
  rule's pattern before testing rule by rule, so a call at the size limit
  takes about a fifth of the time it did and is not refused on a busy machine.
- **Gate bypasses by spelling.** A destructive SQL statement or a held action
  (`review_before` on `action:db_write` or `action:deploy`) could get past the
  MCP proxy's DLP, the hook gates' `destructive.sql_drop` rule and the hold
  classifiers when its words were separated by something other than a single
  space. Every gate, both SDK gates, the proxy's action classifier and the MCP
  proxy now match a phrase's words whatever separates them, with one shared set
  of test vectors. Matching is literal, so a quoted string that contains the
  phrase still matches the text rules; the proxy's SQL guard, which reads the
  statement, does not.
- **ReDoS.** The JavaScript and Python classifiers, and the bash hold
  classifier, could take seconds to a minute on crafted command text. A linear
  phrase matcher replaces the backtracking regex; gate rules shaped `A.*B` run
  as sequences of steps; the `chmod`/`chown` root rules and the skill-content
  patterns no longer go super-linear; and a static check refuses any new rule a
  backtracking engine could take super-linear time on. Git remote
  normalisation no longer uses backtracking regexes.
- **Protected paths covered every gate.** An agent could rewrite or delete the
  files that load its own gate: Cline's gate (the list still named
  `.cline/hooks`), Codex's `hooks.json` and `config.toml` (where
  `features.hooks = false` turns hooks off), GitHub Copilot's two hook files,
  Hermes' and Goose's `config.yaml`, the Open WebUI filter, Cursor's
  machine-wide `hooks.json`, Antigravity's `~/.gemini/config/hooks.json` and a
  project's `.agents/hooks.json`, OpenClaw's `openclaw.json`, Pi's extension
  directories, and `.intutic/env`, whose workspace id makes every gate drop the
  snapshot's rules when it does not match. All are protected paths now, and
  the settings guard restores every gate script and registration when it is
  deleted or replaced. The guard watched the project's `.gemini/settings.json`
  instead of `~/.gemini/settings.json`, where the Gemini CLI gate is
  registered, and `connect` filtered watched paths by file name before the
  guard saw them, so OpenClaw's config, Muse's managed hooks and every dsh
  profile patch were never restored. Both are fixed.
- **GitHub Copilot's gate could be switched off from VS Code settings.** Every
  gate now refuses an agent edit that sets `chat.useHooks` or
  `chat.hookFilesLocations`, and a shell command that names either key. While
  the Copilot gate is installed, the sync daemon sets either value back when
  it would switch the gate off, leaves the rest of the settings file
  (comments included) as it was, and reports a `config_tamper` incident. VS
  Code's `ChatHooks` policy remains the administrator's hard lock.
- **A tampered policy snapshot refuses every MCP call.** A snapshot whose
  digest is broken or missing, or that names another workspace, used to keep
  the registry's refusals; but a deleted record looks like one never set, and
  an edit to the blocked list or default policy still widened it. Every gate
  and both SDK gates now refuse every MCP call on such a snapshot with
  `POLICY_SNAPSHOT_UNVERIFIED`. The sync daemon keeps the last snapshot it
  wrote in `~/.intutic/hooks/verified/`, puts it back as soon as the live one
  differs (an edit, a deletion or an older copy), and reports the tamper; the
  MCP daemon seeds its policy at startup from that verified copy
  (`~/.intutic/hooks/verified/policy-snapshot.json`) instead of the live file.
- **The MCP server allowlist sat outside the digest.** `mcpAllowedServers` was
  a `#mcpservers` header, so adding a server by hand widened the allowlist and
  left the snapshot valid. It is now an `@mcp_allowlist` record inside the
  digest.
- **Gates were skipped and holds let calls run.** `intutic connect` installed
  no gate for a harness that no rule set targeted; every configured harness
  now gets its gate. The sandbox gate script `@intutic/gate/harness` writes
  refused a block but ran a call a hold rule matched; it now refuses it.
  `@intutic/gate` and `intutic_clawde.gate` never fired a
  `review_before: action:…` hold and never recorded an SOP approval hold; both
  now hold as the hook gates do.
- **WASM limits.** The proxy checked a rule's time limit only after the guest
  returned, so the limit never fired and only the fuel budget stopped a slow
  rule. Fuel is now the limit a rule is held to, the same on any machine:
  1,000,000 instructions for a native rule and 100,000,000 for a Rego rule in
  the proxy (300,000,000 in the MCP proxy, whose meter counts differently),
  each at least four times what the largest shipped policy spends on the
  largest input. A wall-clock deadline (wasmtime epoch interruption in the
  proxy) stops what fuel cannot see, set well above the time a loaded machine
  needs to spend the whole budget: 1 s native and 2 s Rego in the proxy, 1 s
  and 10 s in the MCP proxy. A busy machine no longer turns into refusals of
  correct calls.
- **A custom rule that reaches no verdict refuses the call.** A WASM or Rego
  rule that hit its deadline or fuel budget, trapped, or returned something
  other than a verdict was allowed, so input crafted to slow a rule down got
  past it. Both proxies now refuse with `GOVERNANCE_UNAVAILABLE`, naming the
  rule and the cause, whatever `fail_closed`, `mcpProxyFailBehavior` or
  `INTUTIC_MCP_FAIL_OPEN` say: those settings cover control-plane outages,
  which an agent cannot cause. In the MCP proxy a rule quarantined after three
  runaways in a row refuses every call until the next rescan, where it used to
  be skipped. The shipped Rego examples refuse input marked `truncated`, and
  `intutic rules build` warns about a policy that reads `input.args` without
  checking `input.truncated`. `read_referenced_file` returns a new code, `-7`,
  for a path the call names but the host did not read (past 8 manifests or
  64 KiB of command), so a rule can refuse it rather than read it as absent.
- **Rule load failures are reported.** A rule pushed from the dashboard that
  failed to load was dropped without a word, and a module that failed to
  compile stopped every later sync. The previous version now stays in force
  and one incident is raised per version, saying so when no version loaded.

### Added

- **Refusal codes everywhere.** One shared list names every refusal per
  surface. The proxy names each in-band refusal (`TOOL_DENIED`, `SSO_GROUP`,
  `SQL_GUARD`, `RESPONSE_UNPARSEABLE`, `OUTPUT_DLP`, `COST_GATE_EXCEEDED`) in
  `x-intutic-refusal` and `x-intutic-refusal-rule` headers, or a
  `: intutic-refusal {…}` comment line on a stream. The MCP proxy puts
  `error.data.code` and `error.data.ruleId` on every refusal (a budget refusal
  adds its budget, limit, use and `resetAt`). Cline, Grok Build and
  Antigravity gate decisions carry `code` and `ruleId`.
- **Holds in the SDK gates.** `@intutic/gate` and `intutic_clawde.gate` hold a
  call through the decisions API, as the MCP proxy does: an exact approved
  bypass lets the identical call through, otherwise the hold is recorded and
  `IntuticGateHold` names its `holdId`. Every hold message, in every gate and
  the MCP proxy, says who can approve (owner, admin or EM) and that the retry
  passes only with the workspace's review-hold bypass on. The proxy's `403
  policy_held` (a Rego or WASM hold) is classified as a hold in both clawde
  SDKs.
- **MCP server registry in the hook and SDK gates.** The policy snapshot
  carries the registry inside its digest, and every hook gate and both SDK
  gates refuse a blocked or held server, an unapproved one under
  `mcpDefaultPolicy: deny`, and a disabled tool, with the MCP proxy's codes and
  rule ids. A server refused as unapproved joins the approval queue.
- **MCP call budgets and tool-change risk scoring.** Budgets per server, tool,
  member, or member on a server, per hour or day, counted in the Valkey the MCP
  proxies share (`INTUTIC_VALKEY_URL`); a used-up budget refuses with
  `BUDGET_EXCEEDED` and its reset time. A change to a server's tool set gets a
  deterministic risk score, and a high-risk change holds the server for
  re-approval (`SERVER_HELD`). The `intutic` MCP server gains
  `intutic_hold_status`, `intutic_mcp_registry_status` and
  `intutic_mcp_budget_remaining`.
- **Checksum-validated PII detectors** in the proxy and the MCP proxy, from one
  shared definition: `pii.card` (known card prefix and length, Luhn),
  `pii.iban` (registry country and length, mod-97) and `pii.ssn` (rejects
  numbers never issued) redact by default; `pii.email` and `pii.phone` are off.
  Set each to `off`, `redact` or `block` with `dlp.detectors` (proxy) or
  `INTUTIC_MCP_DLP_DETECTORS` (MCP proxy), or centrally with the workspace's
  `piiDetectors` setting.
- **Rego policies as rules.** OPA-compiled Rego modules run in the proxy and
  the MCP proxy wherever WASM rules run (`INTUTIC_DISABLE_REGO_RULES=1` turns
  them off), with a fixed set of host builtins checked against `opa eval`.
  A policy can allow, deny, hold or reask. `intutic rules build --rego` and
  `intutic rules test` build and test them; `intutic policy install` validates
  them.
- **Google Antigravity** is governed: a `PreToolUse` gate in
  `~/.gemini/config/hooks.json`, rule sets in `GEMINI.md`, and its
  `mcp_config.json` servers behind the MCP proxy. Gemini CLI's
  `mcpServers` are wrapped too, and Gemini CLI reports as `gemini-cli`.
  Antigravity and Gemini CLI gates have Jamf and Intune manifests.
- **AI inventory.** `intutic connect` reports each machine's harnesses (with
  gate kind, whether the gate file is present and when it last reported), MCP
  servers (wrapped or not, endpoint sanitised), skill bundles (name, source,
  hash) and the local proxy's guard-probe result, on the first poll and every
  five minutes after. Only names, home-relative paths, hashes and timestamps
  leave the machine.
- **Cost per branch, commit and pull request.** The sync daemon reports each
  session's repository (the `origin` remote, credentials, port and query
  removed) and reports again when the branch or `HEAD` moves. The clawde SDKs
  register a session with the same context (see Changed).
- **Event ids.** Every gate, reporter and SDK stamps each event with a random
  `eventId`, so a resent event is filed once.
- **Kitkat governance skill** covers every refusal code and hold and what an
  agent should do with each, and `intutic connect` installs it in
  `.agents/skills/` when missing.
- **CLI:** `settings get|set`; `mcp list|approve|block|reset|enable-tool|disable-tool`;
  `notifications list|create|update|delete|rotate-secret`;
  `siem list|show|sources|create|update|delete|rotate-secret`;
  `compliance coverage` (json, md, csv or pdf) and `compliance
  collect|download|verify` (`verify` checks an evidence archive's hashes and
  Ed25519 signature offline and exits `2` for an unsigned one);
  `usage members|teams|branches|commits|pull-requests`; `github webhook
  show|rotate-secret`; `inventory summary|harnesses|mcp-servers|skills`;
  `gate-liveness`; `gateway config get`; and `guardrails create|update|delete`
  for guardrails written directly in the Guardrail IR. A `403` prints the roles
  the server requires.
- **clawde SDKs:** `getWorkspaceSettings` / `updateWorkspaceSettings` and
  `getGatewayConfig` (`get_workspace_settings`, `update_workspace_settings`,
  `get_gateway_config`) on the control-plane client; `GatewayStatus` carries
  the applied and desired config versions; `ClawdeBlockedError` carries
  `ruleId` (`rule_id`); `streamRefusal` (`stream_refusal`) reads a stream's
  refusal marker.
- **Terraform provider 0.1.0**, released alongside this version
  (`terraform-provider-v0.1.0`), manages a workspace as code: `intutic_sop`,
  `intutic_policy`, `intutic_guardrail`, `intutic_workspace_settings`,
  `intutic_virtual_key`, `intutic_gateway`, `intutic_notification_rule`,
  `intutic_mcp_server_decision`, `intutic_siem_destination` and
  `intutic_wasm_rule` (uploads a WASM or Rego module and checks its stored
  SHA-256), with the `intutic_workspace` and `intutic_members` data sources.
  Every resource supports import; notification rules and SIEM destinations
  rotate their signing secret in place with `secret_rotation_triggers`.
  The source is in `packages/terraform-provider-intutic`.
- `@intutic/shared-types`: the phrase and sequence matchers, gate limits
  (`COMMAND_SIZE_LIMIT`, `ARGUMENTS_SIZE_LIMIT`, `HOOK_GATE_TIMEOUTS` and
  `gateDeadlineMs()`), the MCP
  registry and allowlist records and evaluators, MCP budgets and tool-risk
  scoring, PII detector settings and precedence (`effectivePiiActions`),
  `HARNESS_RULES_FILES`, `normalizeGitRemote`, the device inventory, usage and
  authored-guardrail types, and notification events for decision reviews, MCP
  server decisions, refused sign-ins, SCIM changes, secret rotations and
  evidence downloads.
- Docs: Rego policies, AI inventory, Terraform and Google Antigravity pages;
  MITRE ATLAS mapping; which role may make each change; where each harness's
  rule sets go; hook timeouts per harness; SIEM sources for MCP registry
  decisions, SCIM changes, decision reviews, secret rotations and evidence
  exports, with an OCSF-shaped `actor`.

### Changed

- **Workspace PII settings win over local config.** A workspace's
  `piiDetectors` is the baseline in both proxies; `dlp.detectors` and
  `INTUTIC_MCP_DLP_DETECTORS` may make a detector stricter but never looser,
  and detectors the workspace leaves out keep the local action. If the proxy
  cannot read the setting it follows its fail mode (fail closed, the default,
  refuses; in the LLM proxy, a global break-glass scans with local config). The MCP proxy keeps
  the setting it last loaded through an outage, and refuses with
  `GOVERNANCE_UNAVAILABLE` under fail-closed when the stored value cannot be
  read. `pii.ssn` replaces the old SSN pattern.
- **clawde SDKs register a session.** With a `vk_` key, and no session id from
  the environment, `ClawdeClient` registers a session carrying the working
  directory's repository, branch and commit on its first call (after the
  control plane accepts the key) and sends it as `x-session-id`. A provider
  key never triggers it. `autoContext: false` (`auto_context=False`) sends
  nothing. Both SDKs raise `ClawdeBlockedError` on every in-band proxy
  refusal, where they used to return verdict `allow`.
- **Rule sets go only to the file each harness reads**, named per harness in
  `HARNESS_RULES_FILES`: a marked section of a shared `AGENTS.md` for every
  reader (Codex now gets rules), `.claude/rules/`, `.cursor/rules/`,
  `.windsurf/rules/`, `.continue/rules/`, a section of `.goosehints`, a section
  of `GEMINI.md` (read only in a trusted folder), an OpenHands microagent and
  OpenClaw's agent-workspace `AGENTS.md`. Your own text in shared files is
  kept. Files earlier versions overwrote whole (`CLAUDE.md`, `.cursorrules`,
  `.windsurfrules`, `.roorules`, `AGENTS.md`) are given back on the first sync.
- **The decisions log** follows the same map. Claude Code's goes to
  `.claude/rules/intutic-decisions.md`, and `CLAUDE.md` is never created or
  written; the section earlier versions put there comes out on the next sync.
- **Gate body v18.** Every gate is regenerated each sync cycle. Beyond the
  refusals under Security, a long option between a command's words
  (`git --no-pager push`) counts as the command, Gemini CLI's
  `run_shell_command` is a shell tool for holds, and SSO group rules match an
  MCP tool by its own name (`run_query`) as well as its harness name
  (`mcp__<server>__run_query`) at every gate.
- **WASM rules:** a rule is held to its fuel budget, with a wall-clock
  deadline as a backstop (see Security); a rule that runs out of either
  refuses the call, where a slow rule used to finish and its verdict applied.
  Rego input is capped at 64 KB.
- **Hermes** asks you to approve the shell hook the first time it sees it.
  **Cline** shows a refusal from `errorMessage`.
- `intutic disconnect` reports the disconnect before it removes the
  credentials, and removes everything the new gates, rules sections, skills
  and MCP wraps add, plus what earlier versions wrote for Continue, OpenClaw
  and Pi.
- The sync daemon's event drain no longer deletes events a gate appends while
  a batch is in flight; a batch left behind by a crash is sent again.
- `@intutic/gate` and `intutic_clawde.gate` export `GATE_REFUSAL_CODES`
  (`GateRefusalCode`), checked against the shared list.
- `@intutic/gate` exports `GATE_DEADLINE_MS` (9000): its sandbox hook gate
  refuses with `GATE_DEADLINE` a second inside the 10 second timeout of the
  hook it writes.

- **Gemini is shown as not yet routable.** The provider registry and the
  settings guide called Gemini live, but the proxy forwarded Gemini requests
  without translating them to Gemini's format, so none succeeded. Gemini keys
  can still be saved, in the same field, and are used once Gemini routing
  arrives in 2.4.0.
- **Messages no longer cite internal tracker ids.** Generated firewall
  rulesets, two proxy startup warnings, the LiteLLM config that
  `judge configure` writes, the AutoGen and smolagents usage summaries, the
  installed pre-commit hook and the sync daemon's skill-surface warnings now
  state the reason instead of an internal reference. The sandbox gate script's
  header changed with them, so each sandbox re-runs its bootstrap once after
  upgrading.

### Removed

- **Continue's gate registration.** `cn` never ran it; `intutic disconnect
  --harness continue` removes it.
- **Claude Desktop and Roo Code hook writers**: neither product read what they
  wrote. Both are classified as having no gate of their own.
- **n8n's workflow-settings rules update**, which n8n's schema always refused.
  n8n reads no instructions file.
- **`SOP_RULE_APPROVAL`** from the SDK gates' refusal codes: an SOP approval
  rule is a hold (`HELD`). `GateClient.hold_for_review` in `intutic-clawde` is
  replaced by the hold flow.
- From `@intutic/shared-types`: `PRIVILEGED_SOURCE_PROVIDERS`; owners and
  admins manage every connector provider.

### Fixed

- `intutic inventory devices` and `intutic inventory disconnects` give the CLI
  the dashboard's machine and disconnect views; `guardrails` commands print the
  roles a refused call needs; `guardrails sources sync` prints its real counts.
- Gate Health no longer reports harnesses that have no gate (Continue, Claude
  Desktop, Roo Code, aider) or that delegate to another harness as silent.
- `intutic rules build`, `rules test`, `policy test` and `policy install` meter
  rules with the proxies' instruction budgets, so a rule that would run out in
  a proxy fails locally too.
- A custom rule refused at load names why (`missing`, `hash_mismatch`,
  `compile_error`, `unsupported_import`, `load_error`), with one incident per
  rule version and reason.
- The dashboard shows `TAMPER` gate decisions and the file that was restored.
- Terraform: removing a credential from `intutic_siem_destination`
  `secret_config` clears it, and `event_type` on `intutic_notification_rule`
  is validated against the published event types.
- The Python SDK no longer lets a malformed control-plane reply during session
  registration break a call, registers once across threads, and types
  `get_gateway_status`.
- **MCP proxy policy cache with Valkey down.** Every cache miss waited out a
  read and then a write through the Valkey client's retries, seconds per miss
  and growing with the outage, and a Valkey that accepted the connection but
  never answered held the call forever. Valkey is asked only when it is ready,
  and the write-through no longer blocks the call.
- **The response cache answered an agent's next turn with its last one.**
  The exact cache keyed only on the plain text of user and system messages, so
  a request carrying a tool result hashed like the turn before it and got that
  turn's reply back, sending a coding agent round in a loop; every posture
  preset turns this cache on. The exact key now covers the whole request:
  model, every message including tool calls and results, tools and sampling
  parameters. The semantic cache answers only a plain-text question with no
  tools, with everything but the question matched exactly. A streaming request
  served from cache now gets a valid event stream, a Responses API hit gets the
  `output[]` shape, and replies that call a tool or were cut off are no longer
  cached. Requests with `n` above 1, and Responses API requests that do not
  set `"store": false`, skip the cache. Entries keyed the old way are not
  served and expire within 24 hours. Nothing is written to the cache while
  both cache flags are off.
- Rule sets never reached Gemini CLI, Antigravity or OpenHands: neither
  Gemini product reads `customInstructions` in `.gemini/settings.json`, and
  OpenHands never read an `[intutic]` table in `config.toml`. `connect`
  removes the stale key and table.
- Aider's `read:` entry is an absolute path, so Aider finds the rules from any
  subdirectory.
- The settings guard sent OpenCode plugin tampering to the Goose writer.
- The MCP proxy failed on a registry from an older MCP daemon that lacked
  held servers.
- The smolagents step callback logged a held step as neither blocked nor
  allowed.
- `intutic-clawde`'s snapshot reader normalised commands differently from the
  shipped gates, so a command starting with `DROP TABLE` did not match.
- Docs: compliance evidence exports are signed only when a signing key is
  configured; OpenClaw's proxy routing is set by hand; gate counts and
  comparison pages checked against the code.

## [2.2.0] - 2026-10-08

Everything that reached `main` since 2.1.0. Check these behaviour changes
before upgrading: a mistyped `INTUTIC_EGRESS_MODE` now stops the proxy at
startup; a proxy that fails closed refuses a virtual-key request when it cannot
read the key's SSO group policy; the clawde SDKs raise `ClawdeBlockedError` on
the cost gate's `200` refusal; `intutic predict-cost --task-type` is an error;
and `intutic connect` records each harness rules file's hash and size in the
config history, write-protects rules files under the Write-protect setting on
macOS, and writes Windsurf's proxy settings to the file Windsurf reads. Hold
redaction now redacts a private key with no footer to the end of the text.
`INTUTIC_PROMPT_QUALITY_GATE`, `INTUTIC_PROXY_IP` and `INTUTIC_PROXY_PORT` are
gone (see Removed).

### Added

- **MCP server registry in the MCP governance proxy**: the proxy reads the
  workspace's registry decisions with the policy it already polls. It refuses
  a blocked server and a tool an operator disabled (and hides that tool from
  `tools/list`), and, when the workspace's `mcpDefaultPolicy` is `deny`, every
  server not yet approved. It reports the server it fronts and its tool names,
  so a new server lands in the approval queue (`mcp.server.candidate`). The
  first call waits for the first policy fetch; a registry that never loads
  follows the fail setting (open skips the registry checks, closed refuses).
- **Approval holds in the MCP proxy**: a `require_approval` rule holds the call
  through the decisions API, as the hook gates' hold tier does, instead of
  refusing it. The agent gets a held error naming the hold id and the
  `intutic decision approve` command; once approved, with the workspace's
  review-hold bypass on, the identical retry passes. An unreachable control
  plane keeps the call held.
- **Per-call identity**: every MCP proxy event and hold carries the API key's
  prefix, the OS user, the harness session and the server the proxy fronts.
- **SSO-group tool clearance in every gate**: a workspace's `sso_group_policy`
  (high-risk tools, the identity-provider groups that clear them, and tools
  only an on-behalf-of token may call) is enforced by the MCP proxy, the
  generated hook gates (the policy snapshot carries the member's groups in an
  `@sso_groups` record), `@intutic/gate` and `intutic_clawde.gate` (refusal
  code `SSO_GROUP`), and the proxy's response gate, which reads the policy and
  the key's member groups from `GET /api/v1/auth/key-context` (cached 30
  seconds per key, refetched when the workspace config version moves) and
  records a finding naming the rule. A member whose groups are unknown,
  including after the control plane refuses the key, is refused high-risk
  tools. While SCIM provisioning is on, SCIM groups decide membership.
  `@intutic/shared-types` exports the one evaluator and schema
  (`evaluateSsoGroupClearance`, `SsoGroupPolicySchema`, `parseSsoGroupPolicy`,
  `ssoGroupRuleId`, `encodeSsoGroupRecord`, `decodeSsoGroupRecord`), and a
  shared vectors file holds every implementation to the same answers.
- **`intutic disconnect`** restores every file `intutic connect` changed:
  owned files restored or deleted, Intutic's hook entries and MCP wraps
  removed, overwritten proxy settings put back. A full run also removes the
  background services, the CA connect trusted in the login keychain, the
  Valkey container, the gate caches and the stored credentials. `--dry-run`
  prints the plan, `--harness <id>` takes out one harness, `--keep-login`
  keeps the login. Files written by earlier versions are recognised.
- **Claude Code project MCP servers are governed**: each server in a
  repository's `.mcp.json` gets a wrapped copy at local scope in
  `~/.claude.json`, which Claude Code prefers, so the committed file is never
  rewritten. Only servers Claude Code itself would start are copied: approvals
  in the project's `.claude/settings.json` and `settings.local.json` count only
  once the folder's trust dialog was accepted, and a disable anywhere wins. A
  remote server whose URL or headers use `${VAR}` is not copied and shows as
  ungoverned, with the reason, in the MCP server registry.
- **Config history**: `intutic connect` records each harness rules file
  (`HARNESS_FILES`, listed in the CLI reference) every fifth poll: its path,
  the SHA-256 of its redacted text, and its size, never the text. The new
  `configBodyUpload` workspace setting (off by default) uploads the text too,
  with credential-shaped strings redacted on the machine first.
  `intutic integrity config-chain` says how many snapshots carry no content.
- **Live gateway config**: a registered self-hosted gateway pulls its config
  whenever the heartbeat's desired version differs from the one it runs, and
  applies `requireVk` and `requireProvisionedKey` without a restart; the first
  heartbeat goes out at startup. `intutic gateway status` shows the applied
  config version against the desired one. Bare metal is a deployment target
  again (`intutic gateway register --target bare_metal`): the release's proxy
  binary, checked against `checksums.json`, under a systemd unit.
- **Workspace MCP detection settings**: `mcpInjectionAction`, `mcpAnomalyMode`
  and `mcpAnomalyOverrides` (keys checked against the new
  `MCP_ANOMALY_DETECTOR_IDS`) reach the MCP proxy with its policy and win over
  `INTUTIC_MCP_INJECTION_ACTION`, `INTUTIC_MCP_ANOMALY_MODE` and
  `INTUTIC_MCP_ANOMALY_OVERRIDES`; unset, the local variables stay in force.
- `@intutic/shared-types`: the `governance.gate.silent`,
  `governance.gate.recovered`, `governance.integrity.failed` and
  `mcp.server.candidate` notification events; `NotificationRule.signingSecret`,
  a webhook rule's generated signing secret, returned once; `mcpDefaultPolicy`,
  `sso_group_policy` and `configBodyUpload` on `WorkspaceSettings`.
- Docs: a framework mapping guide (EU AI Act, ISO/IEC 42001, NIST AI RMF);
  SIEM sources, gate-silent and integrity alerts, and the one signature scheme
  notification and SIEM webhooks share, with its replay window; every sign-in
  method, and refused sign-ins, in the audit trail; the MCP registry, approval
  holds, caller identity and every MCP proxy flag and variable; SCIM groups as
  stored resources; how to set an SSO group policy.

### Changed

- **`INTUTIC_EGRESS_MODE`** must be `off`, `monitor` or `enforce` (case and
  surrounding space ignored). Anything else is an error naming the valid
  values, and the proxy does not start; it used to mean `off`, so a typo in
  `enforce` turned egress control off. An empty value still defers to
  `intutic_settings.egress.mode`.
- **The proxy reads a virtual key's SSO group policy on each request** (cached
  30 seconds) when it has a control plane. If the read fails, a proxy whose
  policy check fails closed refuses the request with `403 policy_denied`; one
  that fails open proceeds without group rules.
- **clawde SDKs** (`@intutic/clawde`, `intutic-clawde`): the proxy's
  cost-prediction gate answers a non-streaming request with a `200` whose
  assistant turn explains the estimate, and now names the refusal in an
  `x-intutic-refusal: COST_GATE_EXCEEDED` header. `chat()` fires `kill` and
  raises `ClawdeBlockedError` (status `200`, the explanation as its message)
  instead of returning the turn as the model's answer with verdict `allow`.
- **`intutic connect` runs the sync work the docs describe**, which lived in a
  second sync loop nothing started: SkillOpt config edits are applied and
  acknowledged, MCP servers are wrapped every cycle, `skill_flagged` events,
  the decisions log and the bundled rule-author skill are produced, and
  Markdown rules files keep their `sop://` pointer comments. The hand-edit
  setting is honoured: Write-protect sets the macOS immutable flag
  (`chflags uchg`) on the rules files between cycles, and Record only leaves a
  hand edit in place (gate hook files are still restored).
- **Windsurf**: `http.proxy`, `http.proxyStrictSSL` and `codeium.proxy` are
  merged into Windsurf's user `settings.json`
  (`~/Library/Application Support/Windsurf/User/` on macOS,
  `$XDG_CONFIG_HOME/Windsurf/User/` or `~/.config/Windsurf/User/` on Linux,
  `%APPDATA%\Windsurf\User\` on Windows) instead of
  `~/.codeium/windsurf/settings.json`, which Windsurf does not read.
  `intutic disconnect` cleans both.
- MCP proxy: the workspace's `mcpProxyFailBehavior` (the dashboard's "When
  Intutic is unreachable" setting) now reaches the proxy and wins over
  `INTUTIC_MCP_FAIL_OPEN`, which applies until a policy has loaded or when the
  workspace never chose; `INTUTIC_MCP_FAIL_OPEN` is read from the environment
  before `runtime.env`. The standalone `intutic` MCP server reports the package
  version instead of `0.1.0`. The MCP daemon finds Claude Code's servers in
  `~/.claude.json` and each project's `.mcp.json`, not `~/.claude/mcp.json`.
- `intutic gateway config set` says the change applies on the next heartbeat
  (every 30 seconds by default, `INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS`).
- `intutic attenuate`: a child key expires after `--ttl` or when the first key
  it descends from expires, whichever is sooner, and the printed expiry is that
  time. A parent that descends from an expired key is refused.
- `@intutic/shared-types`: `CapturedConfigFile.content` is optional and
  `sizeBytes` required; `ConfigDiff.currentContent` can be `null`, and
  `contentUploaded` says whether both snapshots carry content.

### Deprecated

- **Policy checks authenticated by key prefix alone.** From 2.1.0 the proxy
  sends its whole virtual key (`Authorization: Bearer vk_…`) with
  `POST /api/v1/policy/check`; older proxies send only the key prefix. The
  control plane still answers a prefix-only check whose prefix names a live key
  of the workspace, and now logs each one (`policy_check_prefix_only`, with the
  workspace, prefix and outcome) and counts it in the
  `policy_check_prefix_only` metric. Prefix-only checks will be refused in a
  later release, once that count stays at zero: upgrade proxies to 2.1.0 or
  later before then. A refused check blocks every request on a proxy that
  fails closed.

### Removed

- **`intutic predict-cost --task-type`.** Token baselines are recorded per
  model and input size only, so the task type selected nothing. Passing the
  option is now an error; drop it from scripts. `TokenBaseline.taskType` is
  removed from `@intutic/shared-types`.
- **`INTUTIC_PROMPT_QUALITY_GATE`** and the prompt quality gate it switched
  on, with the `--force` bypass that only skipped it. The gate posted every
  request to a scoring endpoint the control plane no longer has and failed
  open. `/intutic` slash commands are unchanged.
- **`INTUTIC_PROXY_IP` and `INTUTIC_PROXY_PORT`**, read only by the proxy's
  transparent-redirect firewall generators, which nothing called and which are
  deleted. `intutic enforce` and `intutic-proxy enforce` are unchanged.
- From `@intutic/sync-daemon`: `startSyncLoop` (with `SyncLoopOptions` and
  `SyncResult`), `writeConfigFiles` (`WriteResult`), `computeFileHashes`,
  `hashFile`, `loadIntegrity` and `saveIntegrity`. `intutic connect` is the
  sync loop. Git worktree propagation, which only that loop had, went with it.
- From `@intutic/shared-types`: the `budget.exceeded` and
  `finops.budget.overrun` notification events, which nothing sent (budget
  alerts are `finops.budget.threshold` and `finops.budget.exceeded`); the
  `TOOL_SUBSTITUTION` and `PARAMETER_DRIFT` deviation types and the
  `PENDING_APPROVAL` to `EXECUTING` plan transition, none of which the gates
  can observe; and `ChannelConfig.webhookSecret`, since every webhook's signing
  secret is now generated by the server.

### Fixed

- OpenHands: any workspace with a `config.toml` (every Hugo site, for one) was
  detected as OpenHands; detection now needs `.openhands/` or a table only
  OpenHands uses. A second edit replaced the first `base_url` anywhere in
  `config.toml` (an `[llm.draft_editor]` table's, say) with the bare proxy URL
  and created `~/.openhands/config.toml` on every machine; the user-level file
  now gets only `[llm] base_url`, and only when it exists.
- Goose: `provider.host` and `hooks.pre_tool_use` were set by replacing the
  first `host:` and `pre_tool_use:` lines in `config.yaml`, which could belong
  to an extension; they are now set by key, and a file that is not a mapping is
  left alone.
- The settings guard blanked Goose's and OpenHands' provider URL when it re-ran
  their writers; it now gets the synced proxy URL.
- `intutic env clear` on Linux added a newline to `~/.bashrc` per variable
  instead of restoring it, and left `/etc/environment` alone when `env
  persist` had run as root. It now removes exactly the lines persist wrote,
  from both, and a failed read no longer replaces `~/.bashrc` with the two
  exports.
- The control plane dropped every injection, anomaly and redaction event the
  MCP proxy reported. They are filed as detector findings, each with a
  structured finding from the proxy, and announced as `anomaly.finding`.
- The `@intutic/mcp-governance-proxy` README described `intutic-mcp-daemon` as
  a standalone MCP server; it is the policy and telemetry daemon, and the
  standalone server is `intutic-mcp-proxy` with no server to wrap.
- Docs: SOP titles are up to 256 characters and versions up to 16; budget
  alerts fire at the workspace's alert threshold and at the cap, once per
  period.

### Security

- **Hook redactor ReDoS.** 2.1.0's hold redactor, which runs in the generated
  hook gates before any length cap, matched private keys with a lazy
  `BEGIN…END` pattern that rescanned to the end of the text from every header
  without a footer: quadratic, so 520 KB of headers took over two seconds. Keys
  are now found in linear time, and a header with no footer is redacted to the
  end of the text.
- An MCP daemon restart disarmed daemon-mode MCP proxies: until its first fetch
  the daemon answered from the sync daemon's snapshot, which carries only the
  rules, and a proxy took that answer whole, resetting its tool and server
  allowlists, description overrides, DLP and injection patterns to
  unrestricted. A proxy that has loaded a full policy now takes only the rules
  from a snapshot answer.
- The MCP proxy ignored the workspace's `mcpProxyFailBehavior`, so a workspace
  set to fail closed failed open wherever `INTUTIC_MCP_FAIL_OPEN` was unset.
- Windsurf's Cascade traffic never went through the proxy: its proxy settings
  were written to a file Windsurf does not read.
- clawde SDKs: with `failOpen` (`fail_open`) set, the circuit breaker
  swallowed its own budget verdict along with connection errors, so a wrapped
  call ran exactly when the budget was gone. It now fails open only when the
  check could not be made.

## [2.1.0] - 2026-10-08

Everything that reached `main` since 2.0.0. Check three behaviour changes
before upgrading: `intutic skill audit` exits 1 on findings, the CLI no longer
reads `PORT`, and the clawde SDKs raise `ClawdeBlockedError` on a proxy
refusal instead of retrying it. Judges run only on self-hosted models, which
removes `judgeModelChoices` and `managedJudgeModel` (see Removed).

### Added

- **Destructive-SQL guard** on the proxy's response gate: destructive SQL run
  through `psql`, `mysql`, `sqlite3` or `dropdb` against a target that is not
  allowlisted is withheld. Off unless an SOP declares `sql_guard` (and
  `sql_allow_dsns`) in its front matter.
- **DeepSeek route**: `deepseek-chat`, `deepseek-reasoner` and `deepseek-flash`
  go to DeepSeek's own API on both the OpenAI and the Anthropic wire
  (`DEEPSEEK_UPSTREAM_URL` overrides it); other `deepseek-*` names keep going
  to the OpenAI-compatible upstream. `DEEPSEEK_API_MODEL_IDS` in
  `@intutic/shared-types`.
- **Typed stage for the self-hosted gateway's local judge**: with
  `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO` and `_HI` set, two one-token yes/no
  questions score the response first. Below the band it is compliant with no
  free-text call, above it a violation (the free-text judge runs once for the
  reasoning), and inside it the free-text verdict stands.
  `LITELLM_LOCAL_TYPED_JUDGE_MODEL` picks the model; there is no default band.
- **Skill protection**: nine content patterns that hit none of 350 public
  `SKILL.md` files block writes into a skills directory (`skill_content.*` in
  the policy snapshot); the daemon reports each bundled skill script's sha256
  (`SkillScriptsFacet`; hashes only, never content).
- **Guardrails on workspace settings**: `allowed_models` and `egress_allow`
  guardrail kinds on a `workspace_setting` target, rendered by
  `@intutic/shared-types` and shown and promoted by `intutic guardrails`.
- **Harnesses**: Microsoft Agent Framework (`intutic-clawde[agent-framework]`,
  `IntuticFunctionMiddleware`), the 43rd governed harness; Strands `BidiAgent`
  and multi-agent `Graph`/`Swarm` (`install_multiagent()`, requires
  `strands-agents>=1.57.2`); OpenCode MCP servers wrapped through the MCP
  governance proxy, so the per-server allowlist applies; the AgentCore
  interceptor's `composeRequestInterceptor()`, with `checkToolCall` and
  `readConfig` exported.
- **`@intutic/gate`**: `intuticApprovalStep()` runs the gate from a Workflow
  DevKit `"use step"` function; `intuticAuditHooks()` audits eve's
  `input.resolved`; harness approvals work on `@ai-sdk/harness` 1.0.101+, and
  the sandbox bootstrap registers the hook for each session.
- **WASM rules**: `setReason()` in the AssemblyScript rule SDK sets the message
  a block returns, through the `reason_ptr()`/`reason_len()` exports both
  proxies already read.
- **CLI**: `intutic login --control-plane-url` saves the control plane, and
  every command resolves it the same way (flag, then
  `INTUTIC_CONTROL_PLANE_URL`/`INTUTIC_DEV`, then the saved URL); `intutic
  integrity verify <root> --against <file>` compares your own copy with what
  the control plane serves; `init --git-hooks`/`--no-git-hooks`.
- `@intutic/shared-types`: `anthropicBaseUrl()`, `openaiBaseUrl()` and
  `proxyHost()`; the `judge.review.queued` notification event; the
  `E_PLAN_CHANGE_UNSUPPORTED`, `E_PLAN_FROM_ORG` and `E_CHECKOUT_UNAVAILABLE`
  error codes.

### Changed

- **`intutic skill audit` exits 1 when it has findings**, once the report, the
  SARIF document and the upload are done. `--exit-zero` keeps the old
  behaviour.
- **One local proxy port**: `start`, `connect`, `daemon install --proxy`,
  `budget`, `doctor` and `exec` all take it from `INTUTIC_PROXY_URL` (default
  4000), and `--port` overrides it. The shell's `PORT` is no longer read.
- **clawde SDKs** (`@intutic/clawde`, `intutic-clawde`): a proxy refusal
  (`403 policy_denied`, `409 policy_reask`, `429 OVERAGE_HARD_CAP_EXCEEDED`, …)
  fires the matching event and raises `ClawdeBlockedError` (verdict `kill`,
  `reask` or `hold`); only transport failures and 5xx are retried. Anthropic
  requests go to `/v1/messages`. The circuit breaker gains `requireBudget`;
  `maxCostUsd` (now only switches the budget check on), `sensitivityTier`
  (ignored), `budgetRemainingUsd`/`budgetPctUsed` (never set) and the
  `hijack`/`enhance`/`bypass` verdicts are deprecated.
- `intutic exec` runs without a login: it sets the base-URL variables and
  leaves your provider keys alone. `exec --sandbox` builds
  `intutic/sandbox:<CLI version>` from the Dockerfile the npm package now
  ships; the old `intutic/sandbox:latest` default was never published.
- `connect` uses the control plane saved by `intutic login` when no flag is
  given.
- Workflow DevKit: call the gate from a `"use step"` function.
  `@intutic/gate/workflow` no longer loads Node, and the old form inside the
  workflow sandbox refuses with `WORKFLOW_SANDBOX`, naming the fix.
- **Cline**: rules move to `.clinerules/intutic-governance.md` and the gate to
  `.clinerules/hooks/PreToolUse`. A flat `.clinerules` an earlier version
  wrote is converted; one you wrote is left alone. Cline's base URL is set in
  its own settings panel.
- Harness configs are merged, never replaced: Claude Code, Cursor (Cursor's
  `hooks.json` schema, plus `preToolUse` for writes and deletes), Windsurf
  (the real proxy port), OpenHands `config.toml`, Aider and Hermes YAML, and
  Pi's per-provider base URLs. Continue routes only OpenAI and Anthropic
  models. MCP auto-wrap reads Claude Code's servers from `~/.claude.json` and
  uses the proxy installed next to the CLI.
- dsh 0.2: the egress override goes on the `llm-deepseek` row of each
  profile's `cordis.patch.yml`. Until the plugin is installed dsh runs
  ungoverned and warns; the docs had called this fail-closed.
- `intutic judge configure` offers only self-hosted models, refuses a hosted
  custom reference, writes `api_base` for Ollama models, and gives Helm users
  the `--set-file litellm.config` flag; `intutic setup` no longer asks for a
  judge model.
- `intutic integrity verify` reports a root whose traces the three-year
  retention deleted (exit 0, signature still checked) instead of failing it.
- `execute_command` (Cline, Roo Code) counts as a shell tool in `@intutic/gate`
  and `intutic-clawde`, as it does in the proxy.
- The MCP governance proxy refuses WASM modules that import their memory or
  use instructions its metering cannot charge.
- The offline pricing bundle is re-pinned to LiteLLM upstream (2026-09-28,
  2026-10-07, 2026-10-08), and from now on nightly.
- The docs site and theme use Geist and Geist Mono (SIL OFL), self-hosted,
  with no Google Fonts requests.

### Removed

- `judgeModelChoices` from `@intutic/shared-types`, replaced by
  `selfHostedJudgeModelChoices()` (judge-capable Ollama models, Ollama Cloud
  excluded), `isHostedModelRef()` and `SELF_HOSTED_MODEL_PROVIDER_IDS`.
- `managedJudgeModel` from `WorkspaceSettings`; `PUT
  /api/v1/workspace/settings` rejects it with `400`.
- `BillingUsageSummary` from `@intutic/shared-types`; the endpoint it
  described is gone.
- `mergeSettingsYaml` from `@intutic/sync-daemon/harness/dshHooks`: dsh 0.2
  has no `settings.yaml`.
- The `x-intutic-judge-loop-guard` header (see Security).
- Proxy config keys that were parsed and never read: `general_settings`,
  `harness_overrides`, `litellm_params.api_key` and `litellm_params.api_base`.
  A LiteLLM config that still carries them loads.
- The VS Code `settings.json` injection for Cline and Roo Code, which neither
  extension reads (see Security).
- The clawde SDKs' `X-Intutic-Context`, `X-Intutic-Cost-Limit` and
  `X-Intutic-Sensitivity` request headers and their verdict and budget
  response-header parsing; the proxy never sent or read any of them.

### Fixed

- `UPSTREAM_URL`, which `intutic start --upstream-url` and the installed
  service set, was never read by the proxy. It is now the default upstream for
  every provider unless the provider's own `*_UPSTREAM_URL` is set.
- The proxy refused (403) every virtual key for a workspace whose id does not
  start with `ws_`, and invented a workspace for about 40 % of attenuated child
  keys.
- When the response gate refused a tool call on an OpenAI Chat or Responses
  stream, the text before it was lost; it now reaches the client, scrubbed,
  ahead of the refusal.
- The proxy's session-credential capture filed any non-virtual-key token as
  the workspace's Anthropic key, so an OpenAI or DeepSeek key overwrote it.
  Only `sk-ant-` tokens are captured now.
- CLI: `policy rollback <id> --version N` printed the CLI version;
  `install-daemon`/`uninstall-daemon` lacked the `daemon install` options;
  `doctor` asked a route that does not exist and probed Valkey through the
  proxy; `enforce --allow` accepted entries that are not IPs or CIDRs; `skill
  scan-staged` scanned the workspace `init` last recorded; `sync-context --git`
  ignored Git; `loop review` exited 0 when the review failed; `attenuate`
  accepted a `--ttl` the server refuses; `init` waited on a prompt without a
  terminal.
- `intutic-clawde` treats a judge verdict held for review (`REVIEW`) as not
  clean.
- `@intutic/gate`: `withIntuticProxy` accepts `apiKey` for `createOpenAI`; eve's
  `cancelled` outcome is handled; the harness bootstrap merge is idempotent.
- dsh profiles were pinned to `@intutic/gate ^0.1.0`, which no published
  version satisfies; `^2.0.0` is added only when the profile has no entry.
- The proxy container image installs `wget` for its health check.

### Security

- The proxy authenticates its budget and plan-limit check (`POST
  /api/v1/policy/check`) with the request's virtual key as the bearer. It sent
  only the key's 12-character prefix, which is not a secret, so the control
  plane could not tell the proxy from anyone asking about a workspace ID. A
  provider credential is never sent.
- The machine-wide daily cap (`maxDailyBudgetUsd`, $10 by default) applies only
  to a standalone proxy. On a proxy with a control plane, every workspace's
  spend accrued to one day file, so the day's combined traffic could refuse
  every request for every workspace until midnight. With `CONTROL_PLANE_URL`
  set, the control plane's per-workspace daily limit is the cap.
- A virtual key with no resolvable provider key now gets `402
  no_upstream_credential` instead of being forwarded to the provider.
- Any client could set `x-intutic-judge-loop-guard` to skip judging for its own
  traffic; the header is gone.
- `intutic connect` could wipe VS Code's user and workspace `settings.json`:
  the Cline/Roo Code injection replaced a file it failed to parse with only its
  own keys.
- `intutic connect` replaced `~/.codex/config.toml` (or `$CODEX_HOME`'s) with
  its own; it now merges `openai_base_url` into your file.
- Hook installation gaps: `connect` never installed the gate for Codex, GitHub
  Copilot, Continue, Antigravity, Open WebUI or n8n; Cline's gate sat where
  Cline does not look, Antigravity's under the wrong key, and Cursor's
  `hooks.json` was not in Cursor's schema; a Claude Code sync dropped the
  user's own `PreToolUse` hooks.
- The MCP governance proxy enforces the Rust proxy's WASM limits: 16 MB of
  memory (growth past it fails) and 1,000,000 instructions per call
  (exhaustion fails open for that call and counts toward disabling the rule).
  Memory used to be checked only after the call.
- Dependency updates for open advisories: `@modelcontextprotocol/sdk`, `vue`,
  `undici`, `shell-quote` and seven more on npm; `pyjwt`, `oauthlib`,
  `multidict`, `langgraph-sdk` and `urllib3` (floor `>=2.8.0`) for
  `intutic-clawde`; `rustls` 0.23.45 for the proxy.

### Documentation

- New reference pages: the Tool Gate SDK (`@intutic/gate` and
  `intutic_clawde.gate`), every environment variable the proxy, CLI and gate
  SDK read, every CLI command and option, and the regenerated API route
  catalog.
- The clawde SDK, WASM rule (`evaluate(offset, len)`, `risk_tier` values such
  as `High`), budgets (`maxDailyBudgetUsd`), workflow and Strands pages match
  the code; the competitor comparisons are rewritten against current code and
  public docs; native hook gates are in 19 of the 43 harnesses.

### Internal

- New gates: docs links and anchors, every environment variable documented
  both ways, no internal ids in published pages, the WASM pages' host-guest
  contract. CI runs the Rust job and each CodeQL language only when their
  inputs change, and groups Dependabot updates per ecosystem.

## [2.0.0] - 2026-09-27

A milestone release: no public API, wire format or configuration value that
worked on 1.10.x stops working.

### Changed

- **`TURBOVEC_URL` is a base URL.** Both semantic-cache routes now hang off it
  (`<base>/vectors/query`, `<base>/vectors/insert`), matching the TurboVec
  service. A legacy value naming one of those endpoints is still accepted: the
  proxy strips the route back to the base.
- The offline pricing bundle is re-pinned to current LiteLLM upstream twice
  (2026-09-26, 2026-09-27), picking up moved Azure `gpt-4o-mini` and OpenRouter
  DeepSeek rates.

### Added

- **BYO-key for paid workspaces only**: `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=paid`
  refuses (`402 byok_required`) only the workspaces the control plane marks
  `byokRequired` on the key; trials and exempt workspaces keep the gateway's own
  provider key. `true` still means every workspace, and unset/`false` is unchanged.
  `AuthContext.byokRequired` in `@intutic/shared-types`.

### Fixed

- npm publishing passes tarballs by an explicit `./` path (npm 11 read a bare
  `dir/file.tgz` as a GitHub shorthand).

### Internal

- The proxy is `rustfmt`-formatted and clippy-clean under `-D warnings`; CI now
  gates both, on a pinned Rust 1.98.0 toolchain.

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
  managed CA/MDM rollout and the device-enforcement CLI.
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
  with its dashboard-only steps marked paid-plan-only.
- `reference/configuration.md` documents the full `intutic_settings` surface;
  `reference/cli.md` documents the shipped `policy`, `doctor`, and `budget`
  commands.
- Corrected sandbox limits (16 MB memory / 1,000,000 fuel / 5 ms), the wasmtime
  version (29), and the harness adapter count (18) across README, package
  READMEs, and `AGENTS.md`/`CLAUDE.md`.

[1.6.0]: https://github.com/intutic/intutic/releases/tag/v1.6.0
