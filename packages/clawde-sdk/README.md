# @intutic/clawde

Programmatic client SDK for intercepting, wrapping, and enforcing policies on AI coding agent scripts.

## Installation

```bash
npm install @intutic/clawde
```

## Features

- **Governed chat:** `chat()` sends a request through the proxy and resolves with `verdict: 'allow'`. A governance refusal (policy block, reask, loop run held for review, spend cap, DLP block) throws `ClawdeBlockedError` with the proxy's `verdict`, `code`, `ruleId` (when the proxy names the rule) and reason, and is never retried; transport failures and 5xx answers are retried.
- **Withheld tool calls:** when the proxy withholds a tool call from the model's answer (a tool an SOP denies, the SSO group policy, destructive SQL, sensitive output), the answer arrives as a 200 that names the refusal in the `x-intutic-refusal` and `x-intutic-refusal-rule` headers. `chat()` reads them and throws `ClawdeBlockedError` too. For a stream you read yourself, pass each line to `streamRefusal()`, which finds the `: intutic-refusal` marker the proxy writes before the refusal text. See [Verdicts and Errors](https://docs.intutic.ai/reference/clawde-sdk#_5-verdicts-and-errors) for every refusal code.
- **Verdict Events:** `client.on('kill' | 'reask' | 'hold', ...)` fires on a refusal, before `chat()` throws.
- **Anthropic requests:** `provider: 'anthropic'` translates OpenAI-style parameters to an Anthropic Messages body, sends it to the proxy's `/v1/messages` route, and translates the reply back.
- **Budget Check:** `checkBudget()` reports whether the workspace has budget left, from the control plane's `GET /api/v1/budget`.
- **Circuit Breaker:** `client.circuitBreaker(toolName, options)(fn)` runs `fn`, after a workspace budget check when `requireBudget` is set, failing closed unless `failOpen` is set.
- **Context Resolution:** `resolveContext()` reads the sync daemon's `~/.intutic/config.json` (git branch, Jira ticket, PagerDuty incident, CI pipeline, workspace, session), falling back to environment variables.
- **Git context (`autoContext`, on by default):** with an Intutic virtual key, in a git repository, the first `chat()` registers a session with the control plane carrying the repository (the `origin` remote as `host/path`, credentials removed), the branch and the HEAD commit, so the calls count in cost per branch, commit and pull request. Pass `autoContext: false` to send none of it. See [Git context and cost attribution](https://docs.intutic.ai/reference/clawde-sdk#_1a-git-context-and-cost-attribution).
- **Control-Plane Management (`ControlPlaneClient`):** org signup and creation, teams and workspaces, gateway registration, assignment and live config (`getGatewayConfig`, `setGatewayConfig`), workspace settings (`getWorkspaceSettings`, `updateWorkspaceSettings`) and provider credentials. See [Control-Plane Management](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).

## License

MIT
