# Managed Gateway Cells <Badge type="warning" text="Cloud / Team" />

A **managed cell** is a dedicated Intutic gateway that the platform deploys and operates on
behalf of one org — as opposed to the shared platform gateway everyone else rides, or a
self-hosted gateway you register and run yourself. This page covers the cell model, the capacity
UI, and the deprovision policy that reclaims cells when an org no longer qualifies for them.

For how a cell gets created in the first place, see [Organizations, Teams & Billing](/guide/organizations#creating-an-org) —
creating a real org auto-provisions its first managed cell as part of org creation. This page
picks up from there: capacity limits, and what happens when a cell has to go away.

---

## The cell model

Each managed cell is a `gateways` row with `deploymentTarget = 'managed_cell'`, deployed at
`<org-slug>.gateway.intutic.ai` (or `<org-slug>.<region>.gateway.intutic.ai` outside the default
region). A few things distinguish a managed cell from every other gateway type:

- **The platform holds the credentials.** A managed cell's row is inserted with a random,
  immediately-discarded token — the real token is minted only when the cell provisioner writes it
  into the cell's Kubernetes Secret. You never see or handle a managed-cell token; there's nothing
  to install, register, or rotate manually.
- **Registration and provisioning are separate steps.** A cell row starts `pending` (shown as
  "Provisioning" in the dashboard) the moment an org is created. It goes live once the cell
  provisioner reconciler actually deploys it and the first heartbeat arrives, flipping its status
  to `online`.
- **Personal orgs never get one.** Only real orgs (created via `intutic org create` or the
  dashboard's "Create Organization" flow) get a managed cell — freemium/personal workspaces stay
  on the shared platform gateway.
- **One org can hold more than one cell**, one per region, up to its plan's ceiling — see
  Capacity below.

## Capacity: how many cells an org can hold

Every plan tier defines a `maxCellsPerOrg` ceiling. The dashboard's **Gateways** settings panel
shows your current usage directly:

> Using **N** of **M** managed cells

Capacity is enforced at cell-registration time: `assertCellCapacity` counts the org's currently
active cells (`deploymentTarget = 'managed_cell' AND revokedAt IS NULL`) and refuses to register
a new one once the org is at its ceiling, with a 403 pointing at the plan upgrade needed to add
more. When an org is at or over its limit, the panel surfaces an inline **"Managed cell limit
reached"** banner with a direct upgrade call-to-action rather than a generic error.

A second guard, `assertRegionAvailable`, prevents two *active* cells for the same org landing in
the same region — you'd need to revoke the existing regional cell first, or pick a different
region.

## The deprovision policy engine

Registration-time capacity enforcement only ever stopped a *new* cell from being added past the
ceiling — it said nothing about cells an org already held when its plan tier later changed. A
downgrade used to leave an org over capacity indefinitely, with no mechanism to bring it back into
compliance short of a human manually revoking cells. The deprovision engine
(`cellDeprovisionService.ts`) closes that gap.

### How reconciliation runs

`scheduleCellReconciliation` is called, unconditionally, after **every** plan-tier write in the
billing service — upgrades and downgrades alike, with no old-tier-vs-new-tier comparison needed at
the call site. Each run re-derives "is this org over capacity right now" from scratch and
reconciles state to match, in both directions:

- **Over capacity** → mark the excess cells for removal (if not already marked)
- **At or under capacity** → clear any pending removal marks

That second direction matters: an org that upgrades back above its cell count *before* a pending
removal's grace period expires keeps its cells — the mark is cleared, not merely paused.

A cron sweep (`gatewayHealthCron.ts`, roughly every 30 minutes) runs the same reconciliation
defensively across every org holding at least one active managed cell, as a safety net for any
org whose reconciliation was missed, delayed, or partially applied by a billing-webhook path.

### Which cells get marked

When an org is over capacity, victims are chosen **newest-created first**, and the org's home
cell (`orgs.gatewayId`) is excluded from selection until no other cell remains — "home-cell-last."
The reasoning: an older cell is more likely to be integrated into a customer's actual tooling,
while a newer regional cell is the least depended-on addition, and losing the org's primary
gateway is the most disruptive possible outcome. The one exception is a full downgrade to zero
entitled cells, where every cell — including the home cell — becomes a victim, since the org isn't
entitled to a managed cell at all anymore.

### Grace periods

The grace period before a marked cell is actually revoked depends on *why* it was marked:

| Trigger | Grace period | Reasoning |
|---|---|---|
| Voluntary plan downgrade (`plan_downgrade:*`) | 14 days (`CELL_DEPROVISION_GRACE_DAYS_VOLUNTARY`) | The org chose this; it gets a generous window |
| Subscription canceled / payment-failed dunning | 3 days (`CELL_DEPROVISION_GRACE_DAYS_DUNNING`) | Involuntary loss of paid status reflects nothing about the org's actual infrastructure needs, so there's less reason to hold a cell open |
| Cron sweep's own defensive pass | 14 days (falls back to the voluntary window) | Conservative choice for a mark the org never received an explicit billing-event notice for |

Both windows are configurable via environment variables
(`CELL_DEPROVISION_GRACE_DAYS_VOLUNTARY`, `CELL_DEPROVISION_GRACE_DAYS_DUNNING`), and both default
to the values above.

A grace period is selected **once**, the moment a cell is first marked, and is never re-derived or
extended by a later reconciliation run — even one running under a different trigger. The dashboard
shows the countdown on the affected gateway row: **"Scheduled for removal — N days left."**

### What blocks a deprovision

A cell already marked for removal has its deadline cleared — not extended, cleared — the moment
reconciliation finds the org back at or under capacity. There is no other user-facing way to
cancel a pending deprovision; re-upgrading the plan is the mechanism.

### Failure and rollback behavior

- **Idempotent by design.** Reconciliation is safe to call repeatedly — the cron sweep does, every
  cycle — because it always re-derives current state rather than trusting a diff from last time.
- **Notification is decoupled from marking.** A cell being marked and a cell being notified are
  tracked independently (`deprovision_notified_at` is a separate gate from `deprovision_at`). If a
  run marks a cell but crashes before notifying, the next run retries the notification without
  re-marking or double-notifying.
- **Missing org data no-ops rather than throws.** If `scheduleCellReconciliation` is called for an
  org that no longer exists (a legitimate race with concurrent org deletion), it logs and returns
  cleanly rather than turning a billing webhook into a failed request.
- **Concurrent sweep safety.** The actual revocation step re-checks `revoked_at IS NULL AND
  deprovision_at <= now()` inside the same update that performs the revoke. If two sweep passes
  race on the same cell, the second one's update simply matches zero rows and skips further
  processing — no distributed lock is needed.
- **Primary-pointer repoint on revoke.** If the revoked cell was the org's primary gateway pointer
  (`orgs.gatewayId`), it's re-pointed to the oldest surviving active cell, or `NULL` if none
  remain — the same repoint logic a manual, operator-initiated revoke uses, so a swept revoke and
  a manual one leave the org in an identical state.

## Related

- [Organizations, Teams & Billing](/guide/organizations) — org creation and auto-provisioning
- [Entity Hierarchy](/external/hierarchy) — how orgs, teams, and workspaces relate to gateways
