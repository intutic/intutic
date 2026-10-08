# intutic-clawde

Python SDK for Intutic Agentic AI Governance proxy wrappers.

`ClawdeClient.chat()` sends a request through the Intutic proxy and returns the completion with `verdict` set to `"allow"`. A governance refusal (policy block, reask, loop run held for review, spend cap, DLP block) raises `ClawdeBlockedError` with the proxy's `verdict`, `code` and reason, fires the matching `kill` / `reask` / `hold` event, and is never retried; transport failures and 5xx answers are retried. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#_5-verdicts-and-errors) for every refusal code.

`ControlPlaneClient` additionally covers control-plane management (org signup, teams/workspaces, gateway registration and assignment, provider credentials) — see the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).
