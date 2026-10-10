# intutic-clawde

Python SDK for Intutic Agentic AI Governance proxy wrappers.

`ClawdeClient.chat()` sends a request through the Intutic proxy and returns the completion with `verdict` set to `"allow"`. A governance refusal (policy block, reask, loop run held for review, spend cap, DLP block) raises `ClawdeBlockedError` with the proxy's `verdict`, `code`, `rule_id` (when the proxy names the rule) and reason, fires the matching `kill` / `reask` / `hold` event, and is never retried; transport failures and 5xx answers are retried. See [Verdicts and Errors](https://docs.intutic.ai/reference/clawde-sdk#_5-verdicts-and-errors) for every refusal code.

When the proxy withholds a tool call from the model's answer (a tool an SOP denies, the SSO group policy, destructive SQL, sensitive output), the answer arrives as a 200 that names the refusal in the `x-intutic-refusal` and `x-intutic-refusal-rule` headers; `chat()` raises `ClawdeBlockedError` for it too. For a stream you read yourself, pass each line to `stream_refusal()`.

With an Intutic virtual key, in a git repository, the first `chat()` registers a session with the control plane carrying the repository (the `origin` remote as `host/path`, credentials removed), the branch and the HEAD commit, so the calls count in cost per branch, commit and pull request. This is on by default; pass `auto_context=False` to send none of it. See [Git context and cost attribution](https://docs.intutic.ai/reference/clawde-sdk#_1a-git-context-and-cost-attribution).

`ControlPlaneClient` covers the operator APIs the CLI exposes: org and workspace setup, gateways, settings and provider credentials, the MCP registry, notification rules, SIEM destinations, usage, the AI inventory, compliance evidence, policy guardrails, held decisions and loop runs, findings, traces, trace integrity, policies and SOPs, with the TypeScript SDK's methods in snake_case. `verify_evidence_archive()` checks a compliance evidence archive offline and `verify_integrity_root()` a sealed trace root's signature; both signature checks need `pip install 'intutic-clawde[compliance]'`. See the [SDK reference](https://docs.intutic.ai/reference/clawde-sdk#control-plane-management-controlplaneclient).

The `intutic_clawde.gate` subpackage is the pre-execution tool gate for Python agent frameworks; see the [Gate SDK reference](https://docs.intutic.ai/reference/gate-sdk).
