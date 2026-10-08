---
title: Plans & pricing
description: The plans Intutic sells, what each costs and includes, how usage is billed, the trials, and what the plan badges in these docs mean.
---

<script setup>
import plans from '../data/plans.json'

const usd = (n) => '$' + n.toLocaleString('en-US')
const count = (n) => (n === -1 ? 'Unlimited' : n.toLocaleString('en-US'))
const price = (p) =>
  p.billing === 'usage' ? `$${p.ratePer1kUsd.toFixed(2)} per 1,000 requests`
  : p.billing === 'license' ? `${usd(p.priceAnnualUsd)} / year`
  : `${usd(p.priceMonthlyUsd)} / month`
const annual = (p) =>
  p.billing === 'subscription' ? `${usd(p.priceAnnualUsd)} / year`
  : p.billing === 'license' ? 'Annual license'
  : 'Monthly only'
</script>

# Plans & pricing

Intutic's open core (the proxy, CLI and sync daemon) is free and runs on your
own machines. Connecting it to a control plane, on Intutic Cloud or your own
infrastructure, is where the plans below apply. Every figure on this page is
generated from the product's own plan catalog, so it matches what the product
enforces.

## The plans

<table>
  <thead>
    <tr><th></th><th v-for="p in plans" :key="p.id">{{ p.name }}</th></tr>
  </thead>
  <tbody>
    <tr><td>Price</td><td v-for="p in plans" :key="p.id">{{ price(p) }}</td></tr>
    <tr><td>Billed yearly</td><td v-for="p in plans" :key="p.id">{{ annual(p) }}</td></tr>
    <tr><td>Seats</td><td v-for="p in plans" :key="p.id">{{ count(p.seats) }}</td></tr>
    <tr><td>Included requests / month</td><td v-for="p in plans" :key="p.id">{{ p.includedRequestsPerMonth ? p.includedRequestsPerMonth.toLocaleString('en-US') : (p.billing === 'license' ? 'Unlimited' : 'None') }}</td></tr>
    <tr><td>Bought through</td><td v-for="p in plans" :key="p.id">{{ p.purchase === 'checkout' ? 'Settings › Upgrade' : 'Sales' }}</td></tr>
  </tbody>
</table>

<div v-for="p in plans" :key="p.id">
  <h3 :id="p.id">{{ p.name }}</h3>
  <p><em>{{ p.tagline }}.</em> {{ price(p) }}<span v-if="p.billing === 'subscription'">, or {{ annual(p) }}</span>.</p>
  <ul><li v-for="f in p.features" :key="f">{{ f }}</li></ul>
</div>

## How usage is billed

The billing unit is the **Governed Request**: one governed LLM call.

- **Self-serve** has no fee. Every Governed Request bills at $1.50 per 1,000,
  billed monthly in arrears, with a $5,000 monthly minimum: if a month's usage
  costs less, the difference is added to that month's invoice.
- **Biz Org and Enterprise** charge a flat monthly or yearly fee (yearly is 20%
  off). The fee prepays Governed Requests at $1.50 per 1,000, so Biz Org
  includes 5,000,000 a month and Enterprise 10,333,333. Requests past that are
  overage at $1.50 per 1,000, billed monthly, also on a yearly plan. An
  organization's plan pools the allowance across all its workspaces.
- **Self-host** is an annual license for a deployment that runs on your own
  infrastructure. It is invoiced yearly in advance and nothing is metered:
  seats and requests are unlimited.
- On every paid plan you bring your own LLM provider key; the plan price does
  not cover provider charges. Each plan also sets a default daily spend cap on
  LLM traffic, which an administrator can change in Settings.

Trace retention is 3 years on every plan.

## Trials

- **Free trial**: 14 days from sign-up. It includes Policy Guardrails,
  single sign-on, SCIM, Custom Filters, the SOP Optimizer and data residency,
  with one seat and a $5 daily spend cap.
- **Organization trial**: an organization signs up on Biz Org for 30 days.
- **Enterprise trial**: 14 days, started from **Settings › Billing** by an
  Owner. It adds the Evaluator Sandbox and SOP write-back to the Free trial's
  features, for up to 25 seats.

A trial that ends without a purchase moves the workspace to the free plan.

## Plan badges in these docs {#badges}

A badge next to a page or section title says which plan it needs:

| Badge | Needs |
|---|---|
| <Badge type="tip" text="Open-Core" /> | Nothing: runs on your machine with no account |
| <Badge type="tip" text="Cloud" /> | A connected workspace on any plan, free included |
| <Badge type="warning" text="Self-serve+" /> | Any paid plan |
| <Badge type="warning" text="Biz Org+" /> | Biz Org, Enterprise or Self-host |
| <Badge type="danger" text="Enterprise" /> | Enterprise or Self-host |
| <Badge type="danger" text="Self-host" /> | A Self-host license: runs on your own infrastructure ([Self-host](./self-host)) |

The trials include most paid features; [Trials](#trials) lists them.
