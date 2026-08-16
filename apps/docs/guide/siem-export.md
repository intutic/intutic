# SIEM Export <Badge type="danger" text="Enterprise" />

Stream governance events — execution traces, incidents, detector findings, and plan lifecycle decisions — to your own SIEM or warehouse.

---

## Overview

Every governance decision Intutic makes already lands in Postgres and the dashboard. SIEM Export streams the same events out to infrastructure you already run: Splunk, Datadog, a generic webhook, syslog/CEF, or an S3/GCS bucket for cold storage. This is delivery, not a second source of truth — the row in your SIEM is a copy of what the dashboard already shows.

Six destination types are supported:

| Type | What it's for |
|---|---|
| Splunk (HEC) | HTTP Event Collector, NDJSON-per-line envelopes |
| Datadog Logs | Log Intake v2, gzip-compressed batches |
| Generic Webhook | JSON `POST` to any HTTPS endpoint, optional bearer/auth header |
| Syslog (CEF) | TCP/TLS, CEF-encoded for legacy SIEM ingestion |
| Amazon S3 | Buffered NDJSON micro-batches, one object per flush |
| Google Cloud Storage | Same buffering as S3 |

## Configuring a destination

From **Settings → Security → SIEM Export**, click **Add Destination**, choose a type, and provide its connection config as JSON. Each type's placeholder shows the fields it expects (a webhook URL, a Splunk HEC token, an S3 bucket + credentials, etc.).

Credentials are encrypted at rest and are never returned unmasked after creation — only OWNER/ADMIN roles can create, edit, or deactivate a destination. Any workspace member can view the destination list and its health status.

Use **Test** to run a synchronous health check against a destination without waiting for a real event.

## What gets streamed

- `execution_traces` — every completed trace, as it's recorded
- `governance_incidents` — every raised incident
- `detector_findings` — every finding from the proxy's anomaly detector pipeline
- `stored_plans` — plan approve/reject/close decisions
- `enforcement_devices` — a device's firewall enforcement being disabled, and (emitter path only, see below) a device going stale

Delivery is in-process by default (no Kafka or Debezium dependency by default): the control plane's own domain event emitter drives it directly, so a destination configured today starts receiving events on the very next matching action. An optional Kafka/Debezium CDC ingestion path is also available — see "Delivery guarantees" below.

## Delivery guarantees

Every event, from either path, is retried up to 5 times per destination with exponential backoff. An event that still fails after retries is written to a dead-letter queue and retried automatically every 15 minutes. The DLQ count and a manual **Retry now** control are both visible on the SIEM Export panel. A destination that has been deactivated has its DLQ backlog dropped rather than retried forever — there's nowhere left to deliver it. Both paths share this exact retry + DLQ mechanism and the same dedup-key shape family for event ids.

### Emitter path (default)

- **At-most-once, per replica.** Each running control-plane replica processes its own copy of the in-process event emitter — if you run more than one replica, each one dispatches the same event independently, so you get **duplicate delivery** at your SIEM, not exactly-once. This is a real, plain limitation, not a hedge.
- **No replay.** There is no offset or log to go back to — once an event is emitted, that's the only chance it has to be delivered (retries within that one attempt aside).
- **In-flight events are lost on process restart.** An event mid-dispatch when the control plane restarts (deploy, crash, scale-down) is simply gone; nothing re-sends it afterward.

### Kafka/CDC path (optional)

- **WAL-sourced, at-least-once.** Events come from Postgres's write-ahead log via Debezium, not from application code remembering to emit — this closes the gap where an application code path writes a row but forgets (or fails) to emit an event. It is a genuine superset of what the emitter path can ever produce: some database writes never had a corresponding emitter call at all, and CDC sees them regardless.
- **Replayable by consumer offset.** A consumer group can be rewound and replayed from any retained offset — recovering from a bad destination config or a downstream outage doesn't require the source events to still be "live" anywhere else.
- **Survives control-plane restarts.** Nothing is held in process memory between the WAL and the consumer; a restart just resumes from the last committed offset.
- **Safe with multiple replicas.** Kafka consumer-group semantics partition work across replicas without duplicate delivery — the multi-replica caveat above does not apply here.
- **Same dedup key family, same DLQ.** Event ids are deterministic from Kafka delivery coordinates (`siemev_cdc_<topic>_<partition>_<offset>`), so redelivery reproduces the same id; failures land in the identical DLQ the emitter path uses.

**Setup:** the Kafka/CDC path is opt-in and requires an operator-run Kafka broker, Kafka Connect, and Debezium connector (this product does not deploy any of those three) — see `infra/kubernetes/cdc/README.md` in the enterprise repo for the full runbook, including the required `REPLICA IDENTITY FULL` change on two tables and every `KAFKA_*` environment variable the control plane reads.

## Why this exists

SIEM export existed earlier in Intutic's history and was deliberately removed during a product-scope refocus onto the core enforcement engine — not because it was broken. It's back because packaged SIEM export turned out to be close to universal among comparable governance products, and Intutic customers running their own security tooling need their existing SIEM to be the place they can see Intutic's decisions too, not a second dashboard to check.
