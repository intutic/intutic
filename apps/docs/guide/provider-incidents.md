# Provider Downtime & SLA Evidence <Badge type="warning" text="Cloud / Team" />

When an upstream model provider has an outage, Intutic records it as a **provider incident** and
lets admins export a signed evidence archive documenting how it affected your workspace. This
page covers how incidents are detected, how to read the dashboard panel, how to export evidence,
and how to use that evidence honestly with a provider.

---

## What counts as a provider incident

An incident is not raised from a single failed request. The proxy records a provider 5xx response
or an unservable-model rejection as an honest `upstream_error` trace; the control plane coalesces
those traces into open/resolved **incident windows** per provider. A `provider_incidents` row
tracks:

- The provider name and the incident's open/resolved window
- Failure counts broken down by kind and by HTTP status
- A bounded sample of the trace IDs that contributed to it

Provider incidents are deliberately **not scoped to a single workspace** — a provider outage is a
fact about the provider, shared by every tenant routing through it during that window, not a
per-tenant event. Because of that, resolving "did this incident affect *my* workspace" requires a
two-hop join: an incident's sampled trace IDs are resolved through `execution_traces` to
`agent_sessions.workspace_id` (traces carry no direct workspace column of their own). An incident
appears in your workspace's view only if at least one of its sampled trace IDs resolves back to
you.

## The dashboard panel

The **Provider Incidents** panel (`ProviderIncidentsPanel` in the dashboard) lists open incidents,
plus incidents resolved within the last 14 days, that affected your workspace. Each card shows:

- Provider name and status (`OPEN` / `RESOLVED`)
- When the incident window opened, and closed if applicable
- Total failed calls **across all affected workspaces** (not just yours) — the incident's
  provider-wide counters, reused as-is
- How many of the incident's sampled traces belong to your own workspace

The panel carries its own visible disclaimer: this is evidence of *observed* provider failures,
not a contractual SLA-breach determination.

## Exporting SLA evidence

Workspace **Owners** and **Admins** see an **Export SLA evidence** button. Clicking it calls
`POST /api/v1/provider-incidents/sla-evidence` (`requireSlaAdmin`-gated — `OWNER`/`ADMIN` only),
which builds, hashes, signs, and stores a fresh archive, then immediately downloads the signed
result via `GET /api/v1/provider-incidents/sla-evidence/:runId` (also `requireSlaAdmin`-gated).

By default the export covers the trailing 90 days; a specific `periodStart`/`periodEnd` and a
single `provider` filter can be requested via the same route's request body.

### What's inside the bundle

The exported archive (`SlaEvidenceArchive`) contains:

| Field | Contents |
|---|---|
| `disclaimer` | The honesty preamble below, shipped verbatim on every archive |
| `incidents[]` | One entry per incident affecting your workspace, in the requested period |
| `incidents[].failureCountByKind` / `failureCountByStatus` | Provider-wide failure counters (not re-scoped to you — see below) |
| `incidents[].workspaceSampleTraceIds` | Sample trace IDs **filtered to your own workspace's traces only**, capped at a fixed sample size |
| `incidents[].costImpact` | Provider-wide estimated cost impact of the incident |
| `manifest` | Per-incident SHA-256 section hashes plus a whole-archive SHA-256 |
| `signature` | A detached signature over the archive hash, minted under a dedicated `intutic-sla-evidence-v1` signing domain — distinct from the SOC 2 evidence signing domain, so a signature for one evidence type can never be presented as covering the other |

Two things are true about scope at once, and the archive is careful to keep them separate:

- The **trace IDs** inside your export are filtered down to your workspace's own traces before
  capping — your export never leaks another tenant's trace ID.
- The **failure counts and cost-impact figures** are the incident's own platform-wide counters,
  *not* re-derived per workspace. This system has no way to say "of these 500 failed calls,
  exactly N were yours" beyond the sampled trace evidence — the counts describe the shared outage
  window, confirmed to have touched you.

### The disclaimer is load-bearing

Every archive carries this text verbatim in its `disclaimer` field:

> "This document is evidence of observed provider failures (time windows, failure counts, and
> estimated cost impact) as recorded by this system. It is NOT a contractual SLA-breach
> determination — SLA terms vary by contract and this report does not interpret or apply them."

A signed, hashed, cryptographically-attested document about provider failures invites being read
as "Intutic confirms your SLA was breached." It does not confirm that. SLA terms are contractual
and specific to your agreement with the provider; this system has no model of any particular
contract's terms.

## Using the evidence in an SLA credit claim

The archive is built to be handed to a provider (or your own procurement/legal team) as supporting
evidence, not as a self-contained breach determination:

1. Export the archive for the period covering the outage you're claiming against.
2. The archive's `manifest.archiveSha256` and `signature` let a third party verify the document
   hasn't been altered since Intutic generated it.
3. Present the incident windows, failure counts, and your workspace's own affected trace samples
   as the observed-failure record — then apply your actual contract's SLA terms yourself (or with
   the provider) to determine whether a credit is owed and how much.

## Honesty note: what this evidence actually reflects

This evidence is built entirely from traffic observed through **your own gateway** — the requests
your workspace actually sent and the failures your workspace actually received. It is not, and
cannot be, the provider's global incident status. A provider may have a wider outage that never
touched your traffic pattern, or your workspace's specific errors may stem from something other
than a genuine provider-wide event. Treat this as your honest, first-party record of what you
observed — the strongest evidence you personally hold — not as an independent confirmation of the
provider's own status page.

## Related

- [Budgets & FinOps](/guide/budgets) — cost-impact accounting for normal (non-incident) usage
- [Compliance Evidence](/guide/compliance-evidence) — the SOC 2 evidence archives this feature's
  signing and storage pattern is modeled on
