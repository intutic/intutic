---
title: QM
description: Point QM's securityScreen contract at Intutic to screen untrusted content flowing into pi, claude, codex, and opencode.
---

# QM <Badge type="warning" text="Server-side platform" />

Integrate Intutic with [QM](https://github.com/yc-software/qm) (Quartermaster) — the YC-backed, OSS (since 2026-07-29) multiplayer agent harness that runs an org's `pi`/`claude`/`codex`/`opencode` sub-harnesses centrally.

::: warning Not a CLI harness — nothing for `intutic connect` to write
QM is a server-side org platform, not something installed on a developer's laptop. There is **no `HarnessType` enum entry** for it and `intutic init`/`intutic connect` never detect or configure it — this integration is a deployment step an org admin performs once against QM's own config, not something the sync-daemon writes. Every other integration in this directory is onboarded through the CLI; QM is the first that isn't, deliberately.
:::

## What this actually screens

QM's `securityScreen` config block lets an org point QM at a third-party HTTP endpoint that classifies **untrusted external content** (inbound data, attachments and documents, shared skills, steering context, and external tool output) before it reaches the model. When `securityScreen.mode` is not `off`, QM screens under every security posture. Posture only caps enforcement: a Dangerous scope always observes.

This is **not** a per-tool-call allow/deny gate. QM's own `toolApprovals` mechanism (human-in-the-loop approval, only active at the `strict` posture) is a separate, posture-driven feature with no external-endpoint hook at all. `securityScreen` only ever sees free text (`{ text, hook }`), never a tool name or tool arguments.

Pointing QM's `securityScreen` at Intutic gets you:
- **DLP content scan** — the same secret/credential pattern set `/api/v1/hook-gate` uses (API keys, private keys, database connection strings, etc.), run against everything QM screens.
- **SOP `BLOCK:` rules with `argPattern`** — your workspace's validated SOP rules, matched against the screened content. See [Config Details](#config-details) for the adaptation this requires, since these rules were authored against tool names, not free text.

## Config

Verified against QM at commit [`7a0b6d98`](https://github.com/yc-software/qm/tree/7a0b6d987dd2031cfb20c53dadc8a86d5301e80f) (2026-10-02). Add a `securityScreen` block to your `qm.config.jsonc`:

```jsonc
{
  // ...
  "securityScreen": {
    // "observe": QM calls Intutic in the background and records each verdict
    //   in its audit log (status "would_block" for a flag). Nothing Intutic
    //   returns changes what the model sees.
    // "enforce": QM waits for Intutic's verdict and quarantines flagged
    //   content pending release approval.
    // "off": no screening.
    "mode": "observe",
    // "proxy" sends content to the endpoint below instead of QM's built-in model.
    "classifier": "proxy",
    // Lowercase DNS label. Must NOT be "surface" or "origin", which collide
    // with QM's own metadata field names.
    "provider": "intutic",
    // Must be HTTPS, with no credentials, fragment, or trailing hostname dot.
    "endpoint": "https://your-intutic-control-plane.example.com/api/v1/integrations/qm/security-screen"
  },
  "secretEnv": {
    // Maps the env var QM's core service reads to a name in QM's secret store.
    "core": { "SECURITY_SCREEN_PROXY_TOKEN": "INTUTIC_SCREEN_TOKEN" }
  }
}
```

QM sends the token as `x-api-key` on every screening request. Use a **workspace virtual key** (`vk_...`) from Settings › Security › Virtual API Keys in your Intutic dashboard (or `POST /api/v1/keys`), stored under the secret-store name you mapped above:

```bash
# QM's gitignored .env; `qm secrets push` uploads it to Fly secrets or AWS Secrets Manager.
INTUTIC_SCREEN_TOKEN=vk_your_intutic_workspace_key
```

::: warning `rollout` and `backend` are retired
Older QM releases used `"backend": "proxy"` and `"rollout": "shadow" | "enforce"`. At `7a0b6d98` QM refuses to start with either key (the one exception: a block containing only `"backend": "off"` loads as `mode: "off"` with a warning). `observe` replaces `shadow`, with one difference: QM no longer runs its built-in classifier alongside yours for comparison. In `observe`, Intutic is the only classifier, and its verdicts are only recorded.
:::

::: tip `mode` never reaches Intutic
QM decides locally whether to wait for Intutic's answer (`enforce`) or only record it (`observe`). The mode is never sent over the wire. Intutic's endpoint returns the same verdict either way, so there is nothing to configure on the Intutic side to match. Start with `observe`, review QM's `security_screen.classify` audit records (status `allow`, `would_block`, or `error`, with the score and outcome) for what Intutic would have flagged, then switch to `enforce`.
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
| Request | `{ text: string, hook: "user_input" \| "tool_response", metadata?: object }`. QM chunks long content at 1,600 characters (256 overlap, 16,000 total) and sends one request per chunk; `metadata.qm` (and `metadata.<provider>`) carry `{ request_id, input_index, chunk_index, chunk_count }` |
| Response | `{ score: number (0 or 1), threshold: 0.5, primary_outcome?: string }` — never an `allowed`/`decision` field. QM flags when `score >= threshold` |
| `mode` visibility | Not transmitted to Intutic — QM applies it locally |
| Failure behavior | A non-2xx, invalid, or timed-out response fails open on QM's side: the content goes through marked untrusted, with an `error` audit record |
| Verified against | QM commit `7a0b6d987dd2031cfb20c53dadc8a86d5301e80f`. A control-plane test runs QM's own client from that commit against this endpoint |

**The SOP `argPattern` adaptation.** Because QM's payload has no tool name, this endpoint matches your `BLOCK:` SOP rules against a synthetic tool name, `security_screen:<hook>` (e.g. `security_screen:tool_response`). A rule scoped to a real tool (`BLOCK:^bash$:...`) will **never** match content screened this way. To write a rule that applies here, target the synthetic name directly:

```
BLOCK:security_screen.* WHERE ignore previous instructions:Prompt-injection phrase detected
```

## Setup & Activation

### 1. Mint a workspace virtual key
In the Intutic dashboard, create a virtual API key in the workspace QM should report against, from Settings › Security › Virtual API Keys (or `POST /api/v1/keys`). This is the value for `SECURITY_SCREEN_PROXY_TOKEN`.

### 2. Configure `qm.config.jsonc`
Add the `securityScreen` block and `secretEnv` entry shown above, and deploy the secret through whatever mechanism your QM hosting target (Fly/AWS/Docker) uses.

### 3. Start in observe, watch QM's audit log
Deploy with `"mode": "observe"` first. Each screening writes one `security_screen.classify` audit record. `would_block` marks content Intutic flagged; `error` marks a failed call. Review those before switching to `"enforce"`.

Intutic does not record a governance incident for a flagged verdict. It cannot tell whether QM is observing or enforcing, so the verdict appears only in QM's audit log and as a warning in the control-plane log.

### 4. (Optional) Route LLM egress through Intutic too
Set `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` as shown above — independent of the `securityScreen` setup.
