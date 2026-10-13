## 0.2.0 (October 13, 2026)

BREAKING CHANGES:

* resource/intutic_notification_rule: `event_type` no longer accepts `ssl.enforcement.violation`, `context_gap.auto_injected` or `adapter.write_back.failed`. Nothing ever sent these events, so a rule on one could never deliver; the API refuses new rules on them and the control plane deletes existing ones. Remove such rules from your configuration before upgrading, or the plan fails validation.

NOTES:

* resource/intutic_policy: the `intervention_mode` description says what each mode does: `TRANSPARENT` names the rule, `OPAQUE` refuses the same calls with a generic sentence while audit records keep the rule, and `SILENT_LOG` applies to the local hook gates only. The schema is unchanged.

## 0.1.0 (October 11, 2026)

FEATURES:

* **New Resources:** `intutic_sop`, `intutic_policy`, `intutic_guardrail`, `intutic_workspace_settings`, `intutic_virtual_key`, `intutic_gateway`, `intutic_notification_rule`, `intutic_siem_destination`, `intutic_wasm_rule`, `intutic_provider_credential`, `intutic_mcp_server_decision`, `intutic_workspace_budget`, `intutic_member_budget`
* **New Data Sources:** `intutic_workspace`, `intutic_members`
