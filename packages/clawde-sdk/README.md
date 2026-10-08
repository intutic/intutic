# @intutic/clawde

Programmatic client SDK for intercepting, wrapping, and enforcing policies on AI coding agent scripts.

## Installation

```bash
npm install @intutic/clawde
```

## Features

- **Governed chat:** `chat()` sends a request through the proxy and resolves with `verdict: 'allow'`. A governance refusal (policy block, reask, loop run held for review, spend cap, DLP block) throws `ClawdeBlockedError` with the proxy's `verdict`, `code` and reason, and is never retried; transport failures and 5xx answers are retried.
- **Verdict Events:** `client.on('kill' | 'reask' | 'hold', ...)` fires on a refusal, before `chat()` throws. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#_5-verdicts-and-errors) for every refusal code.
- **Anthropic requests:** `provider: 'anthropic'` translates OpenAI-style parameters to an Anthropic Messages body, sends it to the proxy's `/v1/messages` route, and translates the reply back.
- **Budget Check:** `checkBudget()` reports whether the workspace has budget left, from the control plane's `GET /api/v1/budget`.
- **Circuit Breaker:** `client.circuitBreaker(toolName, options)(fn)` runs `fn`, after a workspace budget check when `requireBudget` is set, failing closed unless `failOpen` is set.
- **Context Resolution:** `resolveContext()` reads the sync daemon's `~/.intutic/config.json` (git branch, Jira ticket, PagerDuty incident, CI pipeline, workspace, session), falling back to environment variables.
- **Control-Plane Management (`ControlPlaneClient`):** Org signup, team/workspace creation, gateway registration and assignment, and provider-credential provisioning — the CLI's management surface, callable programmatically. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).

## License

MIT
