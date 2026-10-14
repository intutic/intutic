## 0.3.0 (Unreleased)

BREAKING CHANGES:

* resource/intutic_workspace_settings: `featureFlags.ff_metaclaw_auto_apply` is no longer accepted; the plan fails validation naming it, and the API refuses it. The control plane removed the flag and carried each workspace's value over to the SOP Optimizer's Approval mode, which is now the only switch for its auto-apply. Remove the flag from your configuration before upgrading.
ENHANCEMENTS:

* resource/intutic_virtual_key: `scopes` is validated against the control plane's scope registry (`*`, `gateway:use`, and `<area>:read` / `<area>:write` for each REST area) at plan time, and its description says what each kind grants. The control plane now enforces scopes: a request with a key needs both its owner's role and a scope covering the route, and LLM traffic through the proxy needs `gateway:use`. A key with the default `["*"]` is unaffected. A configuration naming a scope outside the registry, which the API used to store and ignore, now fails at plan time.

DEPRECATIONS:

* resource/intutic_policy: deprecated. The policies API is deprecated as of control-plane 2.5.1 and sunsets on 2026-12-01; its responses carry `Deprecation` and `Sunset` headers, and `terraform plan` warns on every `intutic_policy`. Write per-tool rules as `intutic_guardrail` with `kind = "hook_rule"` (`tools`, `arg_contains`, `arg_not_contains`), which the harness gates enforce once the guardrail is promoted through review, and set the intervention mode with the `interventionMode` key of `intutic_workspace_settings`. `intutic policy convert <id>` turns an active `KILL` or `REASK` policy into a `hook_rule` guardrail in `SHADOW`.
* resource/intutic_policy: `target_tool_pattern`, `enforcement_action`, `conditions` and `risk_category` are deprecated. No gate or proxy reads them, so a policy blocks no tool call; the resource description no longer says the proxy acts on matching calls.
* resource/intutic_policy: `priority` and `intervention_mode` are deprecated. A policy's only effect is that the active one with the lowest `priority` sets the workspace's intervention mode. The `interventionMode` workspace setting replaces this and wins once set; a workspace that has not set it falls back to the policy until control-plane 2.6.0. The control plane copies each workspace's current mode into the setting, so nothing changes on upgrade.

ENHANCEMENTS:

* resource/intutic_policy: `target_tool_pattern` and `enforcement_action` are optional, defaulting to `*` and `BYPASS` (the API still requires both; neither has any effect). Removing either from a configuration plans an update to the default; convert a `KILL` or `REASK` policy first, since conversion reads them.
* resource/intutic_workspace_settings: accepts the `interventionMode` key (`TRANSPARENT`, `OPAQUE` or `SILENT_LOG`), the workspace's intervention mode.

ENHANCEMENTS:

* resource/intutic_workspace_settings: accepts `storeToolArguments`, the opt-in for keeping tool-call argument values (redacted) in the replay contexts the proxy samples onto traces. Off by default.

BUG FIXES:

* resource/intutic_notification_rule: `filter_severity` is validated against the severities events carry (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`), in any case. Lowercase values, as the example used to show, were stored as written and matched no event, so the rule never fired; the control plane now stores them uppercase and has uppercased existing rules. A configured list that differs from the stored one only in case plans no change. A value that is not a severity now fails at plan time.
* resource/intutic_mcp_server_decision: an imported decision whose configuration leaves `disabled_tools` unset plans clean. Import used to record the server's tool switches as managed, so the first plan showed an in-place update removing them. `disabled_tools` now always shows the tools switched off on the server; unset still leaves the switches alone. Destroy re-enables the tools the configuration switched off, as before, but not tools switched off before an import.
* resource/intutic_workspace_budget: importing an id other than the provider key's workspace fails with "Wrong workspace", as `intutic_workspace_settings` does. It used to succeed and manage the key's workspace under the wrong id.
* resource/intutic_workspace_settings, resource/intutic_workspace_budget: applying both in one run no longer fails with "Provider produced inconsistent result after apply". The control plane wrote the two changes to the same settings record at once and kept only one; it now applies them one after the other.
* provider: an API refusal shows its explanation. A 403 names the roles the route allows in `detail`, which the provider did not read, so a missing role showed as a bare `Forbidden`.

NOTES:

* resource/intutic_member_budget: the example and import command use a real member id shape, `mbr_…`; they showed `mem_…`, which no member has.

NOTES:

* resource/intutic_sop: editing a SOP past `DRAFT` no longer retires the version you edited. The API keeps that version enforcing until the new `DRAFT` version is promoted to `VALIDATED`; the resource tracks the new version as before. The schema is unchanged.

## 0.2.0 (October 13, 2026)

BREAKING CHANGES:

* resource/intutic_notification_rule: `event_type` no longer accepts `ssl.enforcement.violation`, `context_gap.auto_injected` or `adapter.write_back.failed`. Nothing ever sent these events, so a rule on one could never deliver; the API refuses new rules on them and the control plane deletes existing ones. Remove such rules from your configuration before upgrading, or the plan fails validation.

NOTES:

* resource/intutic_policy: the `intervention_mode` description says what each mode does: `TRANSPARENT` names the rule, `OPAQUE` refuses the same calls with a generic sentence while audit records keep the rule, and `SILENT_LOG` applies to the local hook gates only. The schema is unchanged.

## 0.1.0 (October 11, 2026)

FEATURES:

* **New Resources:** `intutic_sop`, `intutic_policy`, `intutic_guardrail`, `intutic_workspace_settings`, `intutic_virtual_key`, `intutic_gateway`, `intutic_notification_rule`, `intutic_siem_destination`, `intutic_wasm_rule`, `intutic_provider_credential`, `intutic_mcp_server_decision`, `intutic_workspace_budget`, `intutic_member_budget`
* **New Data Sources:** `intutic_workspace`, `intutic_members`
