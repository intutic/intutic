# @intutic/clawde

Programmatic client SDK for intercepting, wrapping, and enforcing policies on AI coding agent scripts.

## Installation

```bash
npm install @intutic/clawde
```

## Features

- **Context Resolution:** Automatically detects current Git branch, PR, CI variables, and parses sync-daemon configurations (`~/.intutic/config.json`).
- **Pre-flight Budget Gating:** Checks remaining session spend limits before calling LLM endpoints.
- **Circuit Breaker:** Wraps tasks with strict fallback parameters to isolate execution failures.
- **Schema Normalization:** Intercepts and translates Anthropic payloads to OpenAI structures.
- **Policy Callbacks:** Simple event subscriptions for policy execution events (e.g. `hijack`, `kill`).
- **Control-Plane Management (`ControlPlaneClient`):** Org signup, team/workspace creation, gateway registration and assignment, and provider-credential provisioning — the CLI's management surface, callable programmatically. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).

## License

MIT
