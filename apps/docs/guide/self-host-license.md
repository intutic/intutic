---
title: Your Self-host license
description: How a Self-host deployment uses its license file, how to install and renew it, and what happens as a term ends.
---

# Your Self-host license <Badge type="danger" text="Self-host" />

A Self-host deployment runs on a license file Intutic signs for your order. The
deployment checks the signature itself, with keys built into its images, at
start-up and every hour after. It never calls out to Intutic to do so.

The license names your organisation and the term it covers, and grants every
feature with unlimited seats and requests.

## Installing it

- **Docker Compose:** the installer copies the file you pass with `--license` to
  `/opt/intutic/license.json`, which the control plane reads.
- **Kubernetes:** the Secret named by `license.secretName`, under the key
  `license.json`.
- **From the dashboard:** an owner can upload a license in
  **Settings › Billing › Self-host license**. The upload is checked before it is
  saved. A deployment that reads its license from a file (both of the above)
  refuses uploads; replace the file instead.

Settings › Billing shows the license in force: its status, who it is for, the
seats, when the term ends and when changes would pause.

## Renewing

Intutic invoices each term in advance. Once the renewal invoice is paid, you
receive a new license file:

- **Compose:** copy it over `/opt/intutic/license.json`, then
  `docker compose restart control-plane` in `/opt/intutic`.
- **Kubernetes:** replace the Secret (`kubectl -n intutic create secret generic
  intutic-license --from-file=license.json --dry-run=client -o yaml | kubectl apply -f -`),
  then `kubectl -n intutic rollout restart deployment/intutic-control-plane`.

The control plane also re-reads the file every hour, so the restart only makes
the change take effect immediately.

## When a term ends

| When | What happens |
|---|---|
| 60 days or fewer before the end | A banner tells everyone when the term ends |
| The term ends | 30 days' grace: everything keeps working, and the banner says when changes will pause |
| Grace ends | Changes made in the dashboard are paused (`402 LICENSE_EXPIRED`): invitations, policy edits, new keys. Everything an agent or the proxy does keeps working: API-key traffic, the proxy, its policies, traces, and signing in to read |

An expired license never takes your agents offline or lets them run ungoverned.
Upload or install a renewed license and changes resume at once.

## Without a valid license

A deployment with no license, a license that fails its signature check, or one
whose term has not started yet answers only sign-in, health checks and the
license itself. Everything else returns `402 LICENSE_REQUIRED`, and the
dashboard shows the license upload instead of its pages.

## Seats

A Self-host license has unlimited seats. A license issued with a seat limit
counts the distinct people active across the whole deployment.
