# intutic-clawde

Python SDK for Intutic Agentic AI Governance proxy wrappers.

`ClawdeClient.chat()` sends a request through the Intutic proxy and returns the completion with `verdict` set to `"allow"`. A governance refusal (policy block, reask, loop run held for review, spend cap, DLP block) raises `ClawdeBlockedError` with the proxy's `verdict`, `code` and reason, fires the matching `kill` / `reask` / `hold` event, and is never retried; transport failures and 5xx answers are retried. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#_5-verdicts-and-errors) for every refusal code.

`ControlPlaneClient` covers the operator APIs the CLI exposes: org and workspace setup, gateways, settings and provider credentials, the MCP registry, notification rules, SIEM destinations, usage, the AI inventory, compliance evidence, policy guardrails, held decisions and loop runs, findings, traces, trace integrity, policies and SOPs, with the TypeScript SDK's methods in snake_case. `verify_evidence_archive()` checks a compliance evidence archive offline and `verify_integrity_root()` a sealed trace root's signature; both signature checks need `pip install 'intutic-clawde[compliance]'`. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).
