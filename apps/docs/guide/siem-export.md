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

Delivery is in-process (no Kafka or Debezium dependency): the control plane's own domain event emitter drives it directly, so a destination configured today starts receiving events on the very next matching action.

## Delivery guarantees

Each event is retried up to 5 times per destination with exponential backoff. An event that still fails after retries is written to a dead-letter queue and retried automatically every 15 minutes. The DLQ count and a manual **Retry now** control are both visible on the SIEM Export panel.

A destination that has been deactivated has its DLQ backlog dropped rather than retried forever — there's nowhere left to deliver it.

## Why this exists

SIEM export existed earlier in Intutic's history and was deliberately removed during a product-scope refocus onto the core enforcement engine — not because it was broken. It's back because packaged SIEM export turned out to be close to universal among comparable governance products, and Intutic customers running their own security tooling need their existing SIEM to be the place they can see Intutic's decisions too, not a second dashboard to check.
