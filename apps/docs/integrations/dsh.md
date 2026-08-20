# dsh <Badge type="warning" text="Preview" />

Integrate Intutic governance with [DeepSeek's "dsh"](https://github.com/deepseek-ai/deepseek-harness) — a **developer preview** (`@deepseek-ai/dsh`, first published 2026-08-13) plugin-first coding-agent harness built on DeepSeek's own "Cordis" extensibility framework.

::: warning PREVIEW — breaking changes possible
dsh is a developer preview with its own stated breaking-changes policy. This integration is pinned against a tested version range (`@intutic/gate` `^0.1.0` in the profile's own `package.json`) rather than `latest`, matching the honesty style already established for [Muse Code](/reference/harness-security-matrix#muse-code) and [Grok Build](/reference/harness-security-matrix#grok-build) — but a preview product can still change its plugin API, its `tools/pre-execute` payload shape, or its `settings.yaml` schema out from under a pinned integration. See [TD-370](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md) for exactly what this integration confirmed against a real install and what remains open.
:::

## How it works

Unlike every other native harness Intutic supports, dsh has no `hooks.json`/shell-script gate surface at all — it is plugin-first ("Cordis," DeepSeek's own extensibility system). The blocking gate for dsh ships as a real, checked-in TypeScript module, [`@intutic/gate/dsh`](https://www.npmjs.com/package/@intutic/gate) (`packages/gate-js/src/dsh.ts` in this repo), not a per-workspace generated script the way Grok Build's or Muse Code's gates are.

That module is a genuine [Cordis Plugin](https://github.com/cordiverse/cordis) subscribed to dsh's `tools/pre-execute` event — a `waterfall` (Cordis's cooperative, composable event-dispatch mode) that runs before every tool call. It calls into `@intutic/gate`'s own four-tier `Gate.guard()` evaluator and returns `{kind: 'deny', reason}` to veto a call, or calls the waterfall's `next()` to let it (and any other listener, including dsh's own built-in approval flow) proceed.

Intutic's sync daemon does not generate this plugin file — it already exists, published on npm. What the daemon writes is the **registration**: a row in every existing dsh profile's `cordis.patch.yml` naming the plugin, plus the `@intutic/gate` dependency declaration in that profile's `package.json`, plus proxy routes merged into `settings.yaml`'s `llm-deepseek` (dsh's default LLM route) and `llm-pi-ai` (a kept selectable route) sections for LLM egress. It also (re)generates `$DSH_HOME/INSTALL.md` on every sync — see step 5 and "What gets written" below.

## Setup

### 1. dsh detection

dsh is detected by any of:
- `$DSH_HOME` (defaults to `~/.dsh/`) containing `settings.yaml`, `.credentials.yaml`, or a `profiles/` directory, **or**
- the `dsh` binary being found in your `PATH`.

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • dsh → (no rules file — see "What gets written" below)
```

### 3. Start the proxy

```bash
intutic connect --harness dsh
```

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

(or `cd $DSH_HOME/profiles/myproject && pnpm install`, if you manage the profile's `node_modules` directly). Until this runs, the `cordis.patch.yml` row Intutic wrote names a module Node cannot yet resolve, and dsh's own loader reports that row failed to activate — a **fail-loud** gap you will see in dsh's own diagnostics, not a silent one.

The CLI's own onboarding text (shown after `intutic init`/`intutic connect --harness dsh`) prints this same command, per profile, so you don't have to come back to this page to find it.

Every sync also (re)writes `$DSH_HOME/INSTALL.md`, listing the exact `dsh plugin --profile <name> add @intutic/gate` command for every profile currently registered — a standing, always-current reference alongside the onboarding text (the same pattern the [n8n integration](/integrations/n8n)'s own auto-generated INSTALL.md follows).

## Coverage visibility

Two places surface the TD-370 "silent no-profile window" and the pending activation step above, so neither goes unnoticed between syncs:

- **`intutic status`** prints a dedicated `dsh (DeepSeek harness):` block: a warning when dsh is detected but has zero profiles, or — once profiles exist — a per-profile breakdown of which ones are registered but not yet activated (pointing at `INSTALL.md`), versus fully registered and activated.
- **`intutic connect`** checks once at startup (not on every poll tick, since the gap only changes state on your first `dsh --profile <name>` run) and logs a warning if dsh is present on the machine with zero profiles yet.

## What gets written

- **Plugin registration:** a `{ insert: [{ id: 'intutic-governance', name: '@intutic/gate/dsh', config: {...} }] }` row merged into every existing `$DSH_HOME/profiles/*/cordis.patch.yml` — a structural YAML edit (via the `yaml` package's `parseDocument`/`setIn`) that preserves every other row and any comments/formatting around it.
- **Dependency:** `@intutic/gate` added to that profile's `package.json` `dependencies` (see step 5 above for why this alone is not enough).
- **LLM egress — default route:** `settings.yaml`'s `llm-deepseek.baseURL` is overridden to the local Intutic proxy. `llm-deepseek` is dsh's **actual default** LLM route (the native DeepSeek adapter `dsh-base`'s own `agent-default-model` row points at) — this merge is what redirects a fresh profile's default egress, no further configuration needed. Only `baseURL` is touched; every other field in that section (`apiKeyEnv`, `thinking`, `models`, ...) round-trips untouched.
- **LLM egress — selectable route:** an `intutic` route also merged into `settings.yaml`'s `llm-pi-ai.providers` map (`baseURL` pointed at the local Intutic proxy). `llm-pi-ai` is not dsh's default route and mounts dormant until a `llm-pi-ai:` section exists at all — this merge keeps it available as an explicit, user-selectable alternative alongside the default-route merge above, it does not replace it.
- **`$DSH_HOME/INSTALL.md`:** regenerated every sync (write-if-changed) — lists the manual `dsh plugin --profile <name> add @intutic/gate` command for every currently-registered profile. See step 5 above.
- **No rules file.** dsh has no workspace-relative rules/instructions file this integration writes governance text into — its config lives entirely under `$DSH_HOME`, not the project workspace.

## Pre-tool hooks (blocking)

dsh's veto contract is **confirmed**, not assumed — this integration was authored against a real `npm pack` and read of `@deepseek-ai/dsh`, `@deepseek-ai/cordis`, and `@deepseek-ai/dsh-tools`'s shipped TypeScript declarations, not solely from documentation:

- The event is `tools/pre-execute`, declared by `@deepseek-ai/dsh-tools` — dsh's own tool-execution pipeline's "reorderable allow/deny/ask gate." It fires for **every** tool call unconditionally, not behind an opt-in matcher.
- It is a genuine Cordis `waterfall`: `(exec, next) => Promise<PreToolDecision>`. `PreToolDecision` is `{kind:'allow'}` | `{kind:'deny', reason}` | `{kind:'ask', reason?}`.
- Intutic's plugin calls `next()` on allow (so later listeners — including dsh's own built-in approval flow — still run) and returns `{kind:'deny', reason}` without calling `next()` to veto, per Cordis's own waterfall semantics ("a listener that does not call `next()` vetoes the rest of the chain").
- A crash inside the gate (anything other than its own structured refusal) is treated as "cannot evaluate" and denied — fail-closed, the same posture every other harness's gate in this product takes.

Every decision is appended to `.intutic/events/hook-events.jsonl` and drained to the control plane, same as every other harness.

::: tip Enforcement tiers under dsh vs. under a shell/JS hook
`@intutic/gate`'s Tier A1 (the local policy snapshot) reads **only** `~/.intutic/hooks/policy-snapshot.rules` — unlike the shell/JS gates this product generates for other harnesses, it does not separately compile in the "static floor" (bypass/secret-content/skill-surface pattern tables). A dsh workspace therefore gets Tier A1 (snapshot rules), Tier A2 (image integrity), Tier A3 (SOP rules), and Tier B (the control-plane `/hook-gate` call) — a strict subset of the compiled-in floor a generated shell/JS hook enforces, by design (this is a pre-existing, documented gap in the `@intutic/gate` package itself, not something dsh's integration introduced). See `@intutic/gate`'s own README for the full accounting.
:::

## Known gaps

See [TD-370](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md) for the complete record. In short:

1. Three of dsh's own npm packages (`@deepseek-ai/dsh-permission`, `@deepseek-ai/dsh-settings-local`, `@deepseek-ai/dsh-fs-policy`) are access-restricted and could not be inspected directly — this integration's `settings.yaml` schema and dsh's own native sandbox/approval interaction are inferred from sibling packages' documentation, not read from source.
2. The `llm-pi-ai` route this integration also merges into is **not** dsh's default LLM route (`llm-deepseek`, the native DeepSeek adapter, is) and mounts dormant until configured — that merge alone adds only a selectable route. Default egress redirection is handled separately, by the `llm-deepseek.baseURL` merge described above.
3. A machine where dsh has never been run has no profile to register into until the user's first `dsh --profile <name>` run.
4. The plugin still needs a manual dependency install (step 5 above) before it actually loads.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `dsh` |
| Config file | none (dsh has no workspace-relative rules file) |
| Registration files | `$DSH_HOME/profiles/*/cordis.patch.yml`, `$DSH_HOME/profiles/*/package.json`, `$DSH_HOME/settings.yaml` |
| Gate module | [`@intutic/gate/dsh`](https://www.npmjs.com/package/@intutic/gate) — a real, checked-in TypeScript Cordis plugin, not a generated script |
| Detection | `$DSH_HOME`/`~/.dsh/` (`settings.yaml`, `.credentials.yaml`, or `profiles/`), or `dsh` in `PATH` |
| Format | YAML |
| Write strategy | Structural YAML edit (write-if-changed), atomic rename |
| Block contract | Cordis waterfall — returns `{kind:'deny', reason}` without calling `next()` — confirmed against real `@deepseek-ai/dsh-tools` type declarations |

::: tip Not fully live-verified
dsh could not be run interactively in the environment this integration was built in. The `tools/pre-execute` event, the `PreToolDecision` shape, and the `cordis.patch.yml`/profile structure are confirmed by reading dsh's own shipped TypeScript declarations (a stronger bar than documentation alone) — but an actual blocked tool call, end to end inside a running `dsh` session, was not observed. See TD-370.
:::
