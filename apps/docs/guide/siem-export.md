# SIEM Export <Badge type="warning" text="Biz Org+" />

Stream governance events — execution traces, incidents, detector findings, plan decisions, device firewall enforcement, machine disconnects, sign-ins, settings and policy changes, MCP registry decisions, SCIM changes, held-decision reviews, secret rotations, evidence downloads, gate and integrity alerts, ungoverned AI tools found on a machine, and optionally every gate decision — to your own SIEM or warehouse, each naming the person behind it.

---

## Overview

Every governance decision Intutic makes already lands in Postgres and the dashboard. SIEM Export streams the same events out to infrastructure you already run: Splunk, Datadog, a generic webhook, syslog/CEF, or an S3/GCS bucket for cold storage. This is delivery, not a second source of truth — the row in your SIEM is a copy of what the dashboard already shows.

Six destination types are supported:

| Type | What it's for |
|---|---|
| Splunk (HEC) | HTTP Event Collector, NDJSON-per-line envelopes |
| Datadog Logs | Log Intake v2, gzip-compressed batches |
| Generic Webhook | JSON `POST` to any HTTPS endpoint, HMAC-signed, optional bearer/auth header |
| Syslog (CEF) | TCP/TLS, CEF-encoded for legacy SIEM ingestion |
| Amazon S3 | Buffered NDJSON micro-batches, one object per flush |
| Google Cloud Storage | Same buffering as S3 |

## Configuring a destination

From **Settings › Integrations › SIEM Export**, click **Add Destination**, choose a type, and provide its connection config as JSON. Each type's placeholder shows the fields it expects (a webhook URL, a Splunk HEC token, an S3 bucket + credentials, etc.).

Credentials are encrypted at rest and are never returned unmasked after creation: a read shows `********` and, for a value longer than eight characters, its last four. When you edit a destination's `config`, a credential you leave out, or send back exactly as it was masked, keeps its stored value; any other value replaces it. The one exception is a webhook destination's `signingSecret`: the control plane generates it, an edit always keeps it whatever `config` says, and only **New signing secret** (`POST /api/v1/siem/destinations/:id/signing-secret`) replaces it. Only OWNER/ADMIN roles can create, edit, or deactivate a destination. Any workspace member can view the destination list and its health status.

Use **Test** to run a synchronous health check against a destination without waiting for a real event.

From the CLI, `intutic siem list`, `show`, `sources`, `create`, `update`, `delete` and `rotate-secret` do the same. See [the CLI reference](/reference/cli#intutic-siem-list).

## Plans {#plans}

SIEM export comes with the Biz Org, Enterprise and Self-host plans and the trials. On another plan, creating, editing, testing and re-keying a destination answer `403` with `Upgrade required — SIEM export requires a Biz Org plan or higher`, and **Settings › Integrations › SIEM Export** says which plans include it.

A workspace that moves to a plan without SIEM export keeps its destinations, and they send nothing from that moment:

- Each active destination is listed as **Paused**. `GET /api/v1/siem/destinations` and `GET /api/v1/siem/destinations/:id` carry the reason in `pausedReason` (`null` while a destination streams).
- Events from that point are not delivered, and none are queued for later.
- The dead-letter queue is kept and not retried. It is delivered once the workspace is on a plan with SIEM export again.
- The control plane logs `SIEM export paused: the workspace plan does not include it`, at most once an hour per workspace.
- Owners and admins can still view, deactivate (`PUT` with only `{"isActive": false}`) and delete a destination.

Moving back to a plan with SIEM export resumes streaming to every destination still active.

## What gets streamed

Every event carries a `sourceTable` naming its source:

| Source | What it carries |
|---|---|
| `execution_traces` | Every completed trace, as it's recorded |
| `governance_incidents` | Every raised incident |
| `detector_findings` | Every finding from the proxy's anomaly detector pipeline, allowed or blocked |
| `stored_plans` | Plan approve, reject and close decisions |
| `enforcement_devices` | A device's firewall enforcement being disabled, and (emitter path only, see below) a device going stale |
| `login_events` | Every sign-in — password, SSO (OIDC or SAML), magic link, GitHub, Google, and the sign-up that signs a new owner in — and every refused sign-in that belongs to a workspace: a wrong password, a deactivated member, an SSO identity the workspace does not admit, an IdP response that fails verification. Each carries the method, `outcome` (`success` or `failure`), `failure_reason`, the member (or, when none was resolved, the email presented, which is cleared from the stored row if that person's data is erased), IP address and user agent. An attempt against an email no workspace knows is not recorded |
| `workspace_settings_changes` | Every workspace settings change: who made it, which keys changed, and the before and after values with secrets redacted. Policy guardrails that set the model allowlist or egress allow list appear here too |
| `sop_registry` | A guideline moving between lifecycle states (for example draft to validated, or validated to invalidated): which guideline, from and to, and who moved it |
| `governance_alerts` | The alerts the notification hub sends: a gate that stopped reporting, the same gate reporting again, a failed trace integrity check, and an ungoverned harness or MCP server first seen in a machine's [AI inventory](/guide/ai-inventory). `payload.alert_type` says which |
| `device_disconnects` | A machine that ran `intutic disconnect`: its hostname and fingerprint, the member whose credentials reported it, `scope` (`machine` for everything, `harness` for `--harness`) and the harnesses |
| `mcp_server_changes` | The [MCP server registry](/guide/mcp-governance#the-registry): an owner or admin approving, blocking or resetting a server (`action` `approved`, `blocked` or `candidate`, with `previous_status`), switching one of its tools (`tool_enabled`, `tool_disabled`, with `tool_name`), and every scored change to a server's tool set (`tools_changed`, with `risk_score`, `risk_level`, `risk_reasons`, the tools `added`, `removed` and `changed`, and `held` when the change returned the server to the approval queue). Every score is sent, low ones included; the notification hub hears only of high ones |
| `scim_changes` | Your identity provider writing through [SCIM](/guide/scim): `resource_type` (`User` or `Group`), `action` (`provisioned`, `updated` or `deprovisioned` for a user, including a PATCH or PUT that sets `active: false`; `created`, `updated` or `deleted` for a group), the resource id, the user's `user_name` and `active` or the group's `display_name` and member count, the PATCH operations by `op` and `path` (never their values), and the SCIM token that pushed it |
| `decision_reviews` | A [held decision](/guide/decisions#slack-interactive-reviews) approved or rejected, in Slack or with `intutic decision`: `status` (`APPROVED` or `REJECTED`), the reviewer, `via` (`API`, or the Slack account), the reviewer's reason, the decision summary, and whether a review-hold bypass was written |
| `secret_rotations` | A signing secret replaced: `target` (`notification_rule`, `siem_destination` or `github_webhook`), `target_id` (the rule's or destination's id; `null` for the GitHub webhook, which a workspace has one of), `target_name` (the destination's name for a SIEM destination, `null` otherwise), and who replaced it. Never the secret |
| `evidence_exports` | A compliance evidence download: `kind` (`soc2_archive`, `framework_report` or `human_oversight`), `format`, the framework, the evidence run, the period, whether it was signed, and who downloaded it |
| `credential_changes` | A credential created, rotated, updated, revoked or deleted: `credential_type` (`api_key`, `gateway_token`, `scim_token` or `provider_credential`), `credential_id` (the key, gateway or token id, or the provider), `label`, `action`, and who made the change (`actor_type` `system` for keys revoked when a member is offboarded). Never the credential |
| `gate_decisions` | **Opt-in.** Every verdict a hook gate records: allow, block, flag, would-block (shadow mode), hold and approved bypass, with the tool name, reason, rule, harness and session. Also `TAMPER`: a governance file (a gate, a hook registration, the policy snapshot or a VS Code hook setting) changed outside the sync daemon, which the daemon put back. Also every tool call the proxy's response gate withholds under the SSO group policy, as a block with source `proxy_response_gate`. The tool's input is not included |

### Who: the `actor` object {#the-actor}

Every payload with a person behind it carries `actor`, shaped like the [OCSF](https://schema.ocsf.io/) Actor object of the API Activity class (6003), beside the fields it always had:

```json
"actor": {
  "user": {
    "uid": "mbr_1a2b3c",
    "type": "User",
    "email_addr": "ana@example.com",
    "name": "Ana Ruiz",
    "groups": [{ "name": "platform" }, { "name": "sre" }],
    "credential_uid": "vk_3f9a"
  },
  "session": { "uid": "ses_7d1e" },
  "process": { "user": { "name": "ana" } }
}
```

- `actor.user` is the workspace member the control plane resolved from the authenticated key or session: their member id, email, display name and effective groups (their SCIM groups while SCIM provisioning is active, else the groups their last SSO sign-in carried). An id that is not a member of the workspace, such as `system:tool-risk` on a scored tool change, is `{ "uid": … }` alone.
- `actor.user.credential_uid`, `actor.session` and `actor.process` are what the reporting process said about itself: the API key prefix, the harness session and the OS user the MCP proxy or gate ran as. They are reported, not verified.

Which payloads carry it: `gate_decisions` and the `governance_incidents` filed from a gate's report (the caller of the call), `login_events`, `workspace_settings_changes`, `sop_registry`, `stored_plans`, `device_disconnects`, `mcp_server_changes`, `decision_reviews`, `secret_rotations`, `evidence_exports` and `credential_changes` (the member who acted). `scim_changes` names the SCIM token instead, because the identity provider made the change. Over syslog, the member is CEF's `suid` and `suser`. The Kafka/CDC path below delivers table rows as they are, without `actor`.

Only what a SIEM needs to tie an event to your identity provider leaves: the member id, email, name and groups. An event held in the dead-letter queue is cleared of a person's identifiers when their data is erased, like the rest of the workspace's records.

Delivery is in-process by default (no Kafka or Debezium dependency by default): the control plane's own domain event emitter drives it directly, so a destination configured today starts receiving events on the very next matching action. An optional Kafka/Debezium CDC ingestion path is also available — see "Delivery guarantees" below.

### Choosing sources

A destination's `sourceTables` list selects what it receives. Leave it empty, as **Add Destination** does by default, to receive every source except `gate_decisions`; new low-volume sources reach such a destination as they are added. A non-empty list is exact: the destination receives those sources and nothing else. An unknown name is refused when you save, and `GET /api/v1/siem/destinations` returns the valid names (`sources.all`) and the default set (`sources.defaults`).

To change an existing destination's sources, click **Sources** on its row: tick the sources it should receive and **Save sources**. Ticking exactly the default set saves an empty list, so the destination stays on the defaults and keeps receiving new sources as they are added. The **Sources** column says `Defaults` or how many it receives. Owners and admins see the button on an active destination, on a plan with SIEM export; it sends `PUT /api/v1/siem/destinations/:id` with `sourceTables`.

Gate decisions are opt-in because there is one per tool call, allows included. Tick **Also stream gate decisions** when adding a destination, or send a `sourceTables` list that includes `gate_decisions`. Either way the destination gets an exact list (the box saves the current default set plus `gate_decisions`), so sources added later do not reach it until you add them under **Sources**:

```bash
curl -X PUT https://<control-plane>/api/v1/siem/destinations/<id> \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sourceTables": ["governance_incidents", "detector_findings", "login_events", "workspace_settings_changes", "governance_alerts", "gate_decisions"]}'
```

Hook gates report in batches, and each batch goes to a destination as one delivery: one webhook request, one Splunk or Datadog request, or one batch for a bucket. Decisions from SDK gates that ask the control plane per call (`POST /api/v1/hook-gate`) are delivered one at a time. Decisions made in the proxy, rather than in a hook gate, already stream as `detector_findings` and `governance_incidents`.

### Syslog (CEF) classes

Each source has its own CEF event class, so a SIEM rule can match on it:

| Source | Event class | Severity |
|---|---|---|
| `gate_decisions` | `GATE_<VERDICT>`, for example `GATE_BLOCK` | 7 for a block or a tamper, 6 for an approved bypass, 5 for a hold or would-block, 4 for a flag, 1 for an allow |
| `login_events` | `AUTH_LOGIN`, or `AUTH_LOGIN_FAILURE` for a refused sign-in | 3, and 5 for a refusal |
| `workspace_settings_changes` | `SETTINGS_CHANGE` | 5 |
| `sop_registry` | `POLICY_CHANGE_UPDATE` | 4 |
| `governance_alerts` | `GATE_SILENT`, `GATE_RECOVERED`, `INTEGRITY_FAILURE` or `UNGOVERNED_AI_TOOL` | 7, 1, 10 and 5 |
| `device_disconnects` | `DEVICE_DISCONNECT` | 4 |
| `mcp_server_changes` | `MCP_SERVER_APPROVED`, `MCP_SERVER_BLOCKED`, `MCP_SERVER_RESET`, `MCP_TOOL_ENABLED`, `MCP_TOOL_DISABLED` or `MCP_TOOLS_CHANGED` | 3, 5, 3, 3, 4; a tool-set change 7, 5 or 3 for a high, medium or low score |
| `scim_changes` | `SCIM_USER_<ACTION>` or `SCIM_GROUP_<ACTION>`, for example `SCIM_USER_DEPROVISIONED` | 5 for a deprovisioning or deletion, 3 otherwise |
| `decision_reviews` | `DECISION_APPROVED` or `DECISION_REJECTED` | 5 and 3 |
| `secret_rotations` | `SECRET_ROTATED` | 5 |
| `evidence_exports` | `EVIDENCE_EXPORT` | 4 |
| `credential_changes` | `CREDENTIAL_CHANGE` | 5 |

Every class carries the member as `suid` (member id) and `suser` (email) when the event has an [actor](#the-actor).

### Bucket batching

S3 and GCS destinations hold events until the destination's `batchSize` events are waiting or `flushIntervalMs` has passed since the first (defaults 100 and 60 seconds), then write them as one NDJSON object. A batch that cannot be written goes to the dead-letter queue whole. Held events are written when the control plane shuts down cleanly; a crash loses them, like any other in-flight event on the emitter path.

## Verifying webhook signatures

Every webhook destination gets a signing secret when it is created. The create response is the only place it appears in full; copy it then. **New signing secret** on the destination's row (or `POST /api/v1/siem/destinations/:id/signing-secret`) replaces it and shows the new one once; deliveries switch to the new secret straight away. Every delivery is signed; there is no unsigned option.

Each request carries two headers:

- `X-Intutic-Timestamp` — the send time, in Unix seconds
- `X-Intutic-Signature` — `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw request body>`, keyed with the signing secret

[Notification webhooks](/guide/settings#verifying-webhook-signatures) are signed exactly the same way, so one function verifies both. The signature covers the timestamp, so a receiver can refuse a delivery that was captured and replayed later. To verify:

1. Read the raw body exactly as received, before any JSON parsing.
2. Compute the HMAC over the timestamp header, a `.`, and the raw body, and compare it with the signature header in constant time.
3. Refuse the request if the timestamp is older than five minutes (or more than five minutes ahead of your clock). A retried delivery is signed again when it is sent, so retries carry a fresh timestamp.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyIntuticWebhook(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const timestamp = headers['x-intutic-timestamp']
  const signature = headers['x-intutic-signature'] ?? ''
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
```

```python
import hashlib, hmac, time

def verify_intutic_webhook(raw_body: bytes, headers: dict, secret: str) -> bool:
    timestamp = headers.get("x-intutic-timestamp", "")
    signature = headers.get("x-intutic-signature", "")
    if not timestamp or abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, "sha256=" + mac)
```

## Delivery guarantees

Every event, from either path, is retried up to 5 times per destination with exponential backoff. An event that still fails after retries is written to a dead-letter queue and retried automatically every 15 minutes. The DLQ count and a manual **Retry now** control are both visible on the SIEM Export panel; **Retry now** (`POST /api/v1/siem/dlq/retry`, owners and admins) retries your workspace's queue only. A destination that has been deactivated has its DLQ backlog dropped rather than retried forever — there's nowhere left to deliver it. Both paths share this exact retry + DLQ mechanism and the same dedup-key shape family for event ids.

### Emitter path (default)

- **At-most-once, per replica.** Each running control-plane replica processes its own copy of the in-process event emitter — if you run more than one replica, each one dispatches the same event independently, so you get **duplicate delivery** at your SIEM, not exactly-once. This is a real, plain limitation, not a hedge.
- **No replay.** There is no offset or log to go back to — once an event is emitted, that's the only chance it has to be delivered (retries within that one attempt aside).
- **In-flight events are lost on process restart.** An event mid-dispatch when the control plane restarts (deploy, crash, scale-down) is simply gone; nothing re-sends it afterward.

### Kafka/CDC path (optional)

- **WAL-sourced, at-least-once.** Events come from Postgres's write-ahead log via Debezium, not from application code remembering to emit — this closes the gap where an application code path writes a row but forgets (or fails) to emit an event. It is a genuine superset of what the emitter path can ever produce: some database writes never had a corresponding emitter call at all, and CDC sees them regardless.
- **Replayable by consumer offset.** A consumer group can be rewound and replayed from any retained offset — recovering from a bad destination config or a downstream outage doesn't require the source events to still be "live" anywhere else.
- **Survives control-plane restarts.** Nothing is held in process memory between the WAL and the consumer; a restart just resumes from the last committed offset.
- **Safe with multiple replicas.** Kafka consumer-group semantics partition work across replicas without duplicate delivery — the multi-replica caveat above does not apply here.
- **The original five sources only.** CDC carries `execution_traces`, `governance_incidents`, `detector_findings`, `stored_plans` and `enforcement_devices`. Every other source in the table above is delivered by the emitter path whether or not Kafka is on.
- **Same dedup key family, same DLQ.** Event ids are deterministic from Kafka delivery coordinates (`siemev_cdc_<topic>_<partition>_<offset>`), so redelivery reproduces the same id; failures land in the identical DLQ the emitter path uses.

**Setup:** the Kafka/CDC path is opt-in and requires an operator-run Kafka broker, Kafka Connect, and Debezium connector (this product does not deploy any of those three) — see `infra/kubernetes/cdc/README.md` in the enterprise repo for the full runbook, including the required `REPLICA IDENTITY FULL` change on two tables and every `KAFKA_*` environment variable the control plane reads.

## Why this exists

SIEM export existed earlier in Intutic's history and was deliberately removed during a product-scope refocus onto the core enforcement engine — not because it was broken. It's back because packaged SIEM export turned out to be close to universal among comparable governance products, and Intutic customers running their own security tooling need their existing SIEM to be the place they can see Intutic's decisions too, not a second dashboard to check.
