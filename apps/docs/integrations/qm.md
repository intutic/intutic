---
title: QM
description: Point QM's securityScreen contract at Intutic to screen untrusted content flowing into pi, claude, codex, and opencode.
---

# QM <Badge type="warning" text="Server-side platform" />

Integrate Intutic with [QM](https://github.com/yc-software/qm) (Quartermaster) — the YC-backed, OSS (since 2026-07-29) multiplayer agent harness that runs an org's `pi`/`claude`/`codex`/`opencode` sub-harnesses centrally.

::: warning Not a CLI harness — no `intutic connect --harness` target
QM is a server-side org platform, not something installed on a developer's laptop. There is **no `HarnessType` enum entry** for it and `intutic init`/`intutic connect` never detect or configure it — this integration is a deployment step an org admin performs once against QM's own config, not something the sync-daemon writes. Every other integration in this directory is onboarded through the CLI; QM is the first that isn't, deliberately.
:::

## What this actually screens

QM's `securityScreen` config block lets an org point QM at a third-party HTTP endpoint that classifies **untrusted external content** — overheard messages, webhook/monitor input, and tool responses — before that content reaches the model. It is part of QM's `auto` security posture's `inboundScreening: "external"` behavior.

This is **not** a per-tool-call allow/deny gate. QM's own `toolApprovals` mechanism (human-in-the-loop approval, only active at the `strict` posture) is a separate, posture-driven feature with no external-endpoint hook at all. `securityScreen` only ever sees free text (`{ text, hook }`), never a tool name or tool arguments.

Pointing QM's `securityScreen` at Intutic gets you:
- **DLP content scan** — the same secret/credential pattern set `/api/v1/hook-gate` uses (API keys, private keys, database connection strings, etc.), run against everything QM screens.
- **SOP `BLOCK:` rules with `argPattern`** — your workspace's validated SOP rules, matched against the screened content. See [Config Details](#config-details) for the adaptation this requires, since these rules were authored against tool names, not free text.

## Config

Add a `securityScreen` block to your `qm.config.jsonc`:

```jsonc
{
  // ...
  "securityScreen": {
    "backend": "proxy",
    // Lowercase DNS label. Must NOT be "surface" or "origin" — those
    // collide with QM's own metadata field names.
    "provider": "intutic",
    "endpoint": "https://your-intutic-control-plane.example.com/api/v1/integrations/qm/security-screen",
    // "shadow": Intutic's verdict is logged for comparison against QM's own
    //   built-in classifier, which stays authoritative. Nothing Intutic
    //   returns can affect what the model sees.
    // "enforce": Intutic's verdict is authoritative.
    "rollout": "shadow"
  }
}
```

Then set the token QM sends as `x-api-key` on every screening request — a **workspace virtual key** (`vk_...`) from `POST /api/v1/keys` in your Intutic dashboard:

```jsonc
{
  "secretEnv": {
    "core": ["SECURITY_SCREEN_PROXY_TOKEN"]
  }
}
```

```bash
# Wherever QM's core service reads its secrets from (Fly/AWS/Docker secrets, etc.)
SECURITY_SCREEN_PROXY_TOKEN=vk_your_intutic_workspace_key
```

::: tip `rollout` never reaches Intutic
QM decides locally whether to await Intutic's answer directly (`enforce`) or run it in parallel purely for comparison (`shadow`) — this choice is never sent over the wire. Intutic's endpoint always returns its honest verdict regardless of your `rollout` setting; there is nothing to configure on the Intutic side to match it. Start with `shadow`, watch QM's own audit log (`security_screen.shadow_evaluation` events) for how often Intutic and QM's built-in classifier agree, then flip to `enforce` when you're comfortable.
:::

## Routing QM's own LLM egress through Intutic (separate from securityScreen)

QM lets an org set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `OPENROUTER_BASE_URL` centrally, and QM forwards these down to its child harness processes (`pi`, `claude`, `codex`, `opencode`) — their own env allowlists pass these through. This is unrelated to `securityScreen`; set it to route QM's model calls through the Intutic proxy for cost/policy telemetry on top of the content screening above:

```jsonc
{
  "env": {
    "core": {
      "ANTHROPIC_BASE_URL": "https://your-intutic-proxy.example.com",
      "OPENAI_BASE_URL": "https://your-intutic-proxy.example.com/openai"
    }
  }
}
```

## Config Details

| Property | Value |
|----------|-------|
| Integration type | Server-side platform (no `HarnessType` enum entry) |
| Endpoint | `POST /api/v1/integrations/qm/security-screen` |
| Auth | `x-api-key: vk_...` header — **not** `Authorization: Bearer`. QM's client hardcodes this header name. |
| Request | `{ text: string, hook: "user_input" \| "tool_response", metadata?: object }` |
| Response | `{ score: number (0 or 1), threshold: 0.5, primary_outcome?: string }` — never an `allowed`/`decision` field |
| `rollout` visibility | Not transmitted to Intutic — QM applies it locally |

**The SOP `argPattern` adaptation.** Because QM's payload has no tool name, this endpoint matches your `BLOCK:` SOP rules against a synthetic tool name, `security_screen:<hook>` (e.g. `security_screen:tool_response`). A rule scoped to a real tool (`BLOCK:^bash$:...`) will **never** match content screened this way. To write a rule that applies here, target the synthetic name directly:

```
BLOCK:security_screen.* WHERE ignore previous instructions:Prompt-injection phrase detected
```

## Setup & Activation

### 1. Mint a workspace virtual key
In the Intutic dashboard, create an API key scoped to the workspace QM should report against (`POST /api/v1/keys`). This is the value for `SECURITY_SCREEN_PROXY_TOKEN`.

### 2. Configure `qm.config.jsonc`
Add the `securityScreen` block and `secretEnv` entry shown above, and deploy the secret through whatever mechanism your QM hosting target (Fly/AWS/Docker) uses.

### 3. Start in shadow, watch QM's audit log
Deploy with `rollout: "shadow"` first. QM records `security_screen.classify` and `security_screen.shadow_evaluation` audit events comparing Intutic's verdict against QM's own built-in classifier — review those before flipping to `enforce`.

### 4. (Optional) Route LLM egress through Intutic too
Set `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` as shown above — independent of the `securityScreen` setup.
