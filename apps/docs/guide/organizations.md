# Organizations, Teams & Billing <Badge type="warning" text="Cloud / Team" />

Everything a solo signup gets is scoped to one **personal** org with exactly one team and one
workspace. This page covers the layer above that: real **orgs** that hold multiple teams and
workspaces, with their own trial and billing.

See [Entity Hierarchy](/external/hierarchy) for how orgs, teams, and workspaces relate to each
other in the data model.

---

## Creating an org

Org creation is separate from the individual signup flow — it needs an org name, and it lands
on a paid tier with a 30-day trial rather than the free tier's own trial. Creating a real org
also auto-provisions a dedicated managed gateway cell for it, so it requires proving you own the
org's domain first, via a DNS TXT record — the same mechanism Slack and Google Workspace use.
There's no anonymous signup path for this: sign up personally first (`intutic init` / the
dashboard's own signup page), then create the org from that authenticated session, either in the
dashboard (the workspace switcher's "Create Organization") or via the CLI:

```bash
intutic org create
# or non-interactively:
intutic org create --org-name "Acme Corp" --domain acme.com
```

This starts domain verification, prints the TXT record to publish (`_intutic-verify.<domain>`),
polls DNS on your confirmation, then creates the org — one default team, one default workspace —
and switches your CLI session into it once verified. Equivalent API calls:
`POST /api/v1/domain-verification/start`, `GET /api/v1/domain-verification/:id`, and
`POST /api/v1/orgs`.

An individual who already has a personal workspace can also create a real org later without
losing their personal one — the two are entirely separate; a new membership row under the new
org links to the same underlying user identity.

## Managing teams

A personal org is capped at exactly one team — that cap is structural, not a plan limit, and no
upgrade changes it. A real org's team limit instead comes from its plan tier:

| Plan | Max teams per org |
|---|---|
| Free / Pro / Team / Biz Scale | 1 |
| Biz Org | 5 |
| Enterprise (Sub) | 10 |
| Enterprise (Advanced) | 25 |
| Enterprise (Licensed) | Unlimited |

```bash
intutic team list --org <org_id>
intutic team create --org <org_id> --name "Platform Team"
intutic team workspaces <team_id>
intutic team create-workspace <team_id> --name "Platform Staging"
```

Creating a team or a workspace requires `OWNER`/`ADMIN` on **any** active workspace under the
org — there's no separate org-admin role. A new workspace inherits the org's current plan tier
and spend caps at creation time, and you're automatically added as its `OWNER` (a login session
is workspace-scoped, so being an org admin elsewhere grants no automatic access to a workspace
you didn't already have).

## Billing

An org's plan, trial, and Stripe subscription are tracked at the org level, separate from — but
write-through to — every workspace under it: when an org's plan changes, every one of its
workspaces gets the same `planTier`/`dailySpendCapUsd`/`monthlyBudgetUsd` applied.

```
POST /api/v1/orgs/:orgId/billing/checkout
{ "tier": "biz_org", "billing_period": "monthly" }
```

Requires the same OWNER/ADMIN-on-any-workspace authorization as team management. Returns a
Stripe Checkout session URL. **No dashboard button calls this today** — it's reachable via the
API only; don't expect a visible "Upgrade org" flow in Settings yet. Per-workspace upgrade
(`POST /api/v1/billing/checkout`, documented in [Budgets & FinOps](/guide/budgets)) is unrelated
and still the only in-dashboard upgrade path.

## Related

- [Entity Hierarchy](/external/hierarchy) — the full org → team → workspace data model
- [Settings & Configuration](/guide/settings) — workspace-level settings, provider keys
- [Budgets & FinOps](/guide/budgets) — workspace-level spend caps and per-workspace billing
- [CLI Reference](/reference/cli) — `intutic org`, `intutic team`
