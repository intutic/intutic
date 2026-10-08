# @intutic/clawde

Programmatic client SDK for intercepting, wrapping, and enforcing policies on AI coding agent scripts.

## Installation

```bash
npm install @intutic/clawde
```

## Features

- **Context Resolution:** Reads the sync daemon's `~/.intutic/config.json` (git branch, Jira ticket, PagerDuty incident, CI pipeline, workspace, session), falling back to environment variables, and sends it with each `chat()` call.
- **Budget Check:** `checkBudget()` reports whether the workspace has budget left, from the control plane's `GET /api/v1/budget`.
- **Circuit Breaker:** `client.circuitBreaker(toolName, options)(fn)` runs `fn` behind an optional budget pre-check, failing closed unless `failOpen` is set.
- **Schema Normalization:** Translates OpenAI-style parameters to an Anthropic Messages body and back.
- **Verdict Events:** `client.on('hijack' | 'enhance' | 'kill' | 'bypass', ...)` for verdicts reported in response headers. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#_5-verdicts-and-errors) for how the proxy reports refusals today.
- **Control-Plane Management (`ControlPlaneClient`):** Org signup, team/workspace creation, gateway registration and assignment, and provider-credential provisioning — the CLI's management surface, callable programmatically. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).

## License

MIT
