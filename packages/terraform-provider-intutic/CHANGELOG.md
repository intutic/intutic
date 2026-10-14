## 0.2.1 (Unreleased)

ENHANCEMENTS:

* resource/intutic_virtual_key: `scopes` is validated against the control plane's scope registry (`*`, `gateway:use`, and `<area>:read` / `<area>:write` for each REST area) at plan time, and its description says what each kind grants. The control plane now enforces scopes: a request with a key needs both its owner's role and a scope covering the route, and LLM traffic through the proxy needs `gateway:use`. A key with the default `["*"]` is unaffected. A configuration naming a scope outside the registry, which the API used to store and ignore, now fails at plan time.

BUG FIXES:

* resource/intutic_notification_rule: `filter_severity` is validated against the severities events carry (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`), in any case. Lowercase values, as the example used to show, were stored as written and matched no event, so the rule never fired; the control plane now stores them uppercase and has uppercased existing rules. A configured list that differs from the stored one only in case plans no change. A value that is not a severity now fails at plan time.

## 0.2.0 (October 13, 2026)

BREAKING CHANGES:

* resource/intutic_notification_rule: `event_type` no longer accepts `ssl.enforcement.violation`, `context_gap.auto_injected` or `adapter.write_back.failed`. Nothing ever sent these events, so a rule on one could never deliver; the API refuses new rules on them and the control plane deletes existing ones. Remove such rules from your configuration before upgrading, or the plan fails validation.

NOTES:

* resource/intutic_policy: the `intervention_mode` description says what each mode does: `TRANSPARENT` names the rule, `OPAQUE` refuses the same calls with a generic sentence while audit records keep the rule, and `SILENT_LOG` applies to the local hook gates only. The schema is unchanged.

## 0.1.0 (October 11, 2026)

FEATURES:

* **New Resources:** `intutic_sop`, `intutic_policy`, `intutic_guardrail`, `intutic_workspace_settings`, `intutic_virtual_key`, `intutic_gateway`, `intutic_notification_rule`, `intutic_siem_destination`, `intutic_wasm_rule`, `intutic_provider_credential`, `intutic_mcp_server_decision`, `intutic_workspace_budget`, `intutic_member_budget`
* **New Data Sources:** `intutic_workspace`, `intutic_members`
