# dsh <Badge type="warning" text="Preview" />

Integrate Intutic governance with [DeepSeek's "dsh"](https://github.com/deepseek-ai/deepseek-harness) — a **developer preview** (`@deepseek-ai/dsh`, first published 2026-08-13) plugin-first coding-agent harness built on DeepSeek's own "Cordis" extensibility framework.

::: warning PREVIEW — breaking changes possible
dsh is a developer preview with its own stated breaking-changes policy. This integration was last verified — including a live session — against `@deepseek-ai/dsh` **0.2.0-rc.2**, and declares `@intutic/gate` `^2.0.0` in a profile's `package.json` when the profile has no declaration of its own. A preview product can still change its plugin API, its `tools/pre-execute` payload shape, or its configuration layout between releases (0.2 moved live configuration out of `settings.yaml` and into each profile's `cordis.patch.yml`). [Known gaps](#known-gaps) lists what remains open.
:::

## How it works

Unlike every other native harness Intutic supports, dsh has no `hooks.json`/shell-script gate surface at all — it is plugin-first ("Cordis," DeepSeek's own extensibility system). The blocking gate for dsh ships as a real, checked-in TypeScript module, [`@intutic/gate/dsh`](https://www.npmjs.com/package/@intutic/gate) (`packages/gate-js/src/dsh.ts` in this repo), not a per-workspace generated script the way Grok Build's or Muse Code's gates are.

That module is a genuine [Cordis Plugin](https://github.com/cordiverse/cordis) subscribed to dsh's `tools/pre-execute` event — a `waterfall` (Cordis's cooperative, composable event-dispatch mode) that runs before every tool call. It calls into `@intutic/gate`'s own four-tier `Gate.guard()` evaluator and returns `{kind: 'deny', reason}` to veto a call, or calls the waterfall's `next()` to let it (and any other listener, including dsh's own built-in approval flow) proceed.

Intutic's sync daemon does not generate this plugin file — it already exists, published on npm. What the daemon writes is the **registration**: a row in every existing dsh profile's `cordis.patch.yml` naming the plugin, plus the `@intutic/gate` dependency declaration in that profile's `package.json`, plus — in that same `cordis.patch.yml` — a `baseURL` override on the `llm-deepseek` entry, dsh's default LLM route, for LLM egress. It also (re)generates `$DSH_HOME/INSTALL.md` on every sync — see step 5 and "What gets written" below.

## Setup

### 1. dsh detection

dsh is detected by any of:
- `$DSH_HOME` (defaults to `~/.dsh/`) containing `settings.yaml` (left by dsh releases before 0.2), `.credentials.yaml`, or a `profiles/` directory, **or**
- the `dsh` binary being found in your `PATH`.

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ dsh →
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Connect

```bash
intutic connect
```

`intutic connect` starts the proxy and writes the dsh registration described below (dsh must be in `~/.intutic/config.json`'s `harnesses`, which `intutic init` records when it detects dsh).

### 4. Run dsh with a profile at least once

dsh's own CLI **requires** `--profile <name>` on every invocation — there is no bare "default" profile. Intutic's writer only registers into profiles that already exist:

```bash
dsh --profile myproject
```

If you have never run `dsh` before, `intutic connect` logs `dsh_skip` and does nothing yet — there is no profile to register into. The next sync cycle after your first `dsh --profile <name>` run picks it up automatically.

### 5. Install the plugin's dependency

Intutic declares `@intutic/gate` in your profile's `package.json`, but — like every other Intutic writer — cannot run a package manager on your behalf. Install it once per profile:

```bash
dsh plugin --profile myproject add @intutic/gate
```

dsh 0.2 installs it as a plain profile dependency and prints `@intutic/gate declares no dsh.bundle — installed as a plain dependency, not a profile layer`. That warning is expected: the `cordis.patch.yml` row Intutic wrote is what loads the plugin. (`cd $DSH_HOME/profiles/myproject && pnpm add @intutic/gate` is equivalent.)

::: danger Until this step runs, dsh is NOT governed
Without the package, dsh cannot import the row's module. It prints two lines on stderr at every start and then runs the session with **no gate**:

```
dsh: warning: 1 entry did not activate
intutic-governance (@intutic/gate/dsh): failed to import
```

dsh offers no way for a profile row to make startup fail instead, so this step is permanent and manual. `intutic status` shows which profiles are registered but not yet activated.
:::

The CLI's own onboarding text (shown when `intutic connect` starts with dsh recorded) prints this same command, per profile, so you don't have to come back to this page to find it.

Every sync also (re)writes `$DSH_HOME/INSTALL.md`, listing the exact `dsh plugin --profile <name> add @intutic/gate` command for every profile currently registered — a standing, always-current reference alongside the onboarding text (the same pattern the [n8n integration](/integrations/n8n)'s own auto-generated INSTALL.md follows).

## Coverage visibility

Two places surface the "silent no-profile window" (dsh installed but never run, so there is no profile to register into) and the pending activation step above, so neither goes unnoticed between syncs:

- **`intutic status`** prints a dedicated `dsh (DeepSeek harness):` block: a warning when dsh is detected but has zero profiles, or — once profiles exist — a per-profile breakdown of which ones are registered but not yet activated (pointing at `INSTALL.md`), versus fully registered and activated.
- **`intutic connect`** checks once at startup (not on every poll tick, since the gap only changes state on your first `dsh --profile <name>` run) and logs a warning if dsh is present on the machine with zero profiles yet.

## What gets written

- **Plugin registration:** a `{ insert: [{ id: 'intutic-governance', name: '@intutic/gate/dsh', config: {...} }] }` row merged into every existing `$DSH_HOME/profiles/*/cordis.patch.yml` — a structural YAML edit (via the `yaml` package's `parseDocument`/`setIn`) that preserves every other row and any comments/formatting around it.
- **Dependency:** `@intutic/gate` `^2.0.0` added to that profile's `package.json` `dependencies` only when the profile declares none — a range `dsh plugin add` already wrote is left alone (see step 5 above for why the declaration alone is not enough).
- **LLM egress — default route:** a `{ id: llm-deepseek, config: { baseURL: <proxy> } }` override in the same `cordis.patch.yml`. In dsh 0.2 the `llm-deepseek` entry is `@deepseek-ai/dsh-llm-deepseek-api-key`, which serves the `deepseek-official` provider that `dsh-base`'s `agent-default-model` row selects (`deepseek-flash`). A Cordis override replaces the entry's whole `config`, so when the profile already overrides `llm-deepseek` (for example after a Models-page save), only `baseURL` is set on that row and its other fields (`apiKeyEnv`, `reasoningEffort`, `models`, ...) are kept. Requests then go to `<proxy>/v1/messages` in the Anthropic Messages format.
- **How the proxy forwards them:** the proxy sends DeepSeek's own API model ids (`deepseek-chat`, `deepseek-reasoner`, and `deepseek-flash`, which dsh uses) to DeepSeek. These Messages requests go unchanged to DeepSeek's Anthropic-compatible API at `$DEEPSEEK_UPSTREAM_URL/anthropic/v1/messages` (default `https://api.deepseek.com`). OpenAI-format requests (`/v1/chat/completions`) for the same models go to `$DEEPSEEK_UPSTREAM_URL/v1/chat/completions`, and any other route naming one of them is refused with 400 `unsupported_route`. DeepSeek requests get the same governance as any other provider: DLP, SOP rules, the response gate's tool-call refusals, and metering. Open-weight names such as `deepseek-r1`, `deepseek-coder-v2-instruct` or `deepseek-r1:7b` are not DeepSeek's API and keep going to `OPENAI_UPSTREAM_URL`. The upstream key comes from one of two places:
  - **dsh's own `DEEPSEEK_API_KEY`:** dsh sends it in `x-api-key`, and the proxy passes it through.
  - **An Intutic virtual key:** if you set `DEEPSEEK_API_KEY` to a virtual key (`vk_...`), as a gateway that accepts only virtual keys requires, the proxy sends the workspace's DeepSeek key in its place. Provision that key under Settings › Security › Provider Keys, or set `DEEPSEEK_API_KEY` on a self-hosted proxy. Without one, the request is refused with 402 (`no_upstream_credential`, or `byok_required` where the gateway requires your own key). The virtual key is never sent to DeepSeek.
- **Not redirected:** the signed-in DeepSeek *account* route (`llm-deepseek-account`), whose token dsh only releases to DeepSeek's own origin, and `llm-pi-ai` routes you configure yourself. Earlier versions of this integration also wrote an `llm-pi-ai` route into `$DSH_HOME/settings.yaml`; dsh 0.2 no longer reads that file (it imports it once into the first profile that boots and renames it `settings.yaml.imported`), so Intutic no longer writes it.
- **`$DSH_HOME/INSTALL.md`:** regenerated every sync (write-if-changed) — lists the manual `dsh plugin --profile <name> add @intutic/gate` command for every currently-registered profile. See step 5 above.
- **Protected paths:** agent tool calls that touch `.dsh/profiles`, `.dsh/cordis.patch.yml` (the home-level patch layer, which outranks every profile's) or `.dsh/settings.yaml` are blocked by the generated gates.
- **No rules file.** dsh has no workspace-relative rules/instructions file this integration writes governance text into — its config lives entirely under `$DSH_HOME`, not the project workspace.

To undo what `intutic connect` writes here, run `intutic disconnect --harness dsh`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Pre-tool hooks (blocking)

dsh's veto contract is **confirmed**, not assumed — read from `@deepseek-ai/dsh-tools`'s shipped code (re-read for 0.2.0-rc.2) and observed in a live 0.2.0-rc.2 session:

- The event is `tools/pre-execute`, declared by `@deepseek-ai/dsh-tools` — dsh's own tool-execution pipeline's "reorderable allow/deny/ask gate." It fires for **every** tool call unconditionally, not behind an opt-in matcher.
- It is a genuine Cordis `waterfall`: `(exec, next) => Promise<PreToolDecision>`. `PreToolDecision` is `{kind:'allow'}` | `{kind:'deny', reason}` | `{kind:'ask', reason?}` | `{kind:'cancel'}` (`cancel` is new in 0.2).
- A deny reaches the model as an error tool result (`Error: <reason>`) and the tool never runs. An `ask` goes to dsh's approval service, and becomes a deny when no approval service is mounted. Guards that run after the waterfall can only deny, so nothing later turns Intutic's deny back into an allow.
- Intutic's plugin calls `next()` on allow (so later listeners — including dsh's own built-in approval flow — still run) and returns `{kind:'deny', reason}` without calling `next()` to veto, per Cordis's own waterfall semantics ("a listener that does not call `next()` vetoes the rest of the chain").
- A crash inside the gate (anything other than its own structured refusal) is treated as "cannot evaluate" and denied — fail-closed, the same posture every other harness's gate in this product takes.

Every decision is appended to `.intutic/events/hook-events.jsonl` and drained to the control plane, same as every other harness.

::: tip Enforcement tiers under dsh vs. under a shell/JS hook
`@intutic/gate`'s Tier A1 (the local policy snapshot) reads **only** `~/.intutic/hooks/policy-snapshot.rules` — unlike the shell/JS gates this product generates for other harnesses, it does not separately compile in the "static floor" (bypass/secret-content/skill-surface pattern tables). A dsh workspace therefore gets Tier A1 (snapshot rules), Tier A2 (image integrity), Tier A3 (SOP rules), and Tier B (the control-plane `/hook-gate` call) — a strict subset of the compiled-in floor a generated shell/JS hook enforces, by design (this is a pre-existing, documented gap in the `@intutic/gate` package itself, not something dsh's integration introduced). See `@intutic/gate`'s own README for the full accounting.
:::

## Known gaps

What remains open:

1. The signed-in DeepSeek account route is not redirected (see "What gets written"). dsh releases that route's token only to DeepSeek's own origin, so this limit is permanent.
2. A machine where dsh has never been run has no profile to register into until the user's first `dsh --profile <name>` run.
3. The plugin needs a manual install per profile (step 5 above). Until then dsh warns and runs **ungoverned** — this is a permanent, accepted step.

The proxy's DeepSeek route is tested against a mock DeepSeek upstream (`packages/proxy/tests/deepseek_routing_test.rs`). It has not been tested against the real DeepSeek API or with a live dsh session through the proxy.

(The three access-restricted dsh packages earlier versions of this page listed are no longer dsh dependencies as of 0.2; their roles moved to public packages that were read directly.)

## Config details

| Property | Value |
|----------|-------|
| Harness type | `dsh` |
| Config file | none (dsh has no workspace-relative rules file) |
| Registration files | `$DSH_HOME/profiles/*/cordis.patch.yml` (plugin row + `llm-deepseek` egress row), `$DSH_HOME/profiles/*/package.json` |
| Gate module | [`@intutic/gate/dsh`](https://www.npmjs.com/package/@intutic/gate) — a real, checked-in TypeScript Cordis plugin, not a generated script |
| Detection | `$DSH_HOME`/`~/.dsh/` (`settings.yaml`, `.credentials.yaml`, or `profiles/`), or `dsh` in `PATH` |
| Format | YAML |
| Write strategy | Structural YAML edit (write-if-changed), atomic rename |
| Block contract | Cordis waterfall — returns `{kind:'deny', reason}` without calling `next()` — confirmed against `@deepseek-ai/dsh-tools`' shipped code and in a live session |
| Last verified | `@deepseek-ai/dsh` 0.2.0-rc.2, 2026-10-03 |

::: tip Live-verified against dsh 0.2.0-rc.2
On 2026-10-03 a headless `dsh` 0.2.0-rc.2 session ran against a local scripted model, with `@intutic/gate` 2.0.0 installed through `dsh plugin add` and a policy snapshot that blocks one command. The model's request for that command was refused: the command never ran and the model received the block reason as an error tool result, while a command the snapshot does not match ran normally. Every model request went to the `baseURL` Intutic wrote. Not covered: a real DeepSeek endpoint, the Intutic proxy in the path (its DeepSeek route was added afterwards and is tested against a mock upstream), and the web/ACP templates' approval UIs.
:::
